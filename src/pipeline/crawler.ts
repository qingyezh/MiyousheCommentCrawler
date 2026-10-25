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
  if (options.resumeCheckpoint) {
    resumeLoaded = await store.load();
    if (resumeLoaded?.runId) {
      runId = options.runId ?? resumeLoaded.runId;
      logger.info({ runId, postId: resumeLoaded.postId, phase: resumeLoaded.phase, msg: 'resume_run_id_restored' });
    }
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
  const userLimiter = new RateLimiter(config.intervals.userMs);
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
  const commentStats = new Map<
    string,
    { total: number; root: number; child: number }
  >();
  const userQueue: string[] = [];
  const userResults = new Map<string, UserRecord>();
  let games: GameDictItem[] = [];

  // 恢复去重集合：从已有 comments 批次
  if (checkpoint.comments.written > 0 || options.resumeCheckpoint) {
    logger.info({ msg: 'rebuilding_uid_set_from_batches' });
    await loadJsonlBatch<CommentRecord>(commentsBatchDir, 'comments', (c) => {
      uidSet.add(c.uid);
      const s = commentStats.get(c.uid) ?? { total: 0, root: 0, child: 0 };
      s.total++;
      if (c.comment_type === 'root') s.root++;
      else s.child++;
      commentStats.set(c.uid, s);
    });
    logger.info({ size: uidSet.size, msg: 'uid_set_rebuilt' });
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
        uidSet.add(rec.uid);
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
      });
      await commentWriter.flush();
      await saveCp('comments');
      syncStatus();
    }

    await commentWriter.close();
    logger.info({ written: commentWriter.writtenCount, msg: 'comment_writer_closed' });

    // ---- 主页（可选）----
    if (usersEnabled) {
      await saveCp('users');
      syncStatus();
      // 先回填已有 users 批次，再计算 pending，避免重复爬
      await loadJsonlBatch<UserRecord>(usersBatchDir, 'users', (u) => {
        if (u?.uid) userResults.set(u.uid, u);
      });
      const allUids = uidSet.values();
      const maxU = options.maxUsers ?? config.users.maxUsers;
      const limited = allUids.slice(0, maxU > 0 ? maxU : allUids.length);
      checkpoint.users.enqueued = limited.length;
      const pending = limited.filter((u) => !userResults.has(u));
      logger.info({
        totalUids: allUids.length,
        alreadyDone: userResults.size,
        pending: pending.length,
        msg: 'user_phase_start',
      });

      const userPool = new TaskPool<string, void>({
        concurrency: config.pools.users.concurrency,
        logger,
        name: 'users',
      });
      controller?.attachPools(null, userPool as TaskPool<unknown, unknown>);

      await userPool.run(pending, async (uid) => {
        if (controller?.isAborted) return;
        await controller?.waitIfPaused();
        const res = await http.getJson(userFullInfoUrl(uid), userLimiter, {
          pool: 'user',
          kind: 'user_full',
          uid,
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
        syncStatus();
        if (checkpoint.users.done % 20 === 0) {
          await userWriter.flush();
          await saveCp('users');
        }
      });

      await userWriter.close();
      await saveCp('users');
      logger.info({
        done: checkpoint.users.done,
        failed: checkpoint.users.failed + userPool.snapshot().failed,
        msg: 'user_phase_done',
      });
      // 合并 pool failed count
      checkpoint.users.failed = userPool.snapshot().failed;
    } else {
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
