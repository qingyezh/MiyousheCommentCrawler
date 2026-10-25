import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { CommentRecord, GameDictItem, PostMeta, UserRecord } from '../types.js';
import { computeGameStats, computeGameActivityDual } from './report.js';

// ---------- CSV ----------

function escapeCsv(v: unknown): string {
  if (v == null) return '';
  const s = String(v).replace(/\r\n/g, '\n').replace(/\n/g, ' ');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(escapeCsv).join(',')];
  for (const r of rows) lines.push(r.map(escapeCsv).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export interface ExportInput {
  post: PostMeta;
  comments: CommentRecord[];
  users: UserRecord[];
  games: GameDictItem[];
  levelMin: number;
  usersEnabled: boolean;
}

export function genderLabel(g: number | null | undefined): string {
  if (g == null) return '未知';
  if (g === 1) return '男';
  if (g === 2) return '女';
  return '未知';
}

export function computeIpStats(comments: CommentRecord[], users: UserRecord[]): Array<{ ip: string; count: number }> {
  const map = new Map<string, number>();
  // 优先用评论 IP；用户主页 IP 作为补充去重样本
  for (const c of comments) {
    const ip = (c.ip_region || '').trim();
    if (!ip) continue;
    map.set(ip, (map.get(ip) ?? 0) + 1);
  }
  if (!map.size) {
    for (const u of users) {
      const ip = (u.ip_region || '').trim();
      if (!ip) continue;
      map.set(ip, (map.get(ip) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([ip, count]) => ({ ip, count }))
    .sort((a, b) => b.count - a.count);
}

export function computeGenderStats(users: UserRecord[]): Array<{ gender: string; count: number }> {
  const map = new Map<string, number>();
  for (const u of users) {
    const g = genderLabel(u.gender);
    map.set(g, (map.get(g) ?? 0) + 1);
  }
  return [...map.entries()].map(([gender, count]) => ({ gender, count })).sort((a, b) => b.count - a.count);
}

/**
 * 每次完整爬取至少生成：
 * 1. 帖子基本信息.csv
 * 2. 评论数据.csv
 * 3. 用户数据.csv
 * 4. 总结统计.csv (+ summary.json)
 * 另附 post_meta.json / comments.jsonl / users.jsonl / games.json 便于分析复用
 */
export async function writeChineseCsvBundle(input: ExportInput, outDir: string, logger: Logger): Promise<string[]> {
  await fsp.mkdir(outDir, { recursive: true });
  const written: string[] = [];

  // 1) 帖子基本信息
  const postCsv = path.join(outDir, '帖子基本信息.csv');
  const postHeaders = ['帖子ID', '标题', '游戏ID', '作者UID', '发帖时间', '最后回复时间', '最高楼层', '内容摘要', '封面链接', '浏览数', '回复数', '点赞数', '收藏数', '分享数'];
  const postRows = [[
    input.post.post_id,
    input.post.subject,
    input.post.game_id,
    input.post.uid,
    formatTs(input.post.created_at),
    input.post.reply_time ?? '',
    input.post.max_floor,
    input.post.content.slice(0, 500),
    input.post.cover ?? '',
    input.post.stats.view_num ?? '',
    input.post.stats.reply_num ?? '',
    input.post.stats.like_num ?? '',
    input.post.stats.bookmark_num ?? '',
    input.post.stats.share_num ?? '',
  ]];
  await fsp.writeFile(postCsv, toCsv(postHeaders, postRows), 'utf8');
  written.push(postCsv);
  await fsp.writeFile(path.join(outDir, 'post_meta.json'), JSON.stringify(input.post, null, 2), 'utf8');

  // 2) 评论数据
  const commentCsv = path.join(outDir, '评论数据.csv');
  const commentHeaders = [
    '评论类型', '评论ID', '帖子ID', '楼层号', '父评论ID', '父楼层号',
    '用户UID', '用户昵称', '评论内容', '评论时间', '点赞数', '回复数',
    '子回复数', 'IP属地', '是否删除',
  ];
  const commentRows = input.comments.map((c) => [
    c.comment_type === 'root' ? 'root' : 'child',
    c.reply_id,
    c.post_id,
    c.floor_id ?? '',
    c.parent_reply_id ?? '',
    c.parent_floor_id ?? '',
    c.uid,
    c.nickname ?? '',
    c.content,
    formatTs(c.created_at),
    c.like_num,
    c.reply_num,
    c.sub_reply_count,
    c.ip_region ?? '',
    c.is_deleted ? '是' : '否',
  ]);
  await fsp.writeFile(commentCsv, toCsv(commentHeaders, commentRows), 'utf8');
  written.push(commentCsv);
  await fsp.writeFile(
    path.join(outDir, 'comments.jsonl'),
    input.comments.map((c) => JSON.stringify(c)).join('\n') + (input.comments.length ? '\n' : ''),
    'utf8',
  );

  // 3) 用户数据
  const userCsv = path.join(outDir, '用户数据.csv');
  const userHeaders = [
    '用户UID', '用户昵称', 'IP属地', '简介', '性别', '注册时间',
    '评论次数', '发过一级评论', '发过二级评论', '一级评论数', '二级评论数',
    '活跃游戏列表', '等级经验明细JSON', '获赞数', '发帖数', '粉丝数', '主页采集时间',
  ];
  const userRows = input.users.map((u) => [
    u.uid,
    u.nickname ?? '',
    u.ip_region ?? '',
    (u.introduce ?? '').slice(0, 200),
    genderLabel(u.gender),
    formatTs(u.created_at),
    u.comment_count,
    u.has_root ? '是' : '否',
    u.has_child ? '是' : '否',
    u.root_comment_count,
    u.child_comment_count,
    u.active_game_names.join('、'),
    JSON.stringify(u.level_exps),
    u.achieve.like_num ?? '',
    u.achieve.post_num ?? '',
    u.achieve.followed_cnt ?? '',
    u.fetched_at,
  ]);
  await fsp.writeFile(userCsv, toCsv(userHeaders, userRows), 'utf8');
  written.push(userCsv);
  await fsp.writeFile(
    path.join(outDir, 'users.jsonl'),
    input.users.map((u) => JSON.stringify(u)).join('\n') + (input.users.length ? '\n' : ''),
    'utf8',
  );
  await fsp.writeFile(path.join(outDir, 'games.json'), JSON.stringify(input.games, null, 2), 'utf8');

  // 4) 总结统计（游戏游玩率 + 总览 + IP/性别）
  const summaryCsv = path.join(outDir, '总结统计.csv');
  const roots = input.comments.filter((c) => c.comment_type === 'root');
  const children = input.comments.filter((c) => c.comment_type === 'child');
  const uniqueCommenters = new Set(input.comments.map((c) => c.uid).filter(Boolean));
  const { mode0: gameStats, mode1: gameStatsExL1 } = input.users.length
    ? computeGameActivityDual(input.users, input.games, input.levelMin)
    : { mode0: [] as ReturnType<typeof computeGameActivityDual>['mode0'], mode1: [] as ReturnType<typeof computeGameActivityDual>['mode1'] };
  const ipStats = computeIpStats(input.comments, input.users);
  const genderStats = computeGenderStats(input.users);

  const summaryHeaders = ['分类', '指标', '数值', '说明'];
  const summaryRows: Array<Array<unknown>> = [
    ['帖子', '帖子ID', input.post.post_id, ''],
    ['帖子', '标题', input.post.subject, ''],
    ['帖子', '游戏ID', input.post.game_id, ''],
    ['帖子', '最高楼层', input.post.max_floor, ''],
    ['帖子', '浏览数', input.post.stats.view_num ?? '', ''],
    ['帖子', '点赞数', input.post.stats.like_num ?? '', ''],
    ['评论', '评论总数', input.comments.length, '含一级+二级'],
    ['评论', '一级评论数', roots.length, 'comment_type=root'],
    ['评论', '二级评论数', children.length, 'comment_type=child'],
    ['评论', '去重评论用户数', uniqueCommenters.size, '不依赖主页爬取，始终统计'],
    ['用户', '是否采集主页', input.users.length ? '是' : '否', '默认关闭，--users 开启'],
    ['用户', '采集用户数', input.users.length, ''],
    ['用户', '活跃等级阈值', input.levelMin, 'level>=阈值 或 exp>0 视为活跃'],
    ['用户', '主页用户去重数', new Set(input.users.map((u) => u.uid)).size, ''],
  ];
  for (const g of genderStats) {
    summaryRows.push(['性别分布', g.gender, g.count, `占比 ${((g.count / Math.max(1, input.users.length)) * 100).toFixed(2)}%`]);
  }
  for (const ip of ipStats.slice(0, 20)) {
    summaryRows.push(['IP分布Top', ip.ip, ip.count, '按评论 IP 属地计数']);
  }
  if (ipStats.length > 20) {
    summaryRows.push(['IP分布', 'IP种类数', ipStats.length, '含 Top20 以外合并不计明细']);
  }
  for (const g of gameStats) {
    summaryRows.push([
      '游戏活跃度_0',
      g.game_name,
      g.play_rate == null ? '' : `${(g.play_rate * 100).toFixed(2)}%`,
      `全量样本:活跃${g.active_users}/${g.sample_users}；等级均值${g.level_avg}`,
    ]);
  }
  for (const g of gameStatsExL1) {
    summaryRows.push([
      '游戏活跃度_1',
      g.game_name,
      g.play_rate == null ? '' : `${(g.play_rate * 100).toFixed(2)}%`,
      `排除等级=1后活跃/全部用户: ${g.active_users}/${g.sample_users}；剔除该游戏等级1共${g.excluded_level1}人`,
    ]);
  }
  await fsp.writeFile(summaryCsv, toCsv(summaryHeaders, summaryRows), 'utf8');
  written.push(summaryCsv);

  const summaryJson = path.join(outDir, 'summary.json');
  await fsp.writeFile(
    summaryJson,
    JSON.stringify(
      {
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
          enabled: input.users.length > 0,
          sampled: input.users.length,
          unique: new Set(input.users.map((u) => u.uid)).size,
          levelMin: input.levelMin,
          gameActivityMode0: gameStats,
          gameActivityMode1: gameStatsExL1,
        },
        ipStats: ipStats.slice(0, 50),
        genderStats,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  written.push(summaryJson);

  logger.info({ outDir, files: written.map((f) => path.basename(f)), msg: 'csv_bundle_written' });
  return written;
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return '';
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
