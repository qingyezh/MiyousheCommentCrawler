import fsp from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import type { Logger } from 'pino';
import { postFullUrl } from '../api/urls.js';
import { HttpClient } from '../core/http.js';
import { RateLimiter, sleep } from '../core/rate.js';
import { parseMiyousheUrl } from '../core/util.js';
import { writeTitleMarkerFile } from './analysis.js';

export interface MonitorPoint {
  t: number;
  time: string;
  view: number;
  like: number;
  reply: number;
  dView: number;
  dLike: number;
  dReply: number;
}

export interface MonitorOptions {
  url: string;
  intervalMs: number;
  /** 环形窗口，默认 180 点（2s * 180 = 6 分钟） */
  window?: number;
  maxPoints?: number;
  /** 本地 UI 端口，默认 18765 */
  port?: number;
  /** 终端 sparkline，默认 false */
  sparkline?: boolean;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lineChartSvg(
  title: string,
  series: Array<{ name: string; color: string; values: number[] }>,
  labels: string[],
  opts?: { width?: number; height?: number },
): string {
  const width = opts?.width ?? 900;
  const height = opts?.height ?? 360;
  const padL = 56;
  const padR = 16;
  const padT = 48;
  const padB = 40;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;
  const allVals = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const minV = Math.min(0, ...allVals);
  const maxV = Math.max(1, ...allVals);
  const n = Math.max(2, ...series.map((s) => s.values.length));

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
  <rect width="100%" height="100%" fill="#fafafa"/>
  <text x="20" y="28" font-size="15" font-weight="600" fill="#222">${escapeXml(title)}</text>`;

  for (let i = 0; i <= 4; i++) {
    const y = padT + (chartH * i) / 4;
    const v = maxV - ((maxV - minV) * i) / 4;
    s += `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="#e8e8e8"/>`;
    s += `<text x="8" y="${y + 4}" font-size="11" fill="#999">${Math.round(v)}</text>`;
  }

  series.forEach((ser, si) => {
    const pts: string[] = [];
    ser.values.forEach((v, i) => {
      const x = padL + (i / Math.max(1, n - 1)) * chartW;
      const y = padT + chartH - ((v - minV) / Math.max(1e-9, maxV - minV)) * chartH;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    if (pts.length >= 2) {
      s += `<polyline fill="none" stroke="${ser.color}" stroke-width="2" points="${pts.join(' ')}"/>`;
    }
    const ly = padT + 14 + si * 18;
    s += `<rect x="${width - 160}" y="${ly - 10}" width="12" height="12" fill="${ser.color}"/>`;
    s += `<text x="${width - 144}" y="${ly}" font-size="12" fill="#333">${escapeXml(ser.name)}</text>`;
  });

  if (labels.length >= 2) {
    s += `<text x="${padL}" y="${height - 12}" font-size="11" fill="#888">${escapeXml(labels[0])}</text>`;
    s += `<text x="${width - padR}" y="${height - 12}" font-size="11" fill="#888" text-anchor="end">${escapeXml(labels[labels.length - 1])}</text>`;
  }
  s += `</svg>`;
  return s;
}

/** 导出前降采样：最多 max 个点，保持首尾 */
function downsamplePoints<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    out.push(arr[Math.round(i * step)]);
  }
  return out;
}

/** 可中断 sleep：最多切 100ms 片，stop 后立刻返回 */
async function interruptibleSleep(ms: number, isStopped: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isStopped()) return;
    await sleep(Math.min(100, end - Date.now()));
  }
}

/**
 * 增长曲线：屏蔽与上一保留点时间间隔 > 2*intervalMs 的点
 * （避免暂停/断流造成的异常大 Δ 拉爆坐标轴）
 */
export function filterGrowthPoints<T extends { t: number }>(pts: T[], intervalMs: number): T[] {
  if (pts.length <= 1) return pts;
  const maxGap = intervalMs * 2;
  const out: T[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i].t - pts[i - 1].t;
    if (gap > maxGap) continue;
    out.push(pts[i]);
  }
  return out;
}

function sparkline(values: number[], width = 40): string {
  if (values.length < 2) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(1, max - min);
  const chars = '▁▂▃▄▅▆▇█';
  const n = Math.min(values.length, width);
  const slice = values.slice(-n);
  return slice
    .map((v) => {
      const idx = Math.min(chars.length - 1, Math.floor(((v - min) / range) * (chars.length - 1)));
      return chars[idx];
    })
    .join('');
}

export interface MonitorResult {
  outDir: string;
  csvPath: string;
  svgAbsolute: string;
  svgGrowth: string;
  points: number;
}

import type { AppConfig } from '../types.js';

export interface MonitorContext {
  config: AppConfig;
  logger: Logger;
  projectRoot: string;
}

export async function runMonitor(opts: MonitorOptions, ctx: MonitorContext): Promise<MonitorResult> {
  const { logger, config, projectRoot } = ctx;
  const { postId } = parseMiyousheUrl(opts.url);
  const intervalMs = Math.max(500, opts.intervalMs);
  const window = opts.window ?? 180;
  const maxPoints = opts.maxPoints ?? 5000;
  const postRootDir = path.join(projectRoot, 'app/data/results', postId);
  const resultsDir = path.join(postRootDir, 'monitor');
  await fsp.mkdir(resultsDir, { recursive: true });
  const csvPath = path.join(resultsDir, '时间序列.csv');
  await fsp.writeFile(
    csvPath,
    '﻿时间,浏览数,点赞数,评论数,Δ浏览,Δ点赞,Δ评论\n',
    'utf8',
  );

  const points: MonitorPoint[] = [];
  let prev: { view: number; like: number; reply: number } | null = null;
  let stopped = false;
  let titleMarked = false;

  const limiter = new RateLimiter(Math.min(intervalMs, config.intervals.commentMs));
  // 监控节流：至少 intervalMs
  const monitorLimiter = new RateLimiter(intervalMs);
  void limiter;
  const client = new HttpClient({
    cookie: config.cookie,
    userAgent: config.http.userAgent,
    timeoutMs: config.http.timeoutMs,
    retry: config.http.retry,
    backoffBaseMs: config.http.backoffBaseMs,
    rateLimitMaxRetries: config.http.rateLimitMaxRetries,
    rateLimitBaseMs: config.http.rateLimitBaseMs,
    commentLimiter: monitorLimiter,
    userLimiter: monitorLimiter,
    logger,
  });

  const fetchData = async (): Promise<void> => {
    const res = await client.getJson(postFullUrl(null, postId), monitorLimiter, {
      pool: 'monitor',
      kind: 'post_full',
      postId,
    });
    const data = (res as { data?: unknown })?.data as
      | {
          post?: {
            post?: { subject?: string };
            stat?: Record<string, number>;
          };
        }
      | undefined;

    // 首次拿到标题 → 在数据根目录写空文件 .<标题>
    // getPostFull 结构: data.post.post.subject / data.post.stat
    const subject = data?.post?.post?.subject;
    if (!titleMarked && subject) {
      try {
        const marker = await writeTitleMarkerFile(postRootDir, subject, logger);
        process.stdout.write(`标题空文件: ${marker}\n`);
      } catch (e) {
        logger.warn({
          err: e instanceof Error ? e.message : String(e),
          msg: 'monitor_title_marker_failed',
        });
      }
      titleMarked = true;
    }

    const stat = data?.post?.stat ?? {};
    const view = Number(stat.view_num ?? 0);
    const like = Number(stat.like_num ?? 0);
    const reply = Number(stat.reply_num ?? 0);
    const now = Date.now();
    const pt: MonitorPoint = {
      t: now,
      time: new Date(now).toISOString().slice(11, 19),
      view,
      like,
      reply,
      dView: prev ? view - prev.view : 0,
      dLike: prev ? like - prev.like : 0,
      dReply: prev ? reply - prev.reply : 0,
    };
    prev = { view, like, reply };
    points.push(pt);
    if (points.length > maxPoints) points.splice(0, points.length - maxPoints);

    await fsp.appendFile(
      csvPath,
      `${pt.time},${pt.view},${pt.like},${pt.reply},${pt.dView},${pt.dLike},${pt.dReply}\n`,
      'utf8',
    );

    const windowPts = points.slice(-window);
    const lines = [
      `[${pt.time}] 浏览 ${pt.view} (${pt.dView >= 0 ? '+' : ''}${pt.dView}) | 点赞 ${pt.like} (${pt.dLike >= 0 ? '+' : ''}${pt.dLike}) | 评论 ${pt.reply} (${pt.dReply >= 0 ? '+' : ''}${pt.dReply})`,
    ];
    if (opts.sparkline) {
      lines.push(
        `浏览 ${sparkline(windowPts.map((p) => p.view))}`,
        `点赞 ${sparkline(windowPts.map((p) => p.like))}`,
        `评论 ${sparkline(windowPts.map((p) => p.reply))}`,
      );
    }
    process.stdout.write(lines.join('\n') + '\n');
    logger.info({
      msg: 'monitor_point',
      view,
      like,
      reply,
      dView: pt.dView,
      dLike: pt.dLike,
      dReply: pt.dReply,
      points: points.length,
    });
  };

  // 本地浏览器 UI
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname === '/api/points') {
      const windowPts = points.slice(-window);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ points: windowPts, total: points.length, postId }));
      return;
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(monitorHtml(postId, intervalMs));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const uiPort = opts.port ?? 18765;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(uiPort, '127.0.0.1', () => resolve());
  });
  const uiUrl = `http://127.0.0.1:${uiPort}/`;
  logger.info({ uiUrl, postId, intervalMs, msg: 'monitor_ui_listen' });
  process.stdout.write(`\n监控页面: ${uiUrl}\n数据 CSV: ${csvPath}\nCtrl+C 结束并导出 SVG\n\n`);

  const onSig = () => {
    stopped = true;
    process.stdout.write('\n正在停止监控并导出图表...\n');
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  // 首点
  try {
    await fetchData();
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e), msg: 'monitor_first_point_failed' });
  }

  while (!stopped) {
    await interruptibleSleep(intervalMs, () => stopped);
    if (stopped) break;
    try {
      await fetchData();
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : String(e), msg: 'monitor_point_failed' });
    }
  }

  await client.close().catch(() => undefined);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // 若有挂起连接，强制关闭
    setTimeout(() => resolve(), 2000).unref?.();
  });

  // 导出 SVG：原始曲线 + 增长曲线（默认开启）
  // 降采样：避免 maxPoints 很大时 SVG 生成卡死
  const EXPORT_MAX = 2500;
  process.stdout.write(`正在导出图表（采样点 ${points.length} → 最多 ${EXPORT_MAX}）...\n`);
  logger.info({ points: points.length, exportMax: EXPORT_MAX, msg: 'monitor_export_start' });

  const exportPts = downsamplePoints(points, EXPORT_MAX);
  const labels = exportPts.map((p) => p.time);
  const absSvg = lineChartSvg(
    `帖子 ${postId} 数据曲线（原始）`,
    [
      { name: '浏览', color: '#4c7bd9', values: exportPts.map((p) => p.view) },
      { name: '点赞', color: '#e6a23c', values: exportPts.map((p) => p.like) },
      { name: '评论', color: '#67c23a', values: exportPts.map((p) => p.reply) },
    ],
    labels,
  );

  // 增长曲线：剔除间隔 > 2*intervalSec 的点（在降采样后再滤，或先滤再采样）
  const growthPts = filterGrowthPoints(points, intervalMs);
  const growthExport = downsamplePoints(growthPts, EXPORT_MAX);
  const growthLabels = growthExport.map((p) => p.time);
  const growthSvg = lineChartSvg(
    `帖子 ${postId} 增长曲线（Δ 每 ${Math.round(intervalMs / 1000)}s，已剔除间隔>${Math.round((intervalMs * 2) / 1000)}s 的点）`,
    [
      { name: 'Δ浏览', color: '#4c7bd9', values: growthExport.map((p) => p.dView) },
      { name: 'Δ点赞', color: '#e6a23c', values: growthExport.map((p) => p.dLike) },
      { name: 'Δ评论', color: '#67c23a', values: growthExport.map((p) => p.dReply) },
    ],
    growthLabels,
  );
  const svgAbsolute = path.join(resultsDir, '原始曲线.svg');
  const svgGrowth = path.join(resultsDir, '增长曲线.svg');
  await fsp.writeFile(svgAbsolute, absSvg, 'utf8');
  await fsp.writeFile(svgGrowth, growthSvg, 'utf8');
  logger.info({
    points: points.length,
    exportedPoints: exportPts.length,
    growthPoints: growthExport.length,
    growthFilteredOut: growthPts.length - growthExport.length + (points.length - growthPts.length),
    csvPath,
    svgAbsolute,
    svgGrowth,
    msg: 'monitor_done',
  });
  process.stdout.write(`导出完成:\n  ${svgAbsolute}\n  ${svgGrowth}\n  ${csvPath}\n`);

  return { outDir: resultsDir, csvPath, svgAbsolute, svgGrowth, points: points.length };
}

function monitorHtml(postId: string, intervalMs: number): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>监控 ${escapeXml(postId)}</title>
<style>
body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;margin:0;background:#0f1221;color:#e8eaf6}
header{padding:14px 20px;background:#171b2e;border-bottom:1px solid #2a3050}
h1{margin:0;font-size:18px;font-weight:600}
.meta{color:#9aa3c0;font-size:12px;margin-top:4px}
main{padding:16px 20px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{background:#171b2e;border:1px solid #2a3050;border-radius:12px;padding:14px}
.card h2{margin:0;font-size:13px;color:#9aa3c0;font-weight:500}
.card .v{font-size:28px;font-weight:700;margin:6px 0}
.card .d{font-size:13px;color:#7ee787}
.card .d.neg{color:#ff7b72}
section.wide{grid-column:1/-1;background:#171b2e;border:1px solid #2a3050;border-radius:12px;padding:12px}
canvas{width:100%;height:280px;display:block}
.legend{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 8px}
.legend button{
  appearance:none;border:1px solid #2a3050;background:#0f1221;color:#c5cbe8;
  border-radius:999px;padding:4px 12px;font-size:12px;cursor:pointer;
  display:inline-flex;align-items:center;gap:6px;transition:.15s;
}
.legend button .sw{width:10px;height:10px;border-radius:2px;display:inline-block}
.legend button.off{opacity:.35;text-decoration:line-through}
.legend button:hover{border-color:#4c7bd9}
footer{padding:8px 20px 20px;color:#9aa3c0;font-size:12px}
</style>
</head>
<body>
<header>
  <h1>帖子 ${escapeXml(postId)} 实时监控</h1>
  <div class="meta">采样间隔 ${(intervalMs / 1000).toFixed(0)}s · 本地页自动刷新 · 点击图例开关曲线</div>
</header>
<main>
  <div class="card"><h2>浏览数</h2><div class="v" id="view">-</div><div class="d" id="dv">-</div></div>
  <div class="card"><h2>点赞数</h2><div class="v" id="like">-</div><div class="d" id="dl">-</div></div>
  <div class="card"><h2>评论数</h2><div class="v" id="reply">-</div><div class="d" id="dr">-</div></div>
  <section class="wide">
    <h2 style="margin:0 0 8px;font-size:14px;color:#9aa3c0">原始曲线</h2>
    <div class="legend" id="legend-abs"></div>
    <canvas id="abs" width="1200" height="280"></canvas>
  </section>
  <section class="wide">
    <h2 style="margin:0 0 8px;font-size:14px;color:#9aa3c0">增长曲线（Δ / 采样）</h2>
    <div class="legend" id="legend-grow"></div>
    <canvas id="grow" width="1200" height="280"></canvas>
  </section>
</main>
<footer>结束终端进程后自动生成 原始曲线.svg / 增长曲线.svg</footer>
<script>
const series = [
  {key:'view', dKey:'dView', color:'#4c7bd9', label:'浏览', on:true},
  {key:'like', dKey:'dLike', color:'#e6a23c', label:'点赞', on:true},
  {key:'reply', dKey:'dReply', color:'#67c23a', label:'评论', on:true},
];
function visible() { return series.filter(s => s.on); }
function renderLegend(elId) {
  const box = document.getElementById(elId);
  box.innerHTML = '';
  series.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (!s.on) btn.classList.add('off');
    btn.innerHTML = '<span class="sw" style="background:'+s.color+'"></span>'+s.label;
    btn.title = s.on ? '点击隐藏该曲线' : '点击显示该曲线';
    btn.addEventListener('click', () => {
      s.on = !s.on;
      renderLegend('legend-abs');
      renderLegend('legend-grow');
      draw('abs', false);
      draw('grow', true);
    });
    box.appendChild(btn);
  });
}
function draw(id, useDelta) {
  const cv = document.getElementById(id);
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = '#171b2e';
  ctx.fillRect(0,0,w,h);
  window.__pts = window.__pts || [];
  let pts = window.__pts;
  // 增长曲线：屏蔽与上一点间隔 > 2*intervalMs 的点
  if (useDelta && pts.length > 1) {
    const maxGap = ${intervalMs} * 2;
    const filtered = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t - pts[i-1].t <= maxGap) filtered.push(pts[i]);
    }
    pts = filtered;
  }
  const vis = visible();
  if (pts.length < 2) {
    ctx.fillStyle = '#9aa3c0';
    ctx.font = '14px sans-serif';
    ctx.fillText('等待数据点...', 20, 40);
    return;
  }
  const pad = {l:56,r:16,t:16,b:24};
  const cw = w-pad.l-pad.r, ch = h-pad.t-pad.b;
  let vals = [];
  for (const s of vis) for (const p of pts) vals.push(useDelta ? p[s.dKey] : p[s.key]);
  if (!vals.length) vals = [0, 1];
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (mn === mx) { mn -= 1; mx += 1; }
  const X = i => pad.l + (i/(pts.length-1))*cw;
  const Y = v => pad.t + ch - ((v-mn)/(mx-mn))*ch;
  ctx.strokeStyle = '#2a3050';
  ctx.beginPath();
  for (let i=0;i<=4;i++){ const y=pad.t+ch*i/4; ctx.moveTo(pad.l,y); ctx.lineTo(w-pad.r,y); }
  ctx.stroke();
  ctx.fillStyle = '#9aa3c0';
  ctx.fillText(String(Math.round(mx)), 8, pad.t+4);
  ctx.fillText(String(Math.round(mn)), 8, pad.t+ch);
  vis.forEach((s, si) => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p,i)=>{
      const v = useDelta ? p[s.dKey] : p[s.key];
      const x=X(i), y=Y(v);
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
  });
}
async function tick() {
  try {
    const r = await fetch('/api/points');
    const j = await r.json();
    window.__pts = j.points || [];
    const last = window.__pts[window.__pts.length-1];
    if (last) {
      view.textContent = last.view;
      like.textContent = last.like;
      reply.textContent = last.reply;
      const setd = (el, v) => { el.textContent = (v>=0?'+':'')+v; el.className = v<0 ? 'd neg' : 'd'; };
      setd(dv, last.dView); setd(dl, last.dLike); setd(dr, last.dReply);
    }
    draw('abs', false);
    draw('grow', true);
  } catch (e) {}
}
// 图例只初始化一次，避免每秒重建导致无法点击
if (!window.__legendReady) {
  window.__legendReady = true;
  renderLegend('legend-abs');
  renderLegend('legend-grow');
}
setInterval(tick, 1000);
tick();
</script>
</body>
</html>`;
}
