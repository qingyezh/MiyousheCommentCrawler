import type { CommentRecord, GameDictItem, PostMeta, UserRecord } from '../types.js';

interface Loose {
  [k: string]: unknown;
}

function asObj(v: unknown): Loose {
  return v && typeof v === 'object' ? (v as Loose) : {};
}

function asStr(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

function asNum(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function mapPostMeta(data: unknown): PostMeta {
  const root = asObj(data);
  const postWrap = asObj(root.post);
  const post = asObj(postWrap.post);
  const stats = asObj(postWrap.stat);
  const status = asObj(post.post_status);
  const statOut: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) {
    statOut[k] = asNum(v);
  }
  return {
    post_id: asStr(post.post_id) ?? '',
    game_id: asNum(post.game_id),
    f_forum_id: asNum(post.f_forum_id),
    uid: asStr(post.uid) ?? '',
    subject: asStr(post.subject) ?? '',
    content: asStr(post.content) ?? '',
    cover: asStr(post.cover),
    created_at: asNum(post.created_at),
    reply_time: asStr(post.reply_time),
    max_floor: asNum(post.max_floor),
    view_type: asNum(post.view_type),
    is_official: Boolean(status.is_official),
    stats: statOut,
    raw: {
      post,
      stat: stats,
      view: postWrap.view,
      topics: postWrap.topics,
    },
  };
}

export interface ReplyListItem {
  reply: Loose;
  user: Loose;
  stat: Loose;
  sub_replies: unknown[];
  sub_reply_count: number;
  is_lz: boolean;
}

export function extractReplyPage(data: unknown): {
  list: ReplyListItem[];
  lastId: string;
  isLast: boolean;
  totalReplyNum: number;
  foldReplyNum: number;
  pinReplyId: string;
} {
  const d = asObj(data);
  const list = Array.isArray(d.list) ? (d.list as unknown[]).map((x) => asObj(x) as unknown as ReplyListItem) : [];
  // last_id 可能是大整数字符串，禁止 Number()
  return {
    list,
    lastId: asStr(d.last_id) ?? '0',
    isLast: Boolean(d.is_last),
    totalReplyNum: asNum(d.total_reply_num),
    foldReplyNum: asNum(d.fold_reply_num),
    pinReplyId: asStr(d.pin_reply_id) ?? '0',
  };
}

export function mapRootComment(item: ReplyListItem): CommentRecord {
  const reply = asObj(item.reply);
  const user = asObj(item.user);
  const stat = asObj(item.stat);
  return {
    comment_type: 'root',
    reply_id: asStr(reply.reply_id) ?? '',
    post_id: asStr(reply.post_id) ?? '',
    floor_id: reply.floor_id != null ? asNum(reply.floor_id) : null,
    parent_reply_id: null,
    parent_floor_id: null,
    uid: asStr(reply.uid) ?? asStr(user.uid) ?? '',
    nickname: asStr(user.nickname),
    content: asStr(reply.content) ?? '',
    created_at: asNum(reply.created_at),
    updated_at: reply.updated_at != null ? asNum(reply.updated_at) : null,
    like_num: asNum(stat.like_num),
    reply_num: asNum(stat.reply_num),
    sub_reply_count: asNum(item.sub_reply_count),
    ip_region: asStr(user.ip_region),
    is_deleted: asNum(reply.is_deleted) === 1,
    r_uid: asStr(reply.r_uid),
  };
}

export function mapChildComment(item: ReplyListItem, parent: { reply_id: string; floor_id: number | null }): CommentRecord {
  const reply = asObj(item.reply);
  const user = asObj(item.user);
  const stat = asObj(item.stat);
  return {
    comment_type: 'child',
    reply_id: asStr(reply.reply_id) ?? '',
    post_id: asStr(reply.post_id) ?? '',
    floor_id: reply.floor_id != null ? asNum(reply.floor_id) : null,
    parent_reply_id: parent.reply_id,
    parent_floor_id: parent.floor_id,
    uid: asStr(reply.uid) ?? asStr(user.uid) ?? '',
    nickname: asStr(user.nickname),
    content: asStr(reply.content) ?? '',
    created_at: asNum(reply.created_at),
    updated_at: reply.updated_at != null ? asNum(reply.updated_at) : null,
    like_num: asNum(stat.like_num),
    reply_num: asNum(stat.reply_num),
    sub_reply_count: asNum(item.sub_reply_count),
    ip_region: asStr(user.ip_region),
    is_deleted: asNum(reply.is_deleted) === 1,
    r_uid: asStr(reply.r_uid),
  };
}

export function mapUserRecord(
  data: unknown,
  extra: {
    uid: string;
    comment_count: number;
    has_root: boolean;
    has_child: boolean;
    root_comment_count: number;
    child_comment_count: number;
    levelMin: number;
    gameName: (id: number) => string;
  },
): UserRecord {
  const root = asObj(data);
  const ui = asObj(root.user_info);
  const achieve = asObj(ui.achieve);
  const levelExpsRaw = Array.isArray(ui.level_exps) ? (ui.level_exps as unknown[]) : [];
  const level_exps = levelExpsRaw.map((x) => {
    const o = asObj(x);
    return { game_id: asNum(o.game_id), level: asNum(o.level), exp: asNum(o.exp) };
  });
  const active_game_ids = level_exps.filter((x) => x.level >= extra.levelMin || x.exp > 0).map((x) => x.game_id);
  const achieveOut: Record<string, number> = {};
  for (const [k, v] of Object.entries(achieve)) {
    achieveOut[k] = asNum(v);
  }
  const community = asObj(ui.community_info);
  const created = community.created_at;
  return {
    uid: asStr(ui.uid) ?? extra.uid,
    nickname: asStr(ui.nickname),
    ip_region: asStr(ui.ip_region),
    introduce: asStr(ui.introduce),
    avatar_url: asStr(ui.avatar_url),
    gender: ui.gender != null ? asNum(ui.gender) : null,
    created_at: created != null ? asNum(created) : null,
    comment_count: extra.comment_count,
    has_root: extra.has_root,
    has_child: extra.has_child,
    root_comment_count: extra.root_comment_count,
    child_comment_count: extra.child_comment_count,
    level_exps,
    active_game_ids,
    active_game_names: active_game_ids.map(extra.gameName),
    achieve: achieveOut,
    auth_relations: Array.isArray(root.auth_relations) ? (root.auth_relations as unknown[]) : [],
    followed_cnt: achieveOut.followed_cnt ?? null,
    followed_by: achieveOut.followed_cnt ?? null,
    fetched_at: new Date().toISOString(),
  };
}

export function mapGameList(data: unknown): GameDictItem[] {
  const d = asObj(data);
  const list = Array.isArray(d.list) ? (d.list as unknown[]) : [];
  return list.map((x) => {
    const o = asObj(x);
    return {
      id: asNum(o.id),
      name: asStr(o.name) ?? '',
      en_name: asStr(o.en_name) ?? '',
      op_name: asStr(o.op_name) ?? '',
      icon: asStr(o.icon) ?? '',
    };
  });
}
