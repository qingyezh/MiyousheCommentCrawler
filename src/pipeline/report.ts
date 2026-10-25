import ExcelJS from 'exceljs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { CommentRecord, GameDictItem, PostMeta, UserRecord } from '../types.js';

export interface ReportInput {
  post: PostMeta;
  comments: CommentRecord[];
  users: UserRecord[];
  games: GameDictItem[];
  levelMin: number;
  usersEnabled: boolean;
}

export interface GameStatRow {
  game_id: number;
  game_name: string;
  active_user_cnt: number;
  sample_user_cnt: number;
  play_rate: number | null;
  level_avg: number;
  level_p50: number;
  level_max: number;
  level_min: number;
  exp_avg: number;
}

export function computeGameStats(users: UserRecord[], games: GameDictItem[], levelMin: number): GameStatRow[] {
  const byId = new Map(games.map((g) => [g.id, g.name]));
  const sample = users.filter((u) => u.uid);
  const stats: GameStatRow[] = [];
  const gameIds = new Set<number>();
  for (const u of sample) for (const le of u.level_exps) gameIds.add(le.game_id);

  for (const gid of [...gameIds].sort((a, b) => a - b)) {
    const levels = sample
      .map((u) => u.level_exps.find((x) => x.game_id === gid))
      .filter((x): x is { game_id: number; level: number; exp: number } => Boolean(x));
    const active = levels.filter((x) => x.level >= levelMin || x.exp > 0);
    const levelVals = levels.map((x) => x.level).sort((a, b) => a - b);
    const expVals = levels.map((x) => x.exp);
    stats.push({
      game_id: gid,
      game_name: byId.get(gid) ?? `game_${gid}`,
      active_user_cnt: active.length,
      sample_user_cnt: sample.length,
      play_rate: sample.length ? Number((active.length / sample.length).toFixed(4)) : null,
      level_avg: avg(levelVals),
      level_p50: p50(levelVals),
      level_max: levelVals.length ? levelVals[levelVals.length - 1] : 0,
      level_min: levelVals.length ? levelVals[0] : 0,
      exp_avg: avg(expVals),
    });
  }
  // sort by play rate desc
  stats.sort((a, b) => (b.play_rate ?? 0) - (a.play_rate ?? 0));
  return stats;
}

function avg(xs: number[]): number {
  if (!xs.length) return 0;
  return Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4));
}

function p50(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4));
}

export interface GameActivityStat extends GameStatRow {
  /** _0: 全量样本；_1: 排除该游戏等级=1 的用户 */
  mode: 0 | 1;
  excluded_level1: number;
  sample_users: number;
  active_users: number;
}

/**
 * mode=0：分母=有该游戏等级记录的用户；分子=其中活跃者（level≥阈值 或 exp>0）
 * mode=1：分母=全部用户；分子=排除社区等级=1 后仍活跃者（level≠1 且 level≥阈值 或 exp>0）
 */
export function computeGameActivityDual(
  users: UserRecord[],
  games: GameDictItem[],
  levelMin: number,
): { mode0: GameActivityStat[]; mode1: GameActivityStat[] } {
  const byId = new Map(games.map((g) => [g.id, g.name]));
  const gameIds = new Set<number>();
  for (const u of users) for (const le of u.level_exps || []) gameIds.add(le.game_id);

  const mode0: GameActivityStat[] = [];
  const mode1: GameActivityStat[] = [];
  const allUserCnt = users.length;

  for (const gid of [...gameIds].sort((a, b) => a - b)) {
    const pairs = users
      .map((u) => {
        const le = (u.level_exps || []).find((x) => x.game_id === gid);
        return le ? { uid: u.uid, level: le.level, exp: le.exp } : null;
      })
      .filter((x): x is { uid: string; level: number; exp: number } => Boolean(x));

    const gameName = byId.get(gid) ?? `游戏${gid}`;
    const levelMinHit = (x: { level: number; exp: number }) => x.level >= levelMin || x.exp > 0;

    // _0：有该游戏记录的用户为分母
    const active0 = pairs.filter(levelMinHit);
    const levelVals0 = pairs.map((x) => x.level).sort((a, b) => a - b);
    const expVals0 = pairs.map((x) => x.exp);
    mode0.push({
      game_id: gid,
      game_name: gameName,
      active_user_cnt: active0.length,
      sample_user_cnt: pairs.length,
      play_rate: pairs.length ? Number((active0.length / pairs.length).toFixed(4)) : null,
      level_avg: avg(levelVals0),
      level_p50: p50(levelVals0),
      level_max: levelVals0.length ? levelVals0[levelVals0.length - 1] : 0,
      level_min: levelVals0.length ? levelVals0[0] : 0,
      exp_avg: avg(expVals0),
      mode: 0,
      excluded_level1: 0,
      sample_users: pairs.length,
      active_users: active0.length,
    });

    // _1：分母=全部用户；分子=排除等级=1 后活跃
    const nonL1 = pairs.filter((x) => x.level !== 1);
    const active1 = nonL1.filter(levelMinHit);
    const levelVals1 = nonL1.map((x) => x.level).sort((a, b) => a - b);
    const expVals1 = nonL1.map((x) => x.exp);
    mode1.push({
      game_id: gid,
      game_name: gameName,
      active_user_cnt: active1.length,
      sample_user_cnt: allUserCnt,
      play_rate: allUserCnt ? Number((active1.length / allUserCnt).toFixed(4)) : null,
      level_avg: avg(levelVals1),
      level_p50: p50(levelVals1),
      level_max: levelVals1.length ? levelVals1[levelVals1.length - 1] : 0,
      level_min: levelVals1.length ? levelVals1[0] : 0,
      exp_avg: avg(expVals1),
      mode: 1,
      excluded_level1: pairs.length - nonL1.length,
      sample_users: allUserCnt,
      active_users: active1.length,
    });
  }

  mode0.sort((a, b) => (b.play_rate ?? 0) - (a.play_rate ?? 0));
  mode1.sort((a, b) => (b.play_rate ?? 0) - (a.play_rate ?? 0));
  return { mode0, mode1 };
}

export async function writeReport(input: ReportInput, outFile: string, logger: Logger): Promise<void> {
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'miyoushe-scraper';
  wb.created = new Date();

  // 帖子信息
  const wsPost = wb.addWorksheet('帖子信息');
  wsPost.columns = [
    { header: '字段', key: 'k', width: 18 },
    { header: '值', key: 'v', width: 80 },
  ];
  const postRows: Array<{ k: string; v: string }> = [
    { k: 'post_id', v: input.post.post_id },
    { k: 'subject', v: input.post.subject },
    { k: 'game_id', v: String(input.post.game_id) },
    { k: 'uid', v: input.post.uid },
    { k: 'created_at', v: String(input.post.created_at) },
    { k: 'reply_time', v: input.post.reply_time ?? '' },
    { k: 'max_floor', v: String(input.post.max_floor) },
    { k: 'content_preview', v: input.post.content.slice(0, 500) },
    { k: 'cover', v: input.post.cover ?? '' },
    ...Object.entries(input.post.stats).map(([k, v]) => ({ k: `stat_${k}`, v: String(v) })),
  ];
  wsPost.addRows(postRows);
  wsPost.getRow(1).font = { bold: true };

  // 评论统计
  const wsCS = wb.addWorksheet('评论统计');
  const roots = input.comments.filter((c) => c.comment_type === 'root');
  const children = input.comments.filter((c) => c.comment_type === 'child');
  const uniqueCommenters = new Set(input.comments.map((c) => c.uid).filter(Boolean));
  wsCS.columns = [
    { header: '指标', key: 'k', width: 28 },
    { header: '值', key: 'v', width: 20 },
  ];
  wsCS.addRows([
    { k: 'comment_total', v: input.comments.length },
    { k: 'comment_root', v: roots.length },
    { k: 'comment_child', v: children.length },
    { k: 'unique_commenters', v: uniqueCommenters.size },
    { k: 'users_sampled', v: input.users.length },
    { k: 'users_enabled', v: String(input.usersEnabled) },
    { k: 'level_min', v: String(input.levelMin) },
  ]);
  wsCS.getRow(1).font = { bold: true };

  // 游戏统计
  const wsGame = wb.addWorksheet('游戏统计');
  const gameStats = input.usersEnabled ? computeGameStats(input.users, input.games, input.levelMin) : [];
  wsGame.columns = [
    { header: 'game_id', key: 'game_id', width: 10 },
    { header: 'game_name', key: 'game_name', width: 18 },
    { header: 'active_user_cnt', key: 'active_user_cnt', width: 16 },
    { header: 'sample_user_cnt', key: 'sample_user_cnt', width: 16 },
    { header: 'play_rate', key: 'play_rate', width: 12 },
    { header: 'level_avg', key: 'level_avg', width: 12 },
    { header: 'level_p50', key: 'level_p50', width: 12 },
    { header: 'level_max', key: 'level_max', width: 12 },
    { header: 'level_min', key: 'level_min', width: 12 },
    { header: 'exp_avg', key: 'exp_avg', width: 12 },
  ];
  if (input.usersEnabled) {
    for (const row of gameStats) wsGame.addRow(row);
  } else {
    wsGame.addRow({ game_name: '（未开启 --users，跳过主页采集）' });
  }
  wsGame.getRow(1).font = { bold: true };

  // 用户总表
  const wsUser = wb.addWorksheet('用户总表');
  wsUser.columns = [
    { header: 'uid', key: 'uid', width: 14 },
    { header: 'nickname', key: 'nickname', width: 18 },
    { header: 'ip_region', key: 'ip_region', width: 10 },
    { header: 'comment_count', key: 'comment_count', width: 14 },
    { header: 'has_root', key: 'has_root', width: 10 },
    { header: 'has_child', key: 'has_child', width: 10 },
    { header: 'root_comment_count', key: 'root_comment_count', width: 16 },
    { header: 'child_comment_count', key: 'child_comment_count', width: 16 },
    { header: 'active_game_names', key: 'active_game_names', width: 40 },
    { header: 'level_exps_json', key: 'level_exps_json', width: 60 },
    { header: 'like_num', key: 'like_num', width: 12 },
    { header: 'post_num', key: 'post_num', width: 12 },
    { header: 'followed_cnt', key: 'followed_cnt', width: 12 },
    { header: 'fetched_at', key: 'fetched_at', width: 22 },
  ];
  for (const u of input.users) {
    wsUser.addRow({
      uid: u.uid,
      nickname: u.nickname,
      ip_region: u.ip_region,
      comment_count: u.comment_count,
      has_root: u.has_root,
      has_child: u.has_child,
      root_comment_count: u.root_comment_count,
      child_comment_count: u.child_comment_count,
      active_game_names: u.active_game_names.join('、'),
      level_exps_json: JSON.stringify(u.level_exps),
      like_num: u.achieve.like_num,
      post_num: u.achieve.post_num,
      followed_cnt: u.achieve.followed_cnt,
      fetched_at: u.fetched_at,
    });
  }
  wsUser.getRow(1).font = { bold: true };

  // 评论明细（可选精简列）
  const wsC = wb.addWorksheet('评论明细');
  wsC.columns = [
    { header: 'comment_type', key: 'comment_type', width: 12 },
    { header: 'reply_id', key: 'reply_id', width: 22 },
    { header: 'floor_id', key: 'floor_id', width: 10 },
    { header: 'parent_reply_id', key: 'parent_reply_id', width: 22 },
    { header: 'parent_floor_id', key: 'parent_floor_id', width: 14 },
    { header: 'uid', key: 'uid', width: 14 },
    { header: 'nickname', key: 'nickname', width: 18 },
    { header: 'content', key: 'content', width: 60 },
    { header: 'created_at', key: 'created_at', width: 14 },
    { header: 'like_num', key: 'like_num', width: 10 },
    { header: 'reply_num', key: 'reply_num', width: 10 },
    { header: 'sub_reply_count', key: 'sub_reply_count', width: 14 },
    { header: 'ip_region', key: 'ip_region', width: 10 },
    { header: 'is_deleted', key: 'is_deleted', width: 10 },
  ];
  for (const c of input.comments) {
    wsC.addRow({
      ...c,
      content: c.content.slice(0, 500),
    });
  }
  wsC.getRow(1).font = { bold: true };

  // 活跃游戏宽表（便于透视）
  const wsW = wb.addWorksheet('用户×游戏等级');
  const gameIds = [...new Set(input.users.flatMap((u) => u.level_exps.map((x) => x.game_id)))].sort((a, b) => a - b);
  const nameMap = new Map(input.games.map((g) => [g.id, g.name]));
  wsW.columns = [
    { header: 'uid', key: 'uid', width: 14 },
    { header: 'nickname', key: 'nickname', width: 18 },
    ...gameIds.flatMap((gid) => [
      { header: `${nameMap.get(gid) ?? gid}_level`, key: `l_${gid}`, width: 12 },
      { header: `${nameMap.get(gid) ?? gid}_exp`, key: `e_${gid}`, width: 12 },
    ]),
  ];
  for (const u of input.users) {
    const row: Record<string, unknown> = { uid: u.uid, nickname: u.nickname };
    for (const gid of gameIds) {
      const le = u.level_exps.find((x) => x.game_id === gid);
      row[`l_${gid}`] = le?.level ?? '';
      row[`e_${gid}`] = le?.exp ?? '';
    }
    wsW.addRow(row);
  }
  wsW.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(outFile);
  logger.info({ outFile, sheets: wb.worksheets.map((s) => s.name), msg: 'report_xlsx_written' });

  const summary = {
    post: {
      post_id: input.post.post_id,
      subject: input.post.subject,
      game_id: input.post.game_id,
      max_floor: input.post.max_floor,
      stats: input.post.stats,
    },
    comments: {
      total: input.comments.length,
      root: roots.length,
      child: children.length,
      unique_commenters: uniqueCommenters.size,
    },
    users: {
      enabled: input.usersEnabled,
      sampled: input.users.length,
      levelMin: input.levelMin,
      gameStats,
    },
    generatedAt: new Date().toISOString(),
  };
  const summaryPath = path.join(path.dirname(outFile), 'summary.json');
  await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  logger.info({ summaryPath, msg: 'summary_json_written' });
}
