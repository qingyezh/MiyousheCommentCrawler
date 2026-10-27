export type CommentType = 'root' | 'child';

export interface AppConfig {
  cookie: string;
  http: {
    userAgent: string;
    timeoutMs: number;
    globalQps: number;
    retry: number;
    backoffBaseMs: number;
    /** 限流最大重试次数（斐波那契退避） */
    rateLimitMaxRetries: number;
    /** 斐波那契退避基数 ms，默认 1000 → 1s,1s,2s,3s,5s,8s */
    rateLimitBaseMs: number;
  };
  intervals: {
    /** 评论区请求间隔（ms） */
    commentMs: number;
    /** 主页请求间隔（ms） */
    userMs: number;
  };
  pools: {
    comments: { concurrency: number };
    users: { concurrency: number };
  };
  replies: {
    pageSize: number;
    orderType: 1 | 2;
    includeChild: boolean;
    childPageSize: number;
    childMaxPerFloor: number;
  };
  users: {
    enabled: boolean;
    levelMin: number;
    maxUsers: number;
    /** 用户阶段自适应并发 */
    concurrency: {
      /** 1–4 并发占比（归一化后使用） */
      weights: Record<string, number>;
      /** 限流恢复后允许爬升到 3–4；默认 false：3–4 权重并入 1，恢复后停在 2 */
      allowHighAfterRecover: boolean;
      /** 降到 1 后无新限流则恢复双并发的间隔 ms */
      recoverStepMs: number;
      /** 1 人档再限流 → 暂停 ms */
      pauseOnDoubleFailMs: number;
    };
  };
  io: {
    batchSize: number;
    flushIntervalMs: number;
    purgeBatchesOnSuccess: boolean;
    dataDir: string;
    logDir: string;
  };
  log: {
    level: string;
    historyDays: number;
    /** 时区偏移配置字符串，如 UTC / UTC+8 */
    timezoneOffset: string;
    /** 解析后的偏移小时数 0..23 */
    timezoneOffsetHours: number;
  };
  control: {
    port: number;
    enable: boolean;
  };
  /** 一键运行目标与开关；CLI 参数优先于该配置 */
  crawl: {
    url: string;
    users: boolean;
    includeChild: boolean;
    maxRootPages: number;
    maxUsers: number;
    purgeBatches: boolean;
    /** 爬完后是否自动分析出图；CLI --ana 可覆盖 */
    analysis: boolean;
  };
  /** 实时监控；CLI 参数优先于该配置。url 默认复用 crawl.url */
  monitor: {
    url: string;
    /** 采样间隔秒，默认 2 */
    intervalSec: number;
    /** 浏览器 UI 端口 */
    port: number;
    /** 终端 sparkline */
    sparkline: boolean;
    /** 环形窗口点数 */
    window: number;
    /** 最多保留点数 */
    maxPoints: number;
  };
}

export interface PostMeta {
  post_id: string;
  game_id: number;
  f_forum_id: number;
  uid: string;
  subject: string;
  content: string;
  cover: string | null;
  created_at: number;
  reply_time: string | null;
  max_floor: number;
  view_type: number;
  is_official: boolean;
  stats: Record<string, number>;
  raw?: unknown;
}

export interface CommentRecord {
  comment_type: CommentType;
  reply_id: string;
  post_id: string;
  floor_id: number | null;
  parent_reply_id: string | null;
  parent_floor_id: number | null;
  uid: string;
  nickname: string | null;
  content: string;
  created_at: number;
  updated_at: number | null;
  like_num: number;
  reply_num: number;
  sub_reply_count: number;
  ip_region: string | null;
  is_deleted: boolean;
  r_uid: string | null;
}

export interface UserRecord {
  uid: string;
  nickname: string | null;
  ip_region: string | null;
  introduce: string | null;
  avatar_url: string | null;
  gender: number | null;
  created_at: number | null;
  comment_count: number;
  has_root: boolean;
  has_child: boolean;
  root_comment_count: number;
  child_comment_count: number;
  level_exps: Array<{ game_id: number; level: number; exp: number }>;
  active_game_ids: number[];
  active_game_names: string[];
  achieve: Record<string, number>;
  auth_relations: unknown[];
  followed_cnt: number | null;
  followed_by: number | null;
  fetched_at: string;
}

export interface GameDictItem {
  id: number;
  name: string;
  en_name: string;
  op_name: string;
  icon: string;
}

export type Phase =
  | 'init'
  | 'post'
  | 'comments'
  | 'users'
  | 'report'
  | 'done'
  | 'failed'
  | 'paused';

export interface Checkpoint {
  runId: string;
  url: string;
  postId: string;
  gids: number | null;
  phase: Phase;
  comments: {
    rootLastId: string;
    rootIsLast: boolean;
    rootPages: number;
    written: number;
    childDoneFloors: number[];
  };
  users: {
    enabled: boolean;
    enqueued: number;
    done: number;
    failed: number;
  };
  updatedAt: string;
}

export interface CrawlOptions {
  url: string;
  users: boolean;
  maxUsers?: number;
  maxRootPages?: number;
  purgeBatches?: boolean;
  verbose?: boolean;
  logLevel?: string;
  resumeCheckpoint?: string;
  runId?: string;
  child?: boolean;
  /** 爬完是否自动分析；true/false */
  analysis?: boolean;
}

export interface StatusSnapshot {
  runId: string;
  phase: Phase;
  postId: string;
  commentsWritten: number;
  usersDone: number;
  usersFailed: number;
  rootLastId: number;
  startedAt: string;
  updatedAt: string;
}
