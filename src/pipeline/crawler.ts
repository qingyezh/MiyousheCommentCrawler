import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { gameListUrl, postFullUrl, repliesUrl, subRepliesUrl, userFullInfoUrl } from '../api/urls.js';
import {
  extractReplyPage,
  mapChildComment,
  mapGameList,
  mapPostMeta,
  mapRootComment,
  mapUserRecord,
} from '../api/mappers.js';
import { CheckpointStore } from '../core/checkpoint.js';
import { BatchWriter, mergeBatchesToFinal } from '../core/fsBatch.js';
import { HttpClient } from '../core/http.js';
import { TaskPool } from '../core/pools.js';
import { RateLimiter, sleep } from '../core/rate.js';
import { parseMiyousheUrl, UidSet } from '../core/util.js';
import { writeReport } from './report.js';
import { writeChineseCsvBundle } from './exportCsv.js';
import { runAnalysisById } from './analysis.js';
import { logProgress } from '../logger/index.js';
import { AdaptiveUserLimiter } from '../core/adaptiveUserLimiter.js';
import type {
  AppConfig,
  Checkpoint,
  CommentRecord,
  CrawlOptions,
  GameDictItem,
  PostMeta,
  UserRecord,
} from '../types.js';

export interface CrawlContext {
  config: AppConfig;
  logger: Logger;
  projectRoot: string;
  options: CrawlOptions;
}

export interface CrawlController {
  pause(): void;
  resume(): void;
  abort(reason: string): void;
  status(): {
    phase: string;
    commentsWritten: number;
    usersDone: number;
    usersFailed: number;
    rootLastId: string | number;
  };
}

export class SimpleCrawlController implements CrawlController {
  private paused = false;
  private aborted = false;
  private phase = 'idle';
  private commentPool: TaskPool<unknown, unknown> | null = null;
  private userPool: TaskPool<unknown, unknown> | null = null;
  private metrics = { commentsWritten: 0, usersDone: 0, usersFailed: 0, rootLastId: 0 as string | number };

  attachPools(comment: TaskPool<unknown, unknown> | null, user: TaskPool<unknown, unknown> | null) {
    this.commentPool = comment;
    this.userPool = user;
  }

  setPhase(phase: string) {
    this.phase = phase;
  }

  setMetrics(m: Partial<typeof this.metrics>) {
    Object.assign(this.metrics, m);
  }

  pause(): void {
    this.paused = true;
    this.commentPool?.pause();
    this.userPool?.pause();
  }

  resume(): void {
    this.paused = false;
    this.commentPool?.resume();
    this.userPool?.resume();
  }

  abort(reason: string): void {
    this.aborted = true;
    this.commentPool?.abort();
    this.userPool?.abort();
    void reason;
  }

  get isAborted() {
    return this.aborted;
  }

  get isPaused() {
    return this.paused;
  }

  async waitIfPaused(signal?: { aborted: boolean }): Promise<void> {
    while (this.paused && !this.aborted && !signal?.aborted) {
      await sleep(200);
    }
  }

  status() {
    return {
      phase: this.phase,
      commentsWritten: this.metrics.commentsWritten,
      usersDone: this.metrics.usersDone,
      usersFailed: this.metrics.usersFailed,
      rootLastId: this.metrics.rootLastId,
    };
  }
}

function newRunId(): string {
  const t = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14);
  return `${t}-${Math.random().toString(36).slice(2, 6)}`;
}

async function loadJsonlBatch<T>(dir: string, kind: string, onItem: (x: T) => void): Promise<void> {
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${kind}-batch-`) && f.endsWith('.jsonl'))
    .sort();
  const readline = await import('node:readline');
  for (const f of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dir, f), { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        onItem(JSON.parse(line) as T);
      } catch {
        /* skip bad line */
      }
    }
    rl.close();
  }
}

export async function runCrawl(ctx: CrawlContext, controller?: SimpleCrawlController): Promise<void> {
  const { config, logger, projectRoot, options } = ctx;
  const dataDir = path.isAbsolute(config.io.dataDir)
    ? config.io.dataDir
    : path.join(projectRoot, config.io.dataDir);
  const checkpointFile = path.join(dataDir, 'checkpoint.json');
  const store = new CheckpointStore(checkpointFile);

  const { postId: parsedPostId, gids } = parseMiyousheUrl(options.url);
  const usersEnabled = options.users || config.users.enabled;

  // 续爬：优先复用 checkpoint 中的 runId，避免批次目录对不上
  let runId = options.runId ?? newRunId();
  let resumeLoaded: Checkpoint | null = null;
  const existing = await store.load();
  // 显式 resume，或 crawl 时发现同帖未完成 checkpoint → 自动续爬（防止误操作从 0 重来）
  const forceRestart = process.argv.includes('--force-restart');
  const shouldResume =
    Boolean(options.resumeCheckpoint) ||
    (!forceRestart &&
      existing &&
      existing.phase !== 'done' &&
      existing.postId === parsedPostId &&
      (existing.comments.rootLastId !== '0' || existing.comments.written > 0));
  if (shouldResume && existing) {
    resumeLoaded = existing;
    if (resumeLoaded.runId) {
      runId = options.runId ?? resumeLoaded.runId;
    }
    logger.warn({
      runId,
      postId: resumeLoaded.postId,
      phase: resumeLoaded.phase,
      rootLastId: resumeLoaded.comments.rootLastId,
      written: resumeLoaded.comments.written,
      msg: 'auto_resume_from_checkpoint',
    });
  }

  const runDir = path.join(dataDir, 'runs', runId);
  const batchDir = path.join(runDir, 'batches');
  const finalDir = path.join(runDir, 'final');
  const commentsBatchDir = path.join(batchDir, 'comments');
  const usersBatchDir = path.join(batchDir, 'users');
  await fsp.mkdir(commentsBatchDir, { recursive: true });
  await fsp.mkdir(usersBatchDir, { recursive: true });
  await fsp.mkdir(finalDir, { recursive: true });

  const postId = resumeLoaded?.postId || parsedPostId;

  let checkpoint: Checkpoint = resumeLoaded ?? {
    runId,
    url: options.url,
    postId,
    gids,
    phase: 'init',
    comments: {
      rootLastId: '0',
      rootIsLast: false,
      rootPages: 0,
      written: 0,
      childDoneFloors: [],
    },
    users: {
      enabled: usersEnabled,
      enqueued: 0,
      done: 0,
      failed: 0,
    },
    updatedAt: new Date().toISOString(),
  };

  if (resumeLoaded) {
    logger.info({ checkpoint: { phase: resumeLoaded.phase, comments: resumeLoaded.comments, users: resumeLoaded.users }, msg: 'checkpoint_loaded' });
  }

  checkpoint.runId = runId;
  checkpoint.url = options.url || checkpoint.url;
  checkpoint.postId = postId;
  if (gids != null) checkpoint.gids = gids;
  checkpoint.users.enabled = usersEnabled;

  const commentLimiter = new RateLimiter(config.intervals.commentMs);
  // 用户侧：实际间隔与并发由 AdaptiveUserLimiter 令牌桶控制；
  // HttpClient 再用串行 RateLimiter 会把并发打回 1，故用 0ms 直通 limiter
  const userLimiter = new RateLimiter(0);
  // 用户阶段：1–4 占比自适应；限流降 1；再限流暂停；无新限流恢复双并发（默认不升 3–4）
  const w = config.users.concurrency?.weights ?? { 1: 0.2, 2: 0.4, 3: 0.25, 4: 0.15 };
  const weightsNum: Record<number, number> = {};
  for (const [k, v] of Object.entries(w)) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) weightsNum[Number(k)] = n;
  }
  const adaptiveUser = new AdaptiveUserLimiter({
    baseIntervalMs: config.intervals.userMs,
    concurrency: {
      weights: weightsNum,
      allowHighAfterRecover: config.users.concurrency?.allowHighAfterRecover ?? false,
      recoverStepMs: config.users.concurrency?.recoverStepMs ?? 180_000,
      pauseOnDoubleFailMs: config.users.concurrency?.pauseOnDoubleFailMs ?? 180_000,
    },
    logger,
  });
  const http = new HttpClient({
    cookie: config.cookie,
    userAgent: config.http.userAgent,
    timeoutMs: config.http.timeoutMs,
    retry: config.http.retry,
    backoffBaseMs: config.http.backoffBaseMs,
    rateLimitMaxRetries: config.http.rateLimitMaxRetries,
    rateLimitBaseMs: config.http.rateLimitBaseMs,
    commentLimiter,
    userLimiter,
    adaptiveUser,
    logger,
  });

  const commentWriter = new BatchWriter<CommentRecord>({
    dir: commentsBatchDir,
    batchSize: config.io.batchSize,
    flushIntervalMs: config.io.flushIntervalMs,
    logger,
    kind: 'comments',
    serialize: (c) => JSON.stringify(c),
  });
  const userWriter = new BatchWriter<UserRecord>({
    dir: usersBatchDir,
    batchSize: config.io.batchSize,
    flushIntervalMs: config.io.flushIntervalMs,
    logger,
    kind: 'users',
    serialize: (u) => JSON.stringify(u),
  });
  await commentWriter.startTimer();
  await userWriter.startTimer();

  const uidSet = new UidSet();
  const commentStats = new Map<string, { total: number; root: number; child: number }>();
  const userQueue: string[] = [];
  const userResults = new Map<string, UserRecord>();
  let games: GameDictItem[] = [];

  // ---- 用户阶段：评论期并行 + 令牌桶自适应 ----
  const userInbox: string[] = [];
  const userEnqueued = new Set<string>();
  const userPlan = new Set<string>(); // 计划采集的全部 uid（含已完成）
  let userWorkersStarted = false;
  let commentsPhaseDone = false;
  let userActive = 0;
  let userFailedCount = 0;
  let userLimitTarget = 0;

  const processOneUser = async (uid: string): Promise<void> => {
    if (controller?.isAborted || userResults.has(uid)) return;
    await controller?.waitIfPaused();
    const release = await adaptiveUser.acquire();
    userActive++;
    try {
      const res = await http.getJson(userFullInfoUrl(uid), userLimiter, {
        pool: 'user',
        kind: 'user_full',
        uid,
        inFlight: adaptiveUser.inFlightLimit,
      });
      const data = (res as { data?: unknown }).data;
      const cs = commentStats.get(uid) ?? { total: 0, root: 0, child: 0 };
      const rec = mapUserRecord(data, {
        uid,
        comment_count: cs.total,
        has_root: cs.root > 0,
        has_child: cs.child > 0,
        root_comment_count: cs.root,
        child_comment_count: cs.child,
        levelMin: config.users.levelMin,
        gameName: (id) => games.find((g) => g.id === id)?.name ?? String(id),
      });
      userWriter.write(rec);
      userResults.set(uid, rec);
      checkpoint.users.done++;
      // 分母=计划采集总数（已完成 + 待采集），随评论发现不断增长
      const denom = Math.max(userPlan.size, userResults.size, 1);
      logProgress(logger, '用户', '爬取', userResults.size, denom, { 用户数量: uidSet.size });
      logProgress(logger, '用户', '写入', userResults.size, denom, { 用户数量: uidSet.size });
      if (checkpoint.users.done % 20 === 0) {
        await userWriter.flush();
        await saveCp('users');
      }
    } catch (e) {
      userFailedCount++;
      logger.warn({
        uid,
        err: e instanceof Error ? e.message : String(e),
        msg: 'user_fetch_failed',
      });
    } finally {
      userActive--;
      release();
      syncStatus();
    }
  };

  const startUserWorkers = () => {
    if (userWorkersStarted || !usersEnabled) return;
    userWorkersStarted = true;
    const n = Math.max(4, config.pools.users.concurrency);
    logger.info({ workers: n, msg: 'user_workers_started_early' });
    for (let i = 0; i < n; i++) {
      void (async () => {
        while (true) {
          if (controller?.isAborted) return;
          const uid = userInbox.shift();
          if (!uid) {
            if (commentsPhaseDone && userActive === 0) return;
            await sleep(30);
            continue;
          }
          await processOneUser(uid);
        }
      })();
    }
  };

  const enqueueUser = (uid: string) => {
    if (!usersEnabled || !uid) return;
    userPlan.add(uid);
    if (userResults.has(uid) || userEnqueued.has(uid)) return;
    const maxU = options.maxUsers ?? config.users.maxUsers;
    if (maxU > 0 && userEnqueued.size >= maxU) return;
    userEnqueued.add(uid);
    userInbox.push(uid);
    userLimitTarget = userPlan.size;
  };

  // 续爬：先装载已有 users 批次，避免把已完成用户重新入队（否则进度从 0 重计）
  if (usersEnabled) {
    await loadJsonlBatch<UserRecord>(usersBatchDir, 'users', (u) => {
      if (u?.uid) {
        userResults.set(u.uid, u);
        userPlan.add(u.uid);
      }
    });
    if (userResults.size > 0) {
      logger.info({
        alreadyFetchedUsers: userResults.size,
        msg: 'user_batches_preloaded',
      });
    }
  }

  // 恢复去重集合：从已有 comments 批次
  if (checkpoint.comments.written > 0 || options.resumeCheckpoint) {
    logger.info({ msg: 'rebuilding_uid_set_from_batches' });
    await loadJsonlBatch<CommentRecord>(commentsBatchDir, 'comments', (c) => {
      uidSet.add(c.uid);
      enqueueUser(c.uid);
      const s = commentStats.get(c.uid) ?? { total: 0, root: 0, child: 0 };
      s.total++;
      if (c.comment_type === 'root') s.root++;
      else s.child++;
      commentStats.set(c.uid, s);
    });
    logger.info({
      size: uidSet.size,
      enqueued: userEnqueued.size,
      alreadyFetchedUsers: userResults.size,
      pendingUsers: Math.max(0, userEnqueued.size - userResults.size),
      msg: 'uid_set_rebuilt',
    });
    if (usersEnabled && userEnqueued.size > 0) {
      startUserWorkers();
    }
  }

  const saveCp = async (phase: Checkpoint['phase']) => {
    checkpoint.phase = phase;
    await store.save(checkpoint);
  };

  const syncStatus = () => {
    controller?.setPhase(checkpoint.phase);
    controller?.setMetrics({
      commentsWritten: commentWriter.writtenCount,
      usersDone: checkpoint.users.done,
      usersFailed: checkpoint.users.failed,
      rootLastId: checkpoint.comments.rootLastId,
    });
  };

  try {
    if (!config.cookie.trim()) {
      throw new Error('未配置 cookie：请填写 app/config/config.yaml 或设置 MIYOUSHE_COOKIE');
    }

    // ---- 帖子 ----
    await saveCp('post');
    logger.info({ postId, gids, url: options.url, msg: 'fetch_post_full' });
    const postRes = await http.getJson(postFullUrl(checkpoint.gids, postId), commentLimiter, {
      pool: 'comment',
      kind: 'post_full',
      postId,
    });
    const postData = (postRes as { data?: unknown }).data;
    const post: PostMeta = mapPostMeta(postData);
    if (!post.post_id) throw new Error('getPostFull 未返回 post_id，可能 cookie 失效或帖子不可见');
    if (post.game_id) checkpoint.gids = post.game_id;
    await fsp.writeFile(path.join(finalDir, 'post_meta.json'), JSON.stringify(post, null, 2), 'utf8');
    logger.info(
      {
        postId: post.post_id,
        subject: post.subject,
        maxFloor: post.max_floor,
        msg: 'post_meta_saved',
      },
    );

    // ---- 游戏字典 ----
    try {
      const gl = await http.getJson(gameListUrl(), userLimiter, { pool: 'user', kind: 'game_list' });
      games = mapGameList((gl as { data?: unknown }).data);
      await fsp.writeFile(path.join(finalDir, 'games.json'), JSON.stringify(games, null, 2), 'utf8');
      logger.info({ count: games.length, msg: 'game_dict_loaded' });
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : String(e), msg: 'game_dict_failed_continue' });
    }

    // ---- 评论池 ----
    await saveCp('comments');
    syncStatus();
    const commentPool = new TaskPool<{ floorId: number; parentReplyId: string }, void>({
      concurrency: config.pools.comments.concurrency,
      logger,
      name: 'comments',
    });
    controller?.attachPools(commentPool as TaskPool<unknown, unknown>, null);

    // 串行拉取 root 分页（保证 last_id 语义正确），页内 child 可并行
    const maxPages = options.maxRootPages ?? Number.MAX_SAFE_INTEGER;
    const childTasks: Array<{ floorId: number; parentReplyId: string }> = [];
    let lastId: string = String(checkpoint.comments.rootLastId ?? '0');
    let pages = checkpoint.comments.rootPages;
    let isLast = checkpoint.comments.rootIsLast;
    const doneFloors = new Set(checkpoint.comments.childDoneFloors);
    // 续爬时进度从已写入量起算，避免显示成从 0 重爬
    let rootFetched = resumeLoaded ? Math.max(0, checkpoint.comments.written) : 0;
    let commentTotalHint = 0;

    while (!isLast && pages < maxPages) {
      if (controller?.isAborted) break;
      await controller?.waitIfPaused();
      const url = repliesUrl({
        postId,
        size: config.replies.pageSize,
        orderType: config.replies.orderType,
        lastId,
      });
      const res = await http.getJson(url, commentLimiter, {
        pool: 'comment',
        kind: 'root_page',
        postId,
        lastId,
        pages,
      });
      const page = extractReplyPage((res as { data?: unknown }).data);
      commentTotalHint = Math.max(commentTotalHint, page.totalReplyNum || 0);
      logger.info({
        page: pages,
        lastIdIn: lastId,
        lastIdOut: page.lastId,
        n: page.list.length,
        isLast: page.isLast,
        total: page.totalReplyNum,
        msg: 'root_page_fetched',
      });

      for (const item of page.list) {
        const rec = mapRootComment(item);
        if (!rec.uid) continue;
        commentWriter.write(rec);
        checkpoint.comments.written++;
        rootFetched++;
        uidSet.add(rec.uid);
        enqueueUser(rec.uid);
        startUserWorkers();
        const s = commentStats.get(rec.uid) ?? { total: 0, root: 0, child: 0 };
        s.total++;
        s.root++;
        commentStats.set(rec.uid, s);

        if (
          config.replies.includeChild &&
          (options.child ?? true) &&
          rec.floor_id != null &&
          rec.sub_reply_count > 0 &&
          !doneFloors.has(rec.floor_id)
        ) {
          childTasks.push({ floorId: rec.floor_id, parentReplyId: rec.reply_id });
        }
      }

      lastId = page.lastId;
      isLast = page.isLast;
      pages++;
      checkpoint.comments.rootLastId = lastId;
      checkpoint.comments.rootIsLast = isLast;
      checkpoint.comments.rootPages = pages;
      await commentWriter.flush();
      await saveCp('comments');
      if (commentTotalHint > 0) {
        const userCnt = { 用户数量: uidSet.size };
        logProgress(logger, '评论', '爬取', rootFetched, commentTotalHint, userCnt);
        logProgress(logger, '评论', '写入', checkpoint.comments.written, commentTotalHint, userCnt);
      }

      if (page.list.length === 0) break;
    }

    logger.info({
      pages,
      childFloors: childTasks.length,
      commentsPending: commentWriter.pendingCount,
      msg: 'root_phase_done',
    });

    // child comments via pool
    if (childTasks.length && config.replies.includeChild) {
      logger.info({ tasks: childTasks.length, msg: 'child_phase_start' });
      await commentPool.run(childTasks, async (task) => {
        if (controller?.isAborted) return;
        await controller?.waitIfPaused();
        const parent = { reply_id: task.parentReplyId, floor_id: task.floorId };
        let childLast = '0';
        let childPages = 0;
        let prevCursor = '0';
        const maxChildPages = Math.ceil(config.replies.childMaxPerFloor / config.replies.childPageSize) + 2;
        while (childPages < maxChildPages) {
          const res = await http.getJson(
            subRepliesUrl({
              postId,
              floorId: task.floorId,
              size: config.replies.childPageSize,
              lastId: childLast,
            }),
            commentLimiter,
            { pool: 'comment', kind: 'child_page', postId, floorId: task.floorId, lastId: childLast },
          );
          const page = extractReplyPage((res as { data?: unknown }).data);
          logger.debug?.({
            floorId: task.floorId,
            n: page.list.length,
            lastId: page.lastId,
            isLast: page.isLast,
            msg: 'child_page',
          });
          for (const item of page.list) {
            const rec = mapChildComment(item, parent);
            if (!rec.uid) continue;
            if (!rec.nickname && item.user) {
              rec.nickname = (item.user as { nickname?: string }).nickname ?? null;
            }
            commentWriter.write(rec);
            checkpoint.comments.written++;
            uidSet.add(rec.uid);
            enqueueUser(rec.uid);
            startUserWorkers();
            const s = commentStats.get(rec.uid) ?? { total: 0, root: 0, child: 0 };
            s.total++;
            s.child++;
            commentStats.set(rec.uid, s);
          }
          // 防止游标不前进导致死循环
          if (page.lastId && page.lastId !== childLast && page.lastId !== prevCursor) {
            prevCursor = childLast;
            childLast = page.lastId;
          } else {
            break;
          }
          childPages++;
          if (page.isLast || page.list.length === 0) break;
        }
        doneFloors.add(task.floorId);
        checkpoint.comments.childDoneFloors = [...doneFloors];
        const userCnt = { 用户数量: uidSet.size };
        logProgress(logger, '评论', '爬取', commentPool.snapshot().done, childTasks.length, userCnt);
        if (commentTotalHint > 0) {
          const wTotal = Math.max(commentTotalHint, checkpoint.comments.written);
          logProgress(logger, '评论', '写入', checkpoint.comments.written, wTotal, userCnt);
        }
      });
      await commentWriter.flush();
      await saveCp('comments');
      syncStatus();
    }

    await commentWriter.close();
    logger.info({ written: commentWriter.writtenCount, msg: 'comment_writer_closed' });

    // ---- 主页（可选）：评论期已并行启动，此处等待队列清空 ----
    if (usersEnabled) {
      // 把尚未入队的 uid 补进队列（已完成的不会入队）
      for (const uid of uidSet.values()) {
        enqueueUser(uid);
      }
      userLimitTarget = userPlan.size;
      checkpoint.users.enqueued = userEnqueued.size;
      startUserWorkers();
      commentsPhaseDone = true;
      logger.info({
        inbox: userInbox.length,
        done: userResults.size,
        failed: userFailedCount,
        plan: userPlan.size,
        inFlight: adaptiveUser.inFlightLimit,
        msg: 'user_phase_drain',
      });

      // 等待队列与在途任务结束
      const deadline = Date.now() + 6 * 60 * 60 * 1000;
      while (Date.now() < deadline) {
        if (controller?.isAborted) break;
        if (userInbox.length === 0 && userActive === 0) break;
        await sleep(200);
      }
      if (userInbox.length || userActive) {
        logger.warn({
          inbox: userInbox.length,
          active: userActive,
          msg: 'user_drain_timeout',
        });
      }

      await userWriter.close();
      await saveCp('users');
      checkpoint.users.failed = userFailedCount;
      logger.info({
        done: checkpoint.users.done,
        failed: userFailedCount,
        inFlightFinal: adaptiveUser.inFlightLimit,
        msg: 'user_phase_done',
      });
    } else {
      commentsPhaseDone = true;
      logger.info({ msg: 'user_phase_skipped_disabled' });
    }

    // ---- 合并 + 报表 ----
    await saveCp('report');
    const commentFinal = path.join(finalDir, 'comments.jsonl');
    const userFinal = path.join(finalDir, 'users.jsonl');
    await mergeBatchesToFinal(commentWriter.listFiles(), commentFinal, logger, 'comments');
    if (usersEnabled) {
      await mergeBatchesToFinal(userWriter.listFiles(), userFinal, logger, 'users');
    }

    // 从 final 读回用于报表（评论量小可接受；大批量时可改为流式统计）
    const comments: CommentRecord[] = [];
    await loadJsonlBatch<CommentRecord>(commentsBatchDir, 'comments', (c) => comments.push(c));
    const users: UserRecord[] = [];
    if (usersEnabled) {
      await loadJsonlBatch<UserRecord>(usersBatchDir, 'users', (u) => users.push(u));
    }

    const reportPath = path.join(finalDir, 'report.xlsx');
    await writeReport(
      {
        post,
        comments,
        users,
        games,
        levelMin: config.users.levelMin,
        usersEnabled,
      },
      reportPath,
      logger,
    );

    // 稳定结果目录：每个帖子至少一套中文 CSV
    // app/data/results/<postId>/
    const resultsDir = path.join(dataDir, 'results', postId);
    const csvFiles = await writeChineseCsvBundle(
      {
        post,
        comments,
        users,
        games,
        levelMin: config.users.levelMin,
        usersEnabled,
      },
      resultsDir,
      logger,
    );
    // 同步一份到本次 run 的 final 目录，便于归档
    await writeChineseCsvBundle(
      {
        post,
        comments,
        users,
        games,
        levelMin: config.users.levelMin,
        usersEnabled,
      },
      finalDir,
      logger,
    );

    if (options.purgeBatches || config.io.purgeBatchesOnSuccess) {
      await commentWriter.purge();
      if (usersEnabled) await userWriter.purge();
    }

    await saveCp('done');
    logger.info(
      {
        runId,
        reportPath,
        resultsDir,
        csvFiles: csvFiles.map((f) => path.basename(f)),
        comments: comments.length,
        users: users.length,
        uniqueCommenters: new Set(comments.map((c) => c.uid).filter(Boolean)).size,
        msg: 'crawl_done',
      },
    );
    // 复制 checkpoint 到 runDir
    await fsp.copyFile(checkpointFile, path.join(runDir, 'checkpoint.json')).catch(() => undefined);

    // 自动分析（可用 --ana false 关闭）
    const wantAna = options.analysis ?? config.crawl.analysis;
    if (wantAna) {
      try {
        const ana = await runAnalysisById(resultsDir, {
          projectRoot,
          dataDir,
          logger,
          levelMin: config.users.levelMin,
        });
        logger.info({ analysisDir: ana.outDir, charts: ana.charts.length, msg: 'auto_analysis_done' });
      } catch (e) {
        logger.error({
          err: e instanceof Error ? e.message : String(e),
          msg: 'auto_analysis_failed',
        });
      }
    } else {
      logger.info({ msg: 'auto_analysis_skipped' });
    }
  } catch (e) {
    const aborted =
      controller?.isAborted ||
      (e instanceof Error && (e.message === 'pool_aborted' || e.message.includes('abort')));
    if (aborted) {
      await saveCp('paused').catch(() => undefined);
      logger.warn({
        err: e instanceof Error ? e.message : String(e),
        phase: checkpoint.phase,
        commentsWritten: checkpoint.comments.written,
        rootLastId: checkpoint.comments.rootLastId,
        msg: 'crawl_interrupted',
      });
      throw e;
    }
    await saveCp('failed').catch(() => undefined);
    logger.error({
      err: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      msg: 'crawl_failed',
    });
    throw e;
  } finally {
    await commentWriter.close().catch(() => undefined);
    await userWriter.close().catch(() => undefined);
    await http.close().catch(() => undefined);
  }
}

export async function runReportOnly(ctx: CrawlContext): Promise<void> {
  const { logger, projectRoot, config } = ctx;
  const dataDir = path.isAbsolute(config.io.dataDir)
    ? config.io.dataDir
    : path.join(projectRoot, config.io.dataDir);
  const cp = await new CheckpointStore(path.join(dataDir, 'checkpoint.json')).load();
  if (!cp) throw new Error('找不到 checkpoint，请先 crawl 或指定数据目录');
  const runDir = path.join(dataDir, 'runs', cp.runId);
  const finalDir = path.join(runDir, 'final');
  const comments: CommentRecord[] = [];
  await loadJsonlBatch<CommentRecord>(path.join(runDir, 'batches', 'comments'), 'comments', (c) =>
    comments.push(c),
  );
  // prefer final jsonl
  if (fs.existsSync(path.join(finalDir, 'comments.jsonl'))) {
    comments.length = 0;
    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(finalDir, 'comments.jsonl'), { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (line.trim()) comments.push(JSON.parse(line) as CommentRecord);
    }
    rl.close();
  }
  const users: UserRecord[] = [];
  const usersFile = path.join(finalDir, 'users.jsonl');
  if (fs.existsSync(usersFile)) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: fs.createReadStream(usersFile, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (line.trim()) users.push(JSON.parse(line) as UserRecord);
    }
    rl.close();
  }
  const post = JSON.parse(await fsp.readFile(path.join(finalDir, 'post_meta.json'), 'utf8')) as PostMeta;
  const games = fs.existsSync(path.join(finalDir, 'games.json'))
    ? (JSON.parse(await fsp.readFile(path.join(finalDir, 'games.json'), 'utf8')) as GameDictItem[])
    : [];
  await writeReport(
    {
      post,
      comments,
      users,
      games,
      levelMin: config.users.levelMin,
      usersEnabled: users.length > 0,
    },
    path.join(finalDir, 'report.xlsx'),
    logger,
  );
  const resultsDir = path.join(dataDir, 'results', post.post_id || cp.postId);
  await writeChineseCsvBundle(
    {
      post,
      comments,
      users,
      games,
      levelMin: config.users.levelMin,
      usersEnabled: users.length > 0,
    },
    resultsDir,
    logger,
  );
}

export function sleepMs(ms: number) {
  return sleep(ms);
}
