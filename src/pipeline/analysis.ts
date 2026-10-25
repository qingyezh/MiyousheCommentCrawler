import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { Resvg } from '@resvg/resvg-js';
import type { CommentRecord, GameDictItem, PostMeta, UserRecord } from '../types.js';
import { computeGameActivityDual, type GameActivityStat } from './report.js';
import { computeGenderStats, computeIpStats, genderLabel } from './exportCsv.js';

export interface AnalysisInput {
  resultsDir: string;
  post: PostMeta;
  comments: CommentRecord[];
  users: UserRecord[];
  games: GameDictItem[];
  levelMin: number;
  /** 输出子目录，默认 analysis；快照可用 analysis-partial */
  outSubdir?: string;
}

export interface AnalysisResult {
  outDir: string;
  files: string[];
  uniqueCommenters: number;
  charts: string[];
}

/** 常见米游社 game_id → 名称（games.json 缺失时兜底，与 getGameList 对齐） */
const FALLBACK_GAME_NAMES: Record<number, string> = {
  1: '崩坏3',
  2: '原神',
  3: '崩坏学园2',
  4: '未定事件簿',
  5: '大别野',
  6: '崩坏：星穹铁道',
  8: '绝区零',
  9: '崩坏：因缘精灵',
  10: '星布谷地',
};

export function resolveResultsDir(idOrPath: string, projectRoot: string, dataDir: string): string {
  const raw = idOrPath.trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('分析 ID 不能为空');

  const candidates: string[] = [];
  if (path.isAbsolute(raw)) {
    candidates.push(raw);
  } else {
    candidates.push(path.resolve(process.cwd(), raw));
    candidates.push(path.resolve(projectRoot, raw));
    candidates.push(path.join(dataDir, 'results', raw));
    if (/^\d+$/.test(raw)) {
      candidates.push(path.join(projectRoot, 'app/data/results', raw));
    }
  }

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.dirname(c);
  }
  throw new Error(`找不到分析目录: ${raw}\n尝试路径:\n${candidates.map((c) => '  - ' + c).join('\n')}`);
}

function parseGenderRaw(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '男' || s === 'Male' || s === 'male') return 1;
  if (s === '女' || s === 'Female' || s === 'female') return 2;
  if (s === '未知' || s === 'Unknown') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function ensureGames(games: GameDictItem[], users: UserRecord[]): GameDictItem[] {
  const map = new Map<number, GameDictItem>();
  for (const g of games) {
    if (g?.id != null) {
      map.set(g.id, {
        id: g.id,
        name: g.name || FALLBACK_GAME_NAMES[g.id] || `游戏${g.id}`,
        en_name: g.en_name || '',
        op_name: g.op_name || '',
        icon: g.icon || '',
      });
    }
  }
  for (const u of users) {
    for (const le of u.level_exps || []) {
      if (!map.has(le.game_id)) {
        map.set(le.game_id, {
          id: le.game_id,
          name: FALLBACK_GAME_NAMES[le.game_id] || `游戏${le.game_id}`,
          en_name: '',
          op_name: '',
          icon: '',
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.id - b.id);
}

// dual activity stats imported from report.js

async function loadJsonl<T>(file: string): Promise<T[]> {
  if (!fs.existsSync(file)) return [];
  const text = await fsp.readFile(file, 'utf8');
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip */
    }
  }
  return out;
}

async function loadJsonlOrFallback<T>(
  resultsDir: string,
  name: string,
  fallbackCsv: string,
  mapRow: (cols: string[]) => T,
): Promise<T[]> {
  const jsonl = path.join(resultsDir, name);
  const direct = await loadJsonl<T>(jsonl);
  if (direct.length) return direct;

  const csvPath = path.join(resultsDir, fallbackCsv);
  if (!fs.existsSync(csvPath)) return [];
  const text = await fsp.readFile(csvPath, 'utf8');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const out: T[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    try {
      out.push(mapRow(cols));
    } catch {
      /* skip */
    }
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------- SVG / PNG ----------

const FONT = `-apple-system, 'PingFang SC', 'Microsoft YaHei', 'SimHei', sans-serif`;

const FONT_FILES = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simsun.ttc',
].filter((f) => fs.existsSync(f));

function svgHeader(w: number, h: number, title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}">
  <rect width="100%" height="100%" fill="#fafafa"/>
  <text x="20" y="28" font-size="16" font-weight="600" fill="#222">${escapeXml(title)}</text>`;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function barChartSvg(
  title: string,
  items: Array<{ label: string; value: number; tip?: string }>,
  opts?: { width?: number; maxBars?: number; color?: string; valueSuffix?: string },
): string {
  const width = opts?.width ?? 760;
  const maxBars = opts?.maxBars ?? 20;
  const color = opts?.color ?? '#4c7bd9';
  const suffix = opts?.valueSuffix ?? '';
  const data = items.slice(0, maxBars);
  const rowH = 30;
  const padTop = 48;
  const padBottom = 24;
  const labelW = 150;
  const height = padTop + data.length * rowH + padBottom;
  const maxV = Math.max(1, ...data.map((d) => d.value));
  const barMax = width - labelW - 160;

  let s = svgHeader(width, Math.max(120, height), title);
  if (!data.length) {
    s += `<text x="20" y="70" font-size="13" fill="#888">暂无数据</text></svg>`;
    return s;
  }
  data.forEach((d, i) => {
    const y = padTop + i * rowH;
    const bw = Math.max(2, (d.value / maxV) * barMax);
    const tip = d.tip ? ` | ${d.tip}` : '';
    s += `<text x="12" y="${y + 16}" font-size="12" fill="#333">${escapeXml(truncate(d.label, 14))}</text>`;
    s += `<rect x="${labelW}" y="${y + 5}" width="${bw}" height="18" rx="4" fill="${color}" opacity="0.85"/>`;
    s += `<text x="${labelW + bw + 8}" y="${y + 18}" font-size="12" fill="#555">${d.value}${escapeXml(suffix)}${escapeXml(tip)}</text>`;
  });
  s += `</svg>`;
  return s;
}

export function columnChartSvg(title: string, items: Array<{ label: string; value: number }>, opts?: { width?: number; color?: string }): string {
  const width = opts?.width ?? 760;
  const color = opts?.color ?? '#69a36d';
  const height = 320;
  const padL = 48;
  const padR = 16;
  const padT = 48;
  const padB = 56;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;
  const maxV = Math.max(1, ...items.map((d) => d.value));
  const n = Math.max(1, items.length);
  const gap = 8;
  const barW = Math.max(8, (chartW - gap * (n - 1)) / n);

  let s = svgHeader(width, height, title);
  if (!items.length) {
    s += `<text x="20" y="70" font-size="13" fill="#888">暂无数据</text></svg>`;
    return s;
  }
  for (let i = 0; i <= 4; i++) {
    const y = padT + (chartH * i) / 4;
    const v = Math.round(maxV * (1 - i / 4));
    s += `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="#e5e5e5" stroke-width="1"/>`;
    s += `<text x="8" y="${y + 4}" font-size="11" fill="#999">${v}</text>`;
  }
  items.forEach((d, i) => {
    const x = padL + i * (barW + gap);
    const bh = (d.value / maxV) * chartH;
    const y = padT + chartH - bh;
    s += `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(1, bh)}" rx="3" fill="${color}" opacity="0.9"/>`;
    if (items.length <= 24) {
      s += `<text x="${x + barW / 2}" y="${height - 18}" font-size="10" fill="#555" text-anchor="middle">${escapeXml(d.label)}</text>`;
    }
    s += `<text x="${x + barW / 2}" y="${y - 4}" font-size="10" fill="#333" text-anchor="middle">${d.value}</text>`;
  });
  s += `</svg>`;
  return s;
}

export function donutChartSvg(title: string, items: Array<{ label: string; value: number }>): string {
  const width = 460;
  const height = 320;
  const cx = 200;
  const cy = 180;
  const r = 90;
  const ir = 50;
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const colors = ['#5b8ff9', '#f6903d', '#5ad8a6', '#945fb9', '#ff9d4d', '#c4ccd3'];
  let s = svgHeader(width, height, title);
  if (!items.length || total === 0) {
    s += `<text x="20" y="70" font-size="13" fill="#888">暂无数据</text></svg>`;
    return s;
  }
  let angle = -Math.PI / 2;
  items.forEach((it, i) => {
    const frac = it.value / total;
    const a0 = angle;
    const a1 = angle + frac * Math.PI * 2;
    angle = a1;
    s += ringSlice(cx, cy, r, ir, a0, a1, colors[i % colors.length]);
  });
  items.forEach((it, i) => {
    const y = 60 + i * 24;
    const pct = ((it.value / total) * 100).toFixed(1);
    s += `<rect x="310" y="${y - 12}" width="12" height="12" fill="${colors[i % colors.length]}"/>`;
    s += `<text x="328" y="${y}" font-size="12" fill="#333">${escapeXml(it.label)} ${it.value} (${pct}%)</text>`;
  });
  s += `</svg>`;
  return s;
}

function ringSlice(cx: number, cy: number, r: number, ir: number, a0: number, a1: number, color: string): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const x2 = cx + ir * Math.cos(a1);
  const y2 = cy + ir * Math.sin(a1);
  const x3 = cx + ir * Math.cos(a0);
  const y3 = cy + ir * Math.sin(a0);
  const d = [
    `M ${x0} ${y0}`,
    `A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`,
    `L ${x2} ${y2}`,
    `A ${ir} ${ir} 0 ${large} 0 ${x3} ${y3}`,
    'Z',
  ].join(' ');
  return `<path d="${d}" fill="${color}" opacity="0.9"/>`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

function svgToPng(svg: string, scale = 2): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: scale },
    font: {
      loadSystemFonts: true,
      fontFiles: FONT_FILES,
      defaultFontFamily: 'Microsoft YaHei',
    },
  });
  const rendered = resvg.render();
  return Buffer.from(rendered.asPng());
}

async function saveChart(
  baseName: string,
  svg: string,
  svgDir: string,
  pngDir: string,
  logger: Logger,
): Promise<{ svgPath: string; pngPath: string | null }> {
  const svgPath = path.join(svgDir, `${baseName}.svg`);
  await fsp.writeFile(svgPath, svg, 'utf8');
  let pngPath: string | null = null;
  try {
    const png = svgToPng(svg, 2);
    pngPath = path.join(pngDir, `${baseName}.png`);
    await fsp.writeFile(pngPath, png);
  } catch (e) {
    logger.warn({
      chart: baseName,
      err: e instanceof Error ? e.message : String(e),
      msg: 'svg_to_png_failed',
    });
  }
  return { svgPath, pngPath };
}

// ---------- 主分析 ----------

export async function runAnalysis(input: AnalysisInput, logger: Logger): Promise<AnalysisResult> {
  const outDir = path.join(input.resultsDir, input.outSubdir ?? 'analysis');
  const chartsDir = path.join(outDir, 'charts');
  const svgDir = path.join(chartsDir, 'svg');
  await fsp.mkdir(svgDir, { recursive: true });

  const games = ensureGames(input.games, input.users);
  const uniqueCommenters = new Set(input.comments.map((c) => c.uid).filter(Boolean)).size;
  const ipStats = computeIpStats(input.comments, input.users);
  const genderStats = computeGenderStats(input.users);
  const { mode0, mode1 } = computeGameActivityDual(input.users, games, input.levelMin);

  const files: string[] = [];
  const charts: string[] = [];

  const pushChart = async (name: string, svg: string) => {
    const r = await saveChart(name, svg, svgDir, chartsDir, logger);
    charts.push(r.svgPath);
    if (r.pngPath) charts.push(r.pngPath);
  };

  // IP
  await pushChart(
    'ip分布',
    barChartSvg(
      'IP属地分布（按评论计数 Top15）',
      ipStats.slice(0, 15).map((x) => ({ label: x.ip, value: x.count })),
      { color: '#4c7bd9' },
    ),
  );

  // 性别
  await pushChart(
    '性别分布',
    donutChartSvg('用户性别分布（主页样本）', genderStats.map((x) => ({ label: x.gender, value: x.count }))),
  );

  // 注册年份
  const byYear = new Map<number, number>();
  for (const u of input.users) {
    if (!u.created_at) continue;
    const ms = u.created_at > 1e12 ? u.created_at : u.created_at * 1000;
    const y = new Date(ms).getFullYear();
    if (!Number.isFinite(y) || y < 2000 || y > 2100) continue;
    byYear.set(y, (byYear.get(y) ?? 0) + 1);
  }
  const regItems = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([y, v]) => ({ label: String(y), value: v }));
  await pushChart('注册时间分布', columnChartSvg('用户注册年份分布', regItems, { color: '#e6a23c' }));

  // 游戏活跃度 _0 / _1
  const activity0 = barChartSvg(
    '游戏活跃度_0（全量样本，含等级1）',
    mode0.map((g) => ({
      label: g.game_name,
      value: Number(((g.play_rate ?? 0) * 100).toFixed(1)),
      tip: `${g.active_users}/${g.sample_users}`,
    })),
    { color: '#945fb9', valueSuffix: '%' },
  );
  await pushChart('游戏活跃度_0', activity0);

  const activity1 = barChartSvg(
    '游戏活跃度_1（排除社区等级=1；分母=全部用户）',
    mode1.map((g) => ({
      label: g.game_name,
      value: Number(((g.play_rate ?? 0) * 100).toFixed(1)),
      tip: `${g.active_users}/${g.sample_users}`,
    })),
    { color: '#5ad8a6', valueSuffix: '%' },
  );
  await pushChart('游戏活跃度_1', activity1);

  // 等级分布 top games（带名称）
  // 注意：接口对未开通/无活跃分区常返回 level=1 且 exp=0（默认值），
  // 等级分布仅统计「真实有等级」：level>=2 或 (level==1 且 exp>0)
  // 未激活（level1且exp0）人数写在标题，不单独画柱
  for (const g of mode0.filter((x) => x.sample_users > 0).slice(0, 6)) {
    const hist = new Map<number, number>();
    let inactive = 0;
    for (const u of input.users) {
      const le = (u.level_exps || []).find((x) => x.game_id === g.game_id);
      if (!le) continue;
      const isEmptyDefault = le.level === 1 && !(le.exp > 0);
      if (isEmptyDefault) {
        inactive++;
        continue;
      }
      hist.set(le.level, (hist.get(le.level) ?? 0) + 1);
    }
    const items = [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([lv, v]) => ({ label: `Lv${lv}`, value: v }));
    const title = `「${g.game_name}」真实等级分布｜未激活(Lv1且exp=0): ${inactive}人`;
    await pushChart(`游戏等级_${sanitize(g.game_name)}`, columnChartSvg(title, items, { color: '#5ad8a6' }));
  }

  // 评论类型
  const rootN = input.comments.filter((c) => c.comment_type === 'root').length;
  const childN = input.comments.length - rootN;
  await pushChart(
    '评论类型',
    donutChartSvg('评论类型构成', [
      { label: '一级评论', value: rootN },
      { label: '二级评论', value: childN },
    ]),
  );

  // 高赞
  const likeTop = [...input.comments]
    .sort((a, b) => (b.like_num || 0) - (a.like_num || 0))
    .slice(0, 15)
    .map((c) => ({ label: c.nickname || c.uid || '匿名', value: c.like_num || 0 }));
  await pushChart('高赞作者', barChartSvg('高赞评论作者 Top15', likeTop, { color: '#f08a5d' }));

  // HTML：优先引用 png
  const pngBasenames = charts
    .map((f) => path.basename(f))
    .filter((b) => b.endsWith('.png'));
  const html = buildHtml({
    post: input.post,
    uniqueCommenters,
    users: input.users.length,
    comments: input.comments.length,
    genderStats,
    gameMode0: mode0,
    gameMode1: mode1,
    chartPngs: pngBasenames.length ? pngBasenames : charts.map((f) => path.basename(f)).filter((b) => b.endsWith('.svg')),
  });
  const htmlPath = path.join(outDir, 'analysis.html');
  await fsp.writeFile(htmlPath, html, 'utf8');
  files.push(htmlPath);

  const jsonPath = path.join(outDir, 'analysis.json');
  await fsp.writeFile(
    jsonPath,
    JSON.stringify(
      {
        postId: input.post.post_id,
        subject: input.post.subject,
        comments: {
          total: input.comments.length,
          root: rootN,
          child: childN,
          uniqueCommenters,
        },
        users: input.users.length,
        genderStats,
        ipStats: ipStats.slice(0, 50),
        gameActivityMode0: mode0,
        gameActivityMode1: mode1,
        charts: charts.map((f) => path.relative(outDir, f)),
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  files.push(jsonPath);

  const csvLines = ['分类,指标,数值,说明'];
  csvLines.push(`总览,帖子ID,${input.post.post_id},${input.post.subject}`);
  csvLines.push(`总览,评论总数,${input.comments.length},含一级二级`);
  csvLines.push(`总览,去重评论用户数,${uniqueCommenters},不依赖主页爬取`);
  csvLines.push(`总览,主页样本用户数,${input.users.length},`);
  for (const g of genderStats) csvLines.push(`性别,${g.gender},${g.count},占比${((g.count / Math.max(1, input.users.length)) * 100).toFixed(2)}%`);
  for (const ip of ipStats.slice(0, 30)) csvLines.push(`IP,${ip.ip},${ip.count},`);
  for (const g of mode0) {
    csvLines.push([
      '游戏活跃度_0',
      g.game_name,
      g.play_rate == null ? '' : (g.play_rate * 100).toFixed(2) + '%',
      `全量样本:活跃${g.active_users}/${g.sample_users};排除等级1=${g.excluded_level1};等级均值${g.level_avg}`,
    ].join(','));
  }
  for (const g of mode1) {
    csvLines.push([
      '游戏活跃度_1',
      g.game_name,
      g.play_rate == null ? '' : (g.play_rate * 100).toFixed(2) + '%',
      `排除等级1后:活跃${g.active_users}/${g.sample_users};剔除${g.excluded_level1}人;等级均值${g.level_avg}`,
    ].join(','));
  }
  const csvPath = path.join(outDir, '分析汇总.csv');
  await fsp.writeFile(csvPath, '﻿' + csvLines.join('\r\n') + '\r\n', 'utf8');
  files.push(csvPath);

  logger.info({
    outDir,
    charts: charts.length,
    uniqueCommenters,
    users: input.users.length,
    genderStats,
    game0: mode0.length,
    game1: mode1.length,
    msg: 'analysis_done',
  });

  return { outDir, files, uniqueCommenters, charts };
}

export async function runAnalysisById(
  idOrPath: string,
  opts: { projectRoot: string; dataDir: string; logger: Logger; levelMin?: number },
): Promise<AnalysisResult> {
  const resultsDir = resolveResultsDir(idOrPath, opts.projectRoot, opts.dataDir);
  opts.logger.info({ resultsDir, msg: 'analysis_load_start' });

  let post: PostMeta | null = null;
  const postJson = path.join(resultsDir, 'post_meta.json');
  if (fs.existsSync(postJson)) {
    post = JSON.parse(await fsp.readFile(postJson, 'utf8')) as PostMeta;
  }

  const comments = await loadJsonlOrFallback<CommentRecord>(resultsDir, 'comments.jsonl', '评论数据.csv', (c) => ({
    comment_type: (c[0] === 'child' ? 'child' : 'root') as CommentRecord['comment_type'],
    reply_id: c[1],
    post_id: c[2],
    floor_id: c[3] ? Number(c[3]) : null,
    parent_reply_id: c[4] || null,
    parent_floor_id: c[5] ? Number(c[5]) : null,
    uid: c[6],
    nickname: c[7] || null,
    content: c[8],
    created_at: c[9] ? Date.parse(c[9].replace(' ', 'T')) || 0 : 0,
    updated_at: null,
    like_num: c[10] ? Number(c[10]) : 0,
    reply_num: c[11] ? Number(c[11]) : 0,
    sub_reply_count: c[12] ? Number(c[12]) : 0,
    ip_region: c[13] || null,
    is_deleted: c[14] === '是',
    r_uid: null,
  }));

  const users = await loadJsonlOrFallback<UserRecord>(resultsDir, 'users.jsonl', '用户数据.csv', (c) => {
    let level_exps: UserRecord['level_exps'] = [];
    try {
      const parsed = JSON.parse(c[12] || '[]');
      if (Array.isArray(parsed)) {
        level_exps = parsed.map((x: Record<string, unknown>) => ({
          game_id: Number(x.game_id ?? x.gameId ?? 0),
          level: Number(x.level ?? 0),
          exp: Number(x.exp ?? 0),
        }));
      }
    } catch {
      level_exps = [];
    }
    const gender = parseGenderRaw(c[4]);
    const created = c[5] ? Date.parse(c[5].replace(' ', 'T')) / 1000 : null;
    return {
      uid: c[0],
      nickname: c[1] || null,
      ip_region: c[2] || null,
      introduce: c[3] || null,
      avatar_url: null,
      gender,
      created_at: Number.isFinite(created as number) ? created : null,
      comment_count: c[6] ? Number(c[6]) : 0,
      has_root: c[7] === '是',
      has_child: c[8] === '是',
      root_comment_count: c[9] ? Number(c[9]) : 0,
      child_comment_count: c[10] ? Number(c[10]) : 0,
      level_exps,
      active_game_ids: level_exps.filter((x) => x.level >= (opts.levelMin ?? 2) || x.exp > 0).map((x) => x.game_id),
      active_game_names: (c[11] || '').split('、').filter(Boolean),
      achieve: {},
      auth_relations: [],
      followed_cnt: null,
      followed_by: null,
      fetched_at: c[16] || '',
    };
  });

  // jsonl 用户可能 gender 已是数字，level_exps 可能字段正确
  for (const u of users) {
    u.gender = parseGenderRaw(u.gender);
  }

  let games: GameDictItem[] = [];
  const gamesPath = path.join(resultsDir, 'games.json');
  if (fs.existsSync(gamesPath)) {
    try {
      games = JSON.parse(await fsp.readFile(gamesPath, 'utf8')) as GameDictItem[];
    } catch {
      games = [];
    }
  }
  games = ensureGames(games, users);

  if (!post) {
    post = {
      post_id: path.basename(resultsDir),
      game_id: 0,
      f_forum_id: 0,
      uid: '',
      subject: path.basename(resultsDir),
      content: '',
      cover: null,
      created_at: 0,
      reply_time: null,
      max_floor: 0,
      view_type: 0,
      is_official: false,
      stats: {},
    };
    const sumPath = path.join(resultsDir, 'summary.json');
    if (fs.existsSync(sumPath)) {
      try {
        const sum = JSON.parse(await fsp.readFile(sumPath, 'utf8')) as {
          post?: { subject?: string; post_id?: string; max_floor?: number };
        };
        if (sum.post?.subject) post.subject = sum.post.subject;
        if (sum.post?.post_id) post.post_id = sum.post.post_id;
        if (sum.post?.max_floor != null) post.max_floor = sum.post.max_floor;
      } catch {
        /* ignore */
      }
    }
  }

  return runAnalysis(
    {
      resultsDir,
      post,
      comments,
      users,
      games,
      levelMin: opts.levelMin ?? 2,
    },
    opts.logger,
  );
}

function buildHtml(data: {
  post: PostMeta;
  uniqueCommenters: number;
  users: number;
  comments: number;
  genderStats: Array<{ gender: string; count: number }>;
  gameMode0: GameActivityStat[];
  gameMode1: GameActivityStat[];
  chartPngs: string[];
}): string {
  const chartsHtml = data.chartPngs
    .map(
      (f) =>
        `<section class="chart"><h3>${escapeXml(f.replace(/\.png$/i, '').replace(/\.svg$/i, ''))}</h3><img src="charts/${escapeXml(f)}" alt="${escapeXml(f)}"/></section>`,
    )
    .join('\n');

  const pctFmt = (r: number | null, a: number, s: number) =>
    r == null ? '—' : `${(r * 100).toFixed(1)}% | ${a}/${s}`;
  const g0 = data.gameMode0
    .map(
      (r) =>
        `<tr><td>${escapeXml(r.game_name)}</td><td>${pctFmt(r.play_rate, r.active_users, r.sample_users)}</td></tr>`,
    )
    .join('');
  const g1 = data.gameMode1
    .map(
      (r) =>
        `<tr><td>${escapeXml(r.game_name)}</td><td>${pctFmt(r.play_rate, r.active_users, r.sample_users)}</td><td>${r.excluded_level1}</td></tr>`,
    )
    .join('');
  const gender = data.genderStats
    .map((g) => `<tr><td>${escapeXml(g.gender)}</td><td>${g.count}</td><td>${((g.count / Math.max(1, data.users)) * 100).toFixed(2)}%</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>分析报告 ${escapeXml(data.post.post_id)}</title>
<style>
body{font-family:${FONT};margin:24px;background:#f7f7f8;color:#222}
h1{font-size:22px;margin-bottom:8px}
.meta{color:#666;margin-bottom:20px}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px}
.card{background:#fff;border-radius:10px;padding:14px 18px;min-width:140px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card b{display:block;font-size:22px;margin-top:4px}
.chart{background:#fff;border-radius:10px;padding:12px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.chart img{max-width:100%;height:auto}
table{border-collapse:collapse;width:100%;background:#fff;margin-bottom:16px}
td,th{border:1px solid #eee;padding:6px 10px;font-size:13px;text-align:left}
h2{font-size:16px;margin:18px 0 8px}
</style>
</head>
<body>
<h1>帖子 ${escapeXml(data.post.post_id)} 分析报告</h1>
<div class="meta">${escapeXml(data.post.subject)}</div>
<div class="cards">
  <div class="card">评论总数<b>${data.comments}</b></div>
  <div class="card">去重用户数<b>${data.uniqueCommenters}</b></div>
  <div class="card">主页样本<b>${data.users}</b></div>
</div>
<h2>游戏活跃度_0（全量样本，含等级1）</h2>
<table><tr><th>游戏</th><th>活跃率 | 活跃/样本</th></tr>${g0}</table>
<h2>游戏活跃度_1（排除社区等级=1；分母=全部用户）</h2>
<table><tr><th>游戏</th><th>活跃率 | 活跃/全部用户</th><th>该游戏等级1人数</th></tr>${g1}</table>
<h2>性别</h2>
<table><tr><th>性别</th><th>人数</th><th>占比</th></tr>${gender}</table>
${chartsHtml}
</body>
</html>`;
}

export { genderLabel, parseGenderRaw };

/**
 * 中途快照分析：读取当前 run 批次临时结果出图/统计。
 * - 不修改 checkpoint
 * - 可与 crawl/resume 并行（只读 batches）
 * - 输出到 results/<postId>/analysis-partial/
 */
export async function runPartialAnalysis(
  opts: { projectRoot: string; dataDir: string; logger: Logger; levelMin?: number; checkpointPath?: string },
): Promise<AnalysisResult> {
  const { projectRoot, dataDir, logger } = opts;
  const cpPath = opts.checkpointPath ?? path.join(dataDir, 'checkpoint.json');
  if (!fs.existsSync(cpPath)) {
    throw new Error(`找不到 checkpoint: ${cpPath}，请先启动 crawl`);
  }
  const cp = JSON.parse(await fsp.readFile(cpPath, 'utf8')) as {
    runId: string;
    postId: string;
    url?: string;
    phase: string;
    comments?: { written?: number; rootLastId?: string | number };
    users?: { done?: number };
  };
  const runDir = path.join(dataDir, 'runs', cp.runId);
  const commentsDir = path.join(runDir, 'batches', 'comments');
  const usersDir = path.join(runDir, 'batches', 'users');
  const finalDir = path.join(runDir, 'final');
  const resultsDir = path.join(dataDir, 'results', cp.postId);

  logger.info({
    runId: cp.runId,
    postId: cp.postId,
    phase: cp.phase,
    commentsWritten: cp.comments?.written,
    usersDone: cp.users?.done,
    msg: 'partial_analysis_start',
  });

  const comments: CommentRecord[] = [];
  await streamJsonlDir<CommentRecord>(commentsDir, 'comments-batch-', (c) => {
    if (c?.uid) comments.push(c);
  });
  const users: UserRecord[] = [];
  await streamJsonlDir<UserRecord>(usersDir, 'users-batch-', (u) => {
    if (u?.uid) users.push(u);
  });

  let post: PostMeta | null = null;
  const postJson = path.join(finalDir, 'post_meta.json');
  if (fs.existsSync(postJson)) {
    post = JSON.parse(await fsp.readFile(postJson, 'utf8')) as PostMeta;
  }
  if (!post) {
    post = {
      post_id: cp.postId,
      game_id: 0,
      f_forum_id: 0,
      uid: '',
      subject: `中途快照 ${cp.postId}`,
      content: '',
      cover: null,
      created_at: 0,
      reply_time: null,
      max_floor: 0,
      view_type: 0,
      is_official: false,
      stats: {},
    };
  }

  let games: GameDictItem[] = [];
  const gamesPath = path.join(finalDir, 'games.json');
  if (fs.existsSync(gamesPath)) {
    try {
      games = JSON.parse(await fsp.readFile(gamesPath, 'utf8')) as GameDictItem[];
    } catch {
      games = [];
    }
  }

  const outDir = path.join(resultsDir, 'analysis-partial');
  logger.info({
    comments: comments.length,
    users: users.length,
    outDir,
    msg: 'partial_analysis_loaded_batches',
  });

  return runAnalysis(
    {
      resultsDir,
      post,
      comments,
      users,
      games,
      levelMin: opts.levelMin ?? 2,
      outSubdir: 'analysis-partial',
    },
    logger,
  );
}

async function streamJsonlDir<T>(
  dir: string,
  prefix: string,
  onItem: (x: T) => void,
): Promise<void> {
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
    .sort();
  const readline = await import('node:readline');
  for (const file of files) {
    const full = path.join(dir, file);
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(full, { encoding: 'utf8' });
    } catch {
      continue;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        onItem(JSON.parse(line) as T);
      } catch {
        /* 并发写入中的半行，跳过 */
      }
    }
    rl.close();
  }
}
