import type { Clock } from '../clock/clock.js';
import { SystemClock } from '../clock/system-clock.js';
import type { Scheduler } from '../core/scheduler.js';
import type { WarmupOptions } from './constants.js';
import { SmoothWarmingUp } from './smooth-warming-up.js';

/** Per-call options. */
export interface AcquireOptions {
  /**
   * Cancels the call. Aborting before the call reserves nothing; aborting
   * while waiting **forfeits** the permits, because the timeline has already
   * moved and later callers are waiting on it (spec §8.3).
   */
  readonly signal?: AbortSignal;
}

/** What an acquisition cost, returned once the caller may proceed. */
export interface AcquireResult {
  /** Time actually waited, measured by the clock. Includes timer lateness. */
  readonly waitedMs: number;
  /** Permits left in the pot immediately after this reservation. */
  readonly storedPermitsAfter: number;
}

/**
 * A rate limiter that warms up: it admits slowly when cold and reaches its
 * configured rate after the warm-up period of sustained demand.
 */
export class WarmupLimiter implements Scheduler {
  private readonly clock: Clock;
  private readonly machine: SmoothWarmingUp;

  /**
   * @param options - Rate, warm-up period and optional cold factor.
   * @param clock - Time source. Tests pass a `ManualClock`.
   * @throws RangeError if any option is invalid.
   */
  constructor(options: WarmupOptions, clock: Clock = new SystemClock()) {
    this.clock = clock;
    this.machine = new SmoothWarmingUp(options, clock);
  }

  /**
   * Reserves `permits` and resolves once the caller may use them.
   *
   * The reservation is synchronous: it completes before this method's first
   * `await`, so concurrent callers each get their own slot on the timeline
   * (spec §7.2).
   *
   * @returns A promise rejecting with a `RangeError` if `permits` is not a
   * positive safe integer or is too large for this rate, or with
   * `options.signal.reason` if cancelled.
   */
  async acquire(permits = 1, options: AcquireOptions = {}): Promise<AcquireResult> {
    // Before reserving: an already-cancelled caller spends nothing.
    options.signal?.throwIfAborted();

    const start = this.clock.now();
    const waitMicros = this.machine.reserveMicros(permits);
    const storedPermitsAfter = this.machine.snapshot().storedPermits;

    // Round up: waiting a little longer is allowed, waking early is not.
    // Cancelling here rejects and forfeits the reservation, by design.
    await this.clock.sleep(BigInt(Math.ceil(waitMicros * 1000)), options.signal);

    return {
      waitedMs: Number(this.clock.now() - start) / 1_000_000,
      storedPermitsAfter,
    };
  }

  /**
   * Acquires `permits` only if the wait fits within `timeoutMs`.
   *
   * On refusal nothing changes: no reservation is made and the timeline does
   * not move, so repeated failing probes cannot starve real callers (§8.2).
   * A timeout of `0` is the non-blocking probe; the default waits forever.
   *
   * @returns The result, or `false` if the wait would exceed the timeout.
   * Rejects with a `RangeError` if `permits` or `timeoutMs` is invalid.
   */
  async tryAcquire(
    permits = 1,
    timeoutMs = Infinity,
    options: AcquireOptions = {},
  ): Promise<AcquireResult | false> {
    options.signal?.throwIfAborted();
    if (Number.isNaN(timeoutMs) || timeoutMs < 0) {
      throw new RangeError(`timeoutMs must be a non-negative number, got ${String(timeoutMs)}`);
    }

    const wouldWaitMicros = this.machine.peekWaitMicros(permits);
    if (wouldWaitMicros > timeoutMs * 1000) {
      return false;
    }
    return this.acquire(permits, options);
  }

  /**
   * The wait `reserveMicros` would impose right now, in microseconds, without
   * reserving anything.
   *
   * @throws RangeError if `permits` is invalid.
   */
  peekWaitMicros(permits = 1): number {
    return this.machine.peekWaitMicros(permits);
  }

  /**
   * Reserves `permits` synchronously and returns the wait in microseconds,
   * without waiting it out.
   *
   * Use this to do the waiting yourself — inside a queue of your own, or
   * outside a transaction — and to compose this limiter with a
   * {@link Scheduler} consumer such as the pacer's queue.
   *
   * @throws RangeError if `permits` is invalid.
   */
  reserveMicros(permits = 1): number {
    return this.machine.reserveMicros(permits);
  }
}
