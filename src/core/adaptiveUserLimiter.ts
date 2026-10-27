import { sleep } from './rate.js';

export interface UserConcurrencyConfig {
  /** 1–4 并发占比，会自动归一化；允许只填部分档位 */
  weights: Record<number, number>;
  /**
   * 限流恢复后是否允许再次爬升到 3–4 并发。
   * false（默认）：3–4 权重并入 1，恢复后固定双并发 2，不再上 3/4。
   * true：可按权重重新爬升到 3–4。
   */
  allowHighAfterRecover: boolean;
  /** 降到 1 人后，若一段时间无新限流则恢复双并发的毫秒，默认 180000（3 分钟） */
  recoverStepMs: number;
  /** 1 人档再次限流 → 暂停用户爬取的毫秒，默认 180000（3 分钟） */
  pauseOnDoubleFailMs: number;
}

export interface AdaptiveUserLimiterOptions {
  baseIntervalMs: number;
  concurrency: UserConcurrencyConfig;
  logger: {
    warn(obj: Record<string, unknown>): void;
    info(obj: Record<string, unknown>): void;
  };
}

function normalizeWeights(raw: Record<number, number>, allowHigh: boolean): Map<number, number> {
  const src: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const [k, v] of Object.entries(raw || {})) {
    const n = Number(k);
    const w = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 4 && Number.isFinite(w) && w >= 0) {
      src[n] = w;
    }
  }
  if (!allowHigh) {
    // 3–4 权重加和到 1
    src[1] = src[1] + src[3] + src[4];
    src[3] = 0;
    src[4] = 0;
  }
  let sum = 0;
  for (const v of Object.values(src)) sum += v;
  if (sum <= 0) {
    src[1] = 0.3;
    src[2] = 0.7;
    src[3] = 0;
    src[4] = 0;
    sum = 1;
  }
  const m = new Map<number, number>();
  for (const [k, v] of Object.entries(src)) {
    if (v > 0) m.set(Number(k), v / sum);
  }
  return m;
}

function sampleWeighted(weights: Map<number, number>): number {
  const entries = [...weights.entries()];
  if (!entries.length) return 2;
  const r = Math.random();
  let acc = 0;
  for (const [level, p] of entries) {
    acc += p;
    if (r <= acc) return level;
  }
  return entries[entries.length - 1][0];
}

/**
 * 用户阶段自适应并发：
 * - 正常：按 1–4 占比**随机**采样最大并发（不是按 1→2→3→4 爬升）
 * - 关闭 3–4 爬升时，3–4 权重并入 1，随机范围实际为 1/2
 * - 限流：取消并发 → 降到 1 人
 * - 1 人再限流：暂停用户爬取
 * - 1 人后一段时间无新限流：按权重再随机采样并发（默认仍不会采到 3/4）
 */
export class AdaptiveUserLimiter {
  private maxInFlight: number;
  private tokens = 0;
  private nextRefillAt = 0;
  private pausedUntil = 0;
  private extraMs = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private degraded = false;
  private stepsBack = 0;
  private weights: Map<number, number>;
  private slotActive: boolean[] = [];
  private slotNextAt: number[] = [];
  private activeCount = 0;

  constructor(private opts: AdaptiveUserLimiterOptions) {
    this.weights = normalizeWeights(
      opts.concurrency.weights,
      opts.concurrency.allowHighAfterRecover,
    );
    this.maxInFlight = sampleWeighted(this.weights);
    this.ensureSlots();
    opts.logger.info({
      msg: 'user_concurrency_init',
      weights: Object.fromEntries(this.weights),
      allowHighAfterRecover: opts.concurrency.allowHighAfterRecover,
      initInFlight: this.maxInFlight,
      mode: 'per_slot_paced',
    });
  }

  private ensureSlots() {
    while (this.slotActive.length < this.maxInFlight) {
      this.slotActive.push(false);
      this.slotNextAt.push(0);
    }
  }

  private setInFlight(n: number) {
    this.maxInFlight = Math.max(1, n);
    this.ensureSlots();
    // 收紧时标记多余槽为空闲
    for (let i = this.maxInFlight; i < this.slotActive.length; i++) {
      this.slotActive[i] = false;
    }
  }

  get inFlightLimit() {
    return this.maxInFlight;
  }

  get isDegraded() {
    return this.degraded;
  }

  get currentIntervalMs() {
    return this.opts.baseIntervalMs + this.extraMs;
  }

  private clearRecoveryTimer() {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /** 按权重随机恢复并发（不是固定 2，也不是 1→2→3→4 爬升） */
  private sampleRecoverInFlight(): number {
    const allowHigh = this.opts.concurrency.allowHighAfterRecover;
    const w = normalizeWeights(this.opts.concurrency.weights, allowHigh);
    return sampleWeighted(w);
  }

  private armRecoveryTimer() {
    this.clearRecoveryTimer();
    const waitMs = this.opts.concurrency.recoverStepMs;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      // 仍在 1 人且未暂停 → 按权重随机恢复
      if (this.maxInFlight > 1 || Date.now() < this.pausedUntil) return;
      this.setInFlight(this.sampleRecoverInFlight());
      this.degraded = false;
      this.opts.logger.warn({
        msg: 'user_concurrency_recover_random',
        inFlight: this.maxInFlight,
        allowHigh: this.opts.concurrency.allowHighAfterRecover,
        weights: Object.fromEntries(this.weights),
        waitMs,
      });
    }, waitMs);
    this.recoveryTimer.unref?.();
  }

  /** 限流事件 */
  async onRateLimited(detail: Record<string, unknown> = {}): Promise<void> {
    // 任意档位先降到 1（取消并发）
    if (this.maxInFlight > 1) {
      this.setInFlight(1);
      this.degraded = true;
      this.armRecoveryTimer();
      this.opts.logger.warn({
        msg: 'user_limit_fallback_single',
        inFlight: 1,
        previous: detail,
      });
      return;
    }

    // 已在 1 人档再限流 → 取消恢复定时器并暂停
    this.clearRecoveryTimer();
    this.stepsBack++;
    const waitMs = this.opts.concurrency.pauseOnDoubleFailMs;
    this.pausedUntil = Date.now() + waitMs;
    this.opts.logger.warn({
      msg: 'user_limit_pause',
      waitMs,
      minutes: Math.round(waitMs / 60000),
      step: this.stepsBack,
      ...detail,
    });
    await sleep(waitMs);
    // 暂停结束后：按权重随机恢复并发
    this.setInFlight(this.sampleRecoverInFlight());
    this.degraded = false;
    this.opts.logger.warn({
      msg: 'user_limit_recover_after_pause',
      inFlight: this.maxInFlight,
      allowHigh: this.opts.concurrency.allowHighAfterRecover,
      step: this.stepsBack,
      mode: 'per_slot_paced',
    });
  }

  bumpInterval(deltaMs = 50, maxExtra = 1500) {
    this.extraMs = Math.min(maxExtra, this.extraMs + deltaMs);
    return this.extraMs;
  }

  /**
   * 获取一个并发名额；返回释放函数。
   *
   * 设计：每个并发槽位独立按 userMs 节流。
   * - 最多 maxInFlight 个在飞
   * - 每个槽位每 userMs 最多发起 1 次请求
   * - 槽位之间可重叠 → 真并发；整体速率 ≈ maxInFlight / userMs
   * - 不做「全局 1 个/userMs」的串行，否则并发形同虚设
   */
  async acquire(): Promise<() => void> {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        await sleep(Math.min(200, this.pausedUntil - now));
        continue;
      }

      // 找一个到点可发的槽；没有则等最近到点的槽
      let chosen = -1;
      let soonest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.maxInFlight; i++) {
        if (this.slotActive[i]) continue;
        const t = this.slotNextAt[i] ?? 0;
        if (t <= now) {
          chosen = i;
          break;
        }
        if (t < soonest) {
          soonest = t;
          chosen = -1;
        }
      }

      if (chosen < 0) {
        const wait = Math.min(200, Math.max(10, soonest - now));
        await sleep(wait);
        continue;
      }

      this.slotActive[chosen] = true;
      this.slotNextAt[chosen] = now + this.currentIntervalMs;
      this.activeCount++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.slotActive[chosen] = false;
        this.activeCount = Math.max(0, this.activeCount - 1);
      };
    }
  }
}
