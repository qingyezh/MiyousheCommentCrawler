import { setTimeout as sleep } from 'node:timers/promises';
import { fetch, Agent } from 'undici';
import type { Logger } from 'pino';
import { RateLimiter } from './rate.js';

export interface HttpClientOptions {
  cookie: string;
  userAgent: string;
  timeoutMs: number;
  retry: number;
  backoffBaseMs: number;
  rateLimitMaxRetries?: number;
  rateLimitBaseMs?: number;
  commentLimiter: RateLimiter;
  userLimiter: RateLimiter;
  logger: Logger;
}

/** 斐波那契第 n 项（从 1 开始）：1,1,2,3,5,8,... */
export function fib(n: number): number {
  if (n <= 1) return 1;
  let a = 1;
  let b = 1;
  for (let i = 2; i <= n; i++) {
    const t = a + b;
    a = b;
    b = t;
  }
  return b;
}

export function isRateLimited(status: number, retcode: number, message?: string): boolean {
  if (status === 429 || status === 503) return true;
  const msg = (message ?? '').toLowerCase();
  if (msg.includes('too many') || msg.includes('rate') || msg.includes('频繁') || msg.includes('限流')) {
    return true;
  }
  // 米游社常见限流/异常可重试业务码
  if (retcode === -502 || retcode === -1001) return true;
  return false;
}

export class HttpClient {
  private agent = new Agent({
    connectTimeout: 10_000,
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });

  constructor(private opts: HttpClientOptions) {}

  private headers(referer: string): Record<string, string> {
    return {
      'User-Agent': this.opts.userAgent,
      Cookie: this.opts.cookie,
      Referer: referer,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
  }

  async getJson<T = unknown>(
    url: string,
    limiter: RateLimiter,
    meta: { pool?: string; kind?: string; [k: string]: unknown },
  ): Promise<T> {
    let lastErr: unknown;
    const rateMax = this.opts.rateLimitMaxRetries ?? 6;
    const rateBase = this.opts.rateLimitBaseMs ?? 1000;
    let rateAttempt = 0;

    for (let attempt = 1; attempt <= this.opts.retry + 1 + rateMax; attempt++) {
      await limiter.wait();
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: this.headers(
            new URL(url).origin.includes('miyoushe') ? 'https://www.miyoushe.com/' : 'https://www.mihoyo.com/',
          ),
          dispatcher: this.agent,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        const text = await res.text();
        const latencyMs = Date.now() - started;
        let body: { retcode?: number; message?: string; data?: unknown } | null = null;
        try {
          body = JSON.parse(text) as { retcode?: number; message?: string; data?: unknown } | null;
        } catch {
          throw new Error(`非 JSON 响应 status=${res.status} len=${text.length} head=${text.slice(0, 120)}`);
        }

        const retcode = body?.retcode ?? -999;
        this.opts.logger.info({
          pool: meta.pool ?? 'http',
          kind: meta.kind ?? 'get',
          status: res.status,
          retcode,
          latencyMs,
          attempt,
          bytes: text.length,
          path: safePath(url),
          ...meta,
          msg: 'http_ok',
        });

        if (isRateLimited(res.status, retcode, body?.message)) {
          rateAttempt++;
          if (rateAttempt > rateMax) {
            this.opts.logger.error({
              attempt,
              rateAttempt,
              max: rateMax,
              status: res.status,
              retcode,
              path: safePath(url),
              msg: 'http_rate_limit_exhausted',
            });
            lastErr = new Error(`限流重试耗尽 status=${res.status} retcode=${retcode}`);
            break;
          }
          const wait = fib(rateAttempt) * rateBase;
          this.opts.logger.warn({
            attempt,
            rateAttempt,
            waitMs: wait,
            fibIndex: rateAttempt,
            status: res.status,
            retcode,
            path: safePath(url),
            msg: 'http_rate_limited_fib_wait',
          });
          await sleep(wait);
          lastErr = new Error(`rate_limited status=${res.status} retcode=${retcode}`);
          continue;
        }

        if (retcode !== 0) {
          // 非限流业务错误，部分可重试
          if (retcode === -100) {
            const wait = this.opts.backoffBaseMs * 2 ** Math.min(attempt, 5);
            this.opts.logger.warn({
              attempt,
              wait,
              retcode,
              message: body?.message,
              path: safePath(url),
              msg: 'http_retriable_retcode',
            });
            await sleep(wait);
            lastErr = new Error(`retcode=${retcode} message=${body?.message}`);
            continue;
          }
          this.opts.logger.error({
            attempt,
            retcode,
            message: body?.message,
            path: safePath(url),
            msg: 'http_business_error',
          });
        }
        return body as T;
      } catch (e) {
        lastErr = e;
        const wait = this.opts.backoffBaseMs * 2 ** Math.min(attempt, 5);
        this.opts.logger.error({
          attempt,
          wait,
          err: e instanceof Error ? e.message : String(e),
          path: safePath(url),
          msg: 'http_error',
        });
        if (attempt <= this.opts.retry) await sleep(wait);
      }
    }
    this.opts.logger.error({
      err: lastErr instanceof Error ? lastErr.message : String(lastErr),
      url,
      msg: 'http_exhausted',
    });
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async close() {
    await this.agent.close();
  }
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url.slice(0, 120);
  }
}
