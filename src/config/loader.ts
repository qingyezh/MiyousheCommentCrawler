import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { parseTimezoneOffset } from '../core/timezone.js';
import type { AppConfig } from '../types.js';

const configSchema = z.object({
  cookie: z.string().default(''),
  http: z
    .object({
      userAgent: z
        .string()
        .default(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ),
      timeoutMs: z.number().int().positive().default(20000),
      globalQps: z.number().positive().default(5),
      retry: z.number().int().min(0).default(3),
      backoffBaseMs: z.number().int().positive().default(500),
      rateLimitMaxRetries: z.number().int().min(0).default(6),
      rateLimitBaseMs: z.number().int().min(1).default(1000),
    })
    .default({}),
  intervals: z
    .object({
      commentMs: z.number().int().min(0).default(1200),
      userMs: z.number().int().min(0).default(800),
    })
    .default({}),
  pools: z
    .object({
      comments: z.object({ concurrency: z.number().int().min(1).default(2) }).default({}),
      users: z.object({ concurrency: z.number().int().min(1).default(2) }).default({}),
    })
    .default({}),
  replies: z
    .object({
      pageSize: z.number().int().min(1).max(50).default(20),
      orderType: z.union([z.literal(1), z.literal(2)]).default(1),
      includeChild: z.boolean().default(true),
      childPageSize: z.number().int().min(1).max(20).default(10),
      childMaxPerFloor: z.number().int().min(1).default(50),
    })
    .default({}),
  users: z
    .object({
      enabled: z.boolean().default(false),
      levelMin: z.number().int().min(1).default(2),
      maxUsers: z.number().int().min(0).default(2000),
    })
    .default({}),
  io: z
    .object({
      batchSize: z.number().int().min(1).default(50),
      flushIntervalMs: z.number().int().min(100).default(2000),
      purgeBatchesOnSuccess: z.boolean().default(false),
      dataDir: z.string().default('app/data'),
      logDir: z.string().default('app/log'),
    })
    .default({}),
  log: z
    .object({
      level: z.string().default('info'),
      historyDays: z.number().int().min(1).default(3),
      /** 时区：UTC / UTC+0~UTC+23；非法值回落 UTC */
      timezoneOffset: z.string().default('UTC+8'),
    })
    .default({})
    .transform((v) => {
      const tz = parseTimezoneOffset(v.timezoneOffset);
      return {
        ...v,
        timezoneOffset: tz.label,
        timezoneOffsetHours: tz.hours,
      };
    }),
  control: z
    .object({
      port: z.number().int().default(8787),
      enable: z.boolean().default(false),
    })
    .default({}),
  crawl: z
    .object({
      url: z.string().default(''),
      users: z.boolean().default(false),
      includeChild: z.boolean().default(true),
      maxRootPages: z.number().int().min(0).default(0),
      maxUsers: z.number().int().min(0).default(0),
      purgeBatches: z.boolean().default(false),
      analysis: z.boolean().default(true),
    })
    .default({}),
});

export function loadConfig(projectRoot: string): AppConfig {
  const defaultPath = path.join(projectRoot, 'app/config/default.yaml');
  const localPath = path.join(projectRoot, 'app/config/config.yaml');

  let raw: Record<string, unknown> = {};
  if (fs.existsSync(defaultPath)) {
    raw = { ...parse(fs.readFileSync(defaultPath, 'utf8')) };
  }
  if (fs.existsSync(localPath)) {
    const local = parse(fs.readFileSync(localPath, 'utf8')) as Record<string, unknown>;
    raw = deepMerge(raw, local);
  }

  const envCookie = process.env.MIYOUSHE_COOKIE?.trim();
  if (envCookie) raw.cookie = envCookie;

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`配置校验失败: ${parsed.error.message}\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  return parsed.data;
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export function projectRootFrom(metaUrl: string): string {
  // dist: app/dist/config/loader.js -> project root is ../../../
  // src via tsx: src/config/loader.js -> ../..
  const dir = path.dirname(new URL(metaUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  // walk up until package.json found
  let cur = dir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(cur, 'package.json'))) return cur;
    cur = path.dirname(cur);
  }
  return process.cwd();
}
