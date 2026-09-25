import type { Clock } from '../clock/clock.js';
import { SystemClock } from '../clock/system-clock.js';
import type { Scheduler } from '../core/scheduler.js';
import { requirePositiveInteger } from '../core/validation-helper.js';
import {
  deriveQueueBounds,
  type PaceOptions,
  type QueueBounds,
  type QueueOptions,
} from './pacing-constants.js';
import { checkBounds } from './slot.js';
import { WaitQueue } from './wait-queue.js';

/**
 * Adds queue bounds and a single-timer wait queue to any {@link Scheduler}
 * (spec §9.5).
 *
 * It never decides *when* a caller may go — that is the scheduler's job. It
 * decides whether the caller may wait at all, and then holds it.
 *
 * ```ts
 * const warm = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);
 * const limiter = new QueuedLimiter(warm, { maxQueueDelayMs: 500 }, clock);
 * ```
 */
export class QueuedLimiter {
  private readonly scheduler: Scheduler;
  private readonly bounds: QueueBounds;
  private readonly queue: WaitQueue;

  /**
   * @param scheduler - Decides how long each caller waits.
   * @param options - The queue bounds. Defaults are documented in
   *   `pacing-constants.ts`.
   * @param clock - Must be the same clock the scheduler reads.
   * @throws RangeError if a bound is invalid.
   */
  constructor(scheduler: Scheduler, options: QueueOptions = {}, clock: Clock = new SystemClock()) {
    this.scheduler = scheduler;
    this.bounds = deriveQueueBounds(options);
    this.queue = new WaitQueue(clock, clock.now());
  }

  /** Callers currently waiting. Cancelled callers do not count. */
  get queueDepth(): number {
    return this.queue.depth;
  }

  /**
   * Reserves from the scheduler and resolves when the caller may proceed.
   *
   * @throws RangeError if `permits` or `timeoutMs` is invalid.
   * @throws RateLimitRejectedError if a bound refuses the caller, in which
   * case the scheduler is never asked to reserve.
   */
  async acquire(permits = 1, options: PaceOptions = {}): Promise<void> {
    const signal = options.signal;
    signal?.throwIfAborted();
    requirePositiveInteger('permits', permits);

    const timeoutMs = options.timeoutMs ?? Infinity;
    if (Number.isNaN(timeoutMs) || timeoutMs < 0) {
      throw new RangeError(`timeoutMs must be a non-negative number, got ${String(timeoutMs)}`);
    }

    // Peek, decide, and only then reserve: a refusal must leave no trace.
    checkBounds(
      this.scheduler.peekWaitMicros(permits),
      this.queueDepth,
      this.bounds,
      timeoutMs * 1000,
    );

    const waitMicros = this.scheduler.reserveMicros(permits);
    if (waitMicros <= 0) {
      return;
    }
    await this.queue.wait(waitMicros, signal);
  }
}
