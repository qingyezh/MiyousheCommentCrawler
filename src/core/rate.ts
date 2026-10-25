export class RateLimiter {
  private nextAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private extraMs = 0;

  constructor(private baseIntervalMs: number) {}

  /** 限流后额外增加的间隔，上限 1500ms */
  get intervalMs(): number {
    return this.baseIntervalMs + this.extraMs;
  }

  get extraMsValue(): number {
    return this.extraMs;
  }

  get baseMs(): number {
    return this.baseIntervalMs;
  }

  /** 每次限流事件 +delta，总 extra 不超过 maxExtra */
  addExtra(deltaMs: number, maxExtra = 1500): number {
    this.extraMs = Math.min(maxExtra, this.extraMs + deltaMs);
    return this.extraMs;
  }

  resetExtra() {
    this.extraMs = 0;
  }

  /** 串行等待：保证同一 limiter 上请求间隔 >= intervalMs */
  async wait(): Promise<void> {
    const run = async () => {
      const now = Date.now();
      const waitMs = Math.max(0, this.nextAt - now);
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
      this.nextAt = Date.now() + this.intervalMs;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 限流事件控制器：
 * - 一次「命中限流 → 重试成功或最终失败」记 1 次事件
 * - 每次事件：请求间隔 +50ms（总 extra 上限 1500ms）
 * - 每 3 次事件：暂停 5/8/11/…/20 分钟（封顶 20 分钟）
 */
export class RateLimitEpisodes {
  private episodes = 0;
  private pauseCount = 0;

  constructor(
    private limiters: RateLimiter[],
    private logger: LoggerLike,
  ) {}

  get episodeCount() {
    return this.episodes;
  }

  async onEpisode(limiter: RateLimiter, detail: Record<string, unknown> = {}): Promise<void> {
    this.episodes++;
    // 本次事件只对命中的 limiter 加间隔；为稳妥也可同步到另一条，这里只加命中的
    const extra = limiter.addExtra(50, 1500);
    this.logger.warn({
      msg: 'rate_limit_episode',
      episode: this.episodes,
      intervalMs: limiter.intervalMs,
      extraMs: extra,
      baseMs: limiter.baseMs,
      ...detail,
    });

    if (this.episodes % 3 === 0) {
      this.pauseCount++;
      const minutes = Math.min(5 + (this.pauseCount - 1) * 3, 20);
      const ms = minutes * 60_000;
      this.logger.warn({
        msg: 'rate_limit_cooldown',
        episode: this.episodes,
        pauseCount: this.pauseCount,
        minutes,
        waitMs: ms,
      });
      await sleep(ms);
      this.logger.warn({ msg: 'rate_limit_cooldown_done', minutes });
    }
  }
}

interface LoggerLike {
  warn(obj: Record<string, unknown>): void;
  info?(obj: Record<string, unknown>): void;
}
