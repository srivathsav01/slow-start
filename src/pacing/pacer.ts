import type { Clock } from '../clock/clock.js';
import { SystemClock } from '../clock/system-clock.js';
import { requirePositiveInteger } from '../core/validation-helper.js';
import {
  derivePacingConstants,
  type PaceOptions,
  type PacerOptions,
  type PacingConstants,
} from './pacing-constants.js';
import { checkBounds, type PacingState, reserveSlot, waitForNextSlotMicros } from './slot.js';
import { WaitQueue } from './wait-queue.js';

/**
 * A virtual-slot pacer: it smooths bursts by spacing callers evenly, and
 * refuses rather than queueing without limit (spec §9).
 *
 * Scheduling state is one timestamp whatever the load; waiting callers are
 * held by a {@link WaitQueue} served by a single timer.
 */
export class Pacer {
  private readonly clock: Clock;
  private readonly originNanos: bigint;
  private readonly constants: PacingConstants;
  private readonly state: PacingState = { nextSlotMicros: 0 };
  private readonly queue: WaitQueue;

  /**
   * @throws RangeError if any option is invalid (see `derivePacingConstants`).
   */
  constructor(options: PacerOptions, clock: Clock = new SystemClock()) {
    this.constants = derivePacingConstants(options);
    this.clock = clock;
    this.originNanos = clock.now();
    this.queue = new WaitQueue(clock, this.originNanos);
  }

  /** Callers currently waiting. Cancelled callers do not count. */
  get queueDepth(): number {
    return this.queue.depth;
  }

  /**
   * Takes the next slot and resolves when it arrives.
   *
   * @throws RangeError if `permits` or `timeoutMs` is invalid.
   * @throws RateLimitRejectedError if a bound refuses the caller, in which
   * case nothing is reserved and the slot does not move.
   */
  async acquire(permits = 1, options: PaceOptions = {}): Promise<void> {
    const signal = options.signal;
    signal?.throwIfAborted();
    requirePositiveInteger('permits', permits);

    const timeoutMs = options.timeoutMs ?? Infinity;
    if (Number.isNaN(timeoutMs) || timeoutMs < 0) {
      throw new RangeError(`timeoutMs must be a non-negative number, got ${String(timeoutMs)}`);
    }

    const now = this.nowMicros();
    // Decide before reserving: a refused caller must leave no trace (§8.2).
    checkBounds(
      waitForNextSlotMicros(this.state, now),
      this.queueDepth,
      this.constants,
      timeoutMs * 1000,
    );

    const waitMicros = reserveSlot(this.state, this.constants, permits, now);
    if (waitMicros <= 0) {
      return;
    }
    await this.queue.wait(waitMicros, signal);
  }

  private nowMicros(): number {
    return Number((this.clock.now() - this.originNanos) / 1000n);
  }
}
