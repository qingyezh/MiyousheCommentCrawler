import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import { formatDateInOffset, formatTimeInOffset, offsetLabel } from '../core/timezone.js';

export interface LoggerOptions {
  logDir: string;
  level?: string;
  historyDays?: number;
  runId?: string;
  /** 偏移小时 0..23，默认 0（UTC） */
  timezoneOffsetHours?: number;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function archiveIfOld(file: string, historyDir: string, cutoff: number) {
  if (!fs.existsSync(file)) return;
  const stat = fs.statSync(file);
  if (stat.mtime.getTime() >= cutoff) return;
  const base = path.basename(file);
  let dest = path.join(historyDir, base);
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(historyDir, `${i}-${base}`);
    i++;
  }
  fs.renameSync(file, dest);
}

export function rotateHistory(logDir: string, historyDays = 3, timezoneOffsetHours = 0) {
  const accessDir = path.join(logDir, 'access');
  const historyDir = path.join(logDir, 'history');
  ensureDir(logDir);
  ensureDir(accessDir);
  ensureDir(historyDir);

  // 按配置时区计算“当天 0 点”的绝对时间戳
  const now = Date.now();
  const localDayStartMs = (() => {
    const shifted = new Date(now + timezoneOffsetHours * 3_600_000);
    shifted.setUTCHours(0, 0, 0, 0);
    return shifted.getTime() - timezoneOffsetHours * 3_600_000;
  })();
  const cutoff = localDayStartMs - historyDays * 24 * 3_600_000;

  const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
  for (const f of files) {
    archiveIfOld(path.join(logDir, f), historyDir, cutoff);
  }

  for (const f of fs.readdirSync(accessDir)) {
    archiveIfOld(path.join(accessDir, f), historyDir, cutoff);
  }
}

function consoleStream(level: string, tzHours: number): pino.StreamEntry {
  return {
    level: level as pino.Level,
    stream: {
      write(msg: string) {
        try {
          const obj = JSON.parse(msg) as Record<string, unknown>;
          let t: string;
          if (typeof obj.time === 'string') {
            // pino isoTime 是 UTC ISO；转到配置时区
            const ms = Date.parse(obj.time);
            t = Number.isNaN(ms)
              ? obj.time.slice(11, 23)
              : formatTimeInOffset(new Date(ms), tzHours);
          } else if (typeof obj.time === 'number') {
            t = formatTimeInOffset(new Date(obj.time), tzHours);
          } else {
            t = formatTimeInOffset(new Date(), tzHours);
          }
          const lv = String(obj.level ?? 'info').toUpperCase();
          const base = `[${t}] ${lv} run=${obj.runId ?? '-'} ${obj.msg ?? ''}`;
          const extras: string[] = [];
          for (const [k, v] of Object.entries(obj)) {
            if (['time', 'level', 'msg', 'runId', 'pid', 'hostname'].includes(k)) continue;
            if (v === undefined) continue;
            extras.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
          }
          const line = extras.length ? `${base} ${extras.join(' ')}` : base;
          if (lv === 'ERROR' || lv === 'FATAL') process.stderr.write(line + '\n');
          else process.stdout.write(line + '\n');
        } catch {
          process.stdout.write(msg);
        }
      },
    } as unknown as NodeJS.WritableStream,
  };
}

/** 自定义 timestamp：在 JSON time 字段写入带偏移的墙钟时间（含 offset 标签） */
function offsetTimestampFactory(tzHours: number) {
  const sign = tzHours >= 0 ? '+' : '-';
  const abs = Math.abs(tzHours);
  const hh = String(abs).padStart(2, '0');
  const zone = tzHours === 0 ? 'Z' : `${sign}${hh}:00`;
  return function timestamp(this: unknown): string {
    const now = Date.now() + tzHours * 3_600_000;
    // 使用 UTC 分量格式化，再贴上偏移标签
    const d = new Date(now);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const iso = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}${zone}`;
    return `,"time":"${iso}"`;
  };
}

export function createLogger(opts: LoggerOptions): Logger {
  const tzHours = opts.timezoneOffsetHours ?? 0;
  const logDir = path.isAbsolute(opts.logDir) ? opts.logDir : path.resolve(process.cwd(), opts.logDir);
  ensureDir(logDir);
  ensureDir(path.join(logDir, 'history'));
  ensureDir(path.join(logDir, 'access'));

  rotateHistory(logDir, opts.historyDays ?? 3, tzHours);

  const level = opts.level ?? 'info';
  const day = formatDateInOffset(new Date(), tzHours);
  const mainFile = path.join(logDir, `app-${day}.log`);
  const errFile = path.join(logDir, `app-${day}.error.log`);

  const streams: pino.StreamEntry[] = [
    { level: level as pino.Level, stream: pino.destination({ dest: mainFile, sync: false, mkdir: true }) },
    { level: 'error', stream: pino.destination({ dest: errFile, sync: false, mkdir: true }) },
    consoleStream(level, tzHours),
  ];

  return pino(
    {
      level,
      base: {
        runId: opts.runId,
        tz: offsetLabel(tzHours),
      },
      timestamp: offsetTimestampFactory(tzHours),
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
    pino.multistream(streams),
  );
}
