#!/usr/bin/env node
/**
 * 列出 app/data/results 下所有帖子 ID 与标题（对齐表格）
 * 用法: pnpm run List-Title
 * 也可: node app/dist/app/scripts/listTitle.js [resultsDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function projectRootFrom(metaUrl: string): string {
  let cur = path.dirname(new URL(metaUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(cur, 'package.json'))) return cur;
    cur = path.dirname(cur);
  }
  return process.cwd();
}

function sanitizeTitleFilename(title: string): string {
  return (
    String(title)
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .slice(0, 120) || 'untitled'
  );
}

function readTitleFromDir(dir: string): string {
  // 1) 空标题标记文件 .标题
  try {
    const names = fs.readdirSync(dir);
    const marker = names.find((n) => n.startsWith('.') && !n.startsWith('..') && fs.statSync(path.join(dir, n)).isFile());
    if (marker) return marker.slice(1);
  } catch {
    /* ignore */
  }
  // 2) post_meta.json
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'post_meta.json'), 'utf8')) as { subject?: string };
    if (p.subject) return p.subject;
  } catch {
    /* ignore */
  }
  // 3) summary.json
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) as {
      post?: { subject?: string };
    };
    if (s.post?.subject) return s.post.subject;
  } catch {
    /* ignore */
  }
  // 4) 帖子基本信息.csv 第二行第 2 列
  try {
    const text = fs.readFileSync(path.join(dir, '帖子基本信息.csv'), 'utf8');
    const line = text.replace(/^﻿/, '').split(/\r?\n/)[1];
    if (line) {
      const cols = line.split(',');
      if (cols[1]) return cols[1].replace(/^"|"$/g, '');
    }
  } catch {
    /* ignore */
  }
  return '(无标题)';
}

function displayWidth(s: string): number {
  // 中文等宽字符按 2 计
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
      ? 2
      : 1;
  }
  return w;
}

function padEndVisual(s: string, target: number): string {
  const w = displayWidth(s);
  return s + ' '.repeat(Math.max(0, target - w));
}

function main() {
  const root = projectRootFrom(import.meta.url);
  const resultsDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(root, 'app/data/results');

  if (!fs.existsSync(resultsDir)) {
    console.error(`目录不存在: ${resultsDir}`);
    process.exit(1);
  }

  const ids = fs
    .readdirSync(resultsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });

  if (ids.length === 0) {
    console.log('(无结果目录)');
    return;
  }

  const rows = ids.map((id) => ({
    id,
    title: readTitleFromDir(path.join(resultsDir, id)),
  }));

  const idW = Math.max(2, displayWidth('ID'), ...rows.map((r) => displayWidth(r.id)));
  const titleW = Math.max(2, displayWidth('标题'), ...rows.map((r) => displayWidth(r.title)));

  const sepA = '-'.repeat(idW);
  const sepB = '-'.repeat(titleW);

  console.log(padEndVisual('ID', idW) + '  ' + padEndVisual('标题', titleW));
  console.log(sepA + '  ' + sepB);
  for (const r of rows) {
    console.log(padEndVisual(r.id, idW) + '  ' + padEndVisual(r.title, titleW));
  }
  console.log(`\n共 ${rows.length} 条`);
}

main();
