import { sleep } from './rate.js';

export interface AdaptiveUserLimiterOptions {
  /** 基础间隔 ms，如 800 */
  baseIntervalMs: number;
  /** 初始最大并发：2 人（约 40% 时间可双发） */
  maxInFlight: number;
  /** 限流后回退到的并发：1 人 */
  minInFlight: number;
  /** 回退到 1 人后再次限流 → 暂停后往前一步的毫秒，默认 3 分钟 */
  recoverStepMs: number;
  logger: {
    warn(obj: Record<string, unknown>): void;
    info(obj: Record<string, unknown>): void;
  };
}

/**
 * 用户阶段保守自适应限流：
 * - 稳态：约每 intervalMs 放行 1 个请求；允许短暂 2 人突发（40% 双发）
 * - 限流 1 次：最大并发回退到 1 人（20% 单发）
 * - 在 1 人档再限流：暂停用户爬取 recoverStepMs（默认 3 分钟）
 * - 暂停结束后往前一步恢复到 2 人
 */
export class AdaptiveUserLimiter {
  private maxInFlight: number;
  private tokens: number;
  private nextRefillAt = 0;
  private pausedUntil = 0;
  private extraMs = 0;
  private stepsBack = 0;

  constructor(private opts: AdaptiveUserLimiterOptions) {
    this.maxInFlight = opts.maxInFlight;
    this.tokens = opts.maxInFlight;
  }

  get inFlightLimit() {
    return this.maxInFlight;
  }

  get currentIntervalMs() {
    return this.opts.baseIntervalMs + this.extraMs;
  }

  /** 限流事件：回退并发 / 暂停 */
  async onRateLimited(detail: Record<string, unknown> = {}): Promise<void> {
    if (this.maxInFlight > this.opts.minInFlight) {
      this.maxInFlight = this.opts.minInFlight;
      this.tokens = Math.min(this.tokens, this.maxInFlight);
      this.opts.logger.warn({
        msg: 'user_limit_fallback_single',
        inFlight: this.maxInFlight,
        ...detail,
      });
      return;
    }

    // 已在 1 人档再限流 → 暂停后恢复 2 人
    this.stepsBack++;
    const waitMs = this.opts.recoverStepMs;
    this.pausedUntil = Date.now() + waitMs;
    this.opts.logger.warn({
      msg: 'user_limit_pause',
      waitMs,
      minutes: Math.round(waitMs / 60000),
      step: this.stepsBack,
      ...detail,
    });
    await sleep(waitMs);
    this.maxInFlight = this.opts.maxInFlight;
    this.tokens = this.maxInFlight;
    this.opts.logger.warn({
      msg: 'user_limit_recover_step',
      inFlight: this.maxInFlight,
      step: this.stepsBack,
    });
  }

  /** 事件级 +50ms 间隔（与全局限流策略一致） */
  bumpInterval(deltaMs = 50, maxExtra = 1500) {
    this.extraMs = Math.min(maxExtra, this.extraMs + deltaMs);
    return this.extraMs;
  }

  /** 获取一个并发名额；返回释放函数 */
  async acquire(): Promise<() => void> {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        await sleep(Math.min(200, this.pausedUntil - now));
        continue;
      }
      // 令牌补充：每 currentIntervalMs 补 1 个
      if (now >= this.nextRefillAt) {
        this.tokens = Math.min(this.maxInFlight, this.tokens + 1);
        this.nextRefillAt = now + this.currentIntervalMs;
      }
      if (this.tokens > 0) {
        this.tokens--;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.tokens = Math.min(this.maxInFlight, this.tokens + 1);
        };
      }
      const wait = Math.max(10, this.nextRefillAt - now);
      await sleep(wait);
    }
  }
}
