export class RateLimiter {
  private nextAt = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private intervalMs: number) {}

  setInterval(ms: number) {
    this.intervalMs = ms;
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
