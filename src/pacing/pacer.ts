import type { Clock } from '../clock/clock.js';
import { SystemClock } from '../clock/system-clock.js';
import { RateLimitRejectedError } from '../core/errors.js';
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

  /**
   * Acquires only if the limiter admits it, reporting refusal as a value.
   *
   * The rule across this package: `acquire` throws on refusal, `tryAcquire`
   * returns a boolean. Use this when a refusal is ordinary control flow; use
   * `acquire` when not getting a permit is exceptional, or `attempt` when you
   * need the reason to answer a client.
   *
   * Admitted callers still wait for their slot — pass `timeoutMs: 0` for a
   * purely non-blocking probe.
   *
   * @returns `true` once the caller may proceed, `false` if a bound refused
   * it. A refusal reserves nothing and leaves the queue untouched.
   * @throws RangeError for invalid arguments, or `options.signal.reason` if
   * cancelled — neither is a refusal, and reporting them as one would hide a
   * bug as backpressure.
   */
  async tryAcquire(permits = 1, options: PaceOptions = {}): Promise<boolean> {
    // Delegating keeps one implementation of the bounds, the precedence rule
    // and the queue policy: the two cannot drift apart.
    try {
      await this.acquire(permits, options);
      return true;
    } catch (error) {
      if (error instanceof RateLimitRejectedError) {
        return false;
      }
      throw error;
    }
  }

  private nowMicros(): number {
    return Number((this.clock.now() - this.originNanos) / 1000n);
  }
}
