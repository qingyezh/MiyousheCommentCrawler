import type { Logger } from 'pino';
import { sleep } from './rate.js';

export interface PoolOptions {
  concurrency: number;
  logger: Logger;
  name: string;
}

export interface PoolStats {
  done: number;
  failed: number;
  total: number;
}

export class TaskPool<TIn, TOut> {
  private stats: PoolStats = { done: 0, failed: 0, total: 0 };
  private paused = false;
  private aborted = false;
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private opts: PoolOptions) {}

  get name() {
    return this.opts.name;
  }

  snapshot(): PoolStats {
    return { ...this.stats };
  }

  pause() {
    this.paused = true;
    this.opts.logger.info({ pool: this.opts.name, msg: 'pool_pause' });
  }

  resume() {
    this.paused = false;
    this.opts.logger.info({ pool: this.opts.name, msg: 'pool_resume' });
    this.releaseWaiters();
  }

  abort() {
    this.aborted = true;
    this.releaseWaiters();
    this.opts.logger.warn({ pool: this.opts.name, msg: 'pool_abort' });
  }

  get isAborted() {
    return this.aborted;
  }

  private async guardSlot() {
    while (true) {
      if (this.aborted) throw new Error('pool_aborted');
      if (!this.paused && this.active < this.opts.concurrency) {
        this.active++;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  private releaseSlot() {
    this.active = Math.max(0, this.active - 1);
    this.releaseWaiters();
  }

  private releaseWaiters() {
    const list = this.waiters.splice(0, this.waiters.length);
    for (const w of list) w();
  }

  /**
   * 并发处理任务；顺序不保证，但单个任务内部可串行。
   * 返回成功结果；失败计入 stats 并记日志。
   */
  async run(tasks: TIn[], handler: (task: TIn, index: number) => Promise<TOut>): Promise<TOut[]> {
    this.stats.total += tasks.length;
    const results: TOut[] = [];
    const errors: Array<{ task: TIn; err: unknown }> = [];

    const worker = async (task: TIn, index: number) => {
      await this.guardSlot();
      try {
        if (this.aborted) return;
        const out = await handler(task, index);
        results.push(out);
        this.stats.done++;
      } catch (e) {
        this.stats.failed++;
        errors.push({ task, err: e });
        this.opts.logger.error({
          pool: this.opts.name,
          index,
          err: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
          msg: 'pool_task_failed',
        });
      } finally {
        this.releaseSlot();
      }
    };

    await Promise.all(tasks.map((t, i) => worker(t, i)));
    this.opts.logger.info({
      pool: this.opts.name,
      done: this.stats.done,
      failed: this.stats.failed,
      total: this.stats.total,
      msg: 'pool_drain',
    });
    if (errors.length && this.stats.failed === this.stats.total) {
      throw new Error(`pool ${this.opts.name} 全部任务失败: ${errors[0].err}`);
    }
    return results;
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  logger: Logger,
  label: string,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      logger.warn({
        attempt: i + 1,
        err: e instanceof Error ? e.message : String(e),
        label,
        msg: 'retry_wrapper',
      });
      if (i < retries) await sleep(400 * 2 ** i);
    }
  }
  throw last;
}
