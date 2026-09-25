// The SmoothWarmingUp state machine, after Google Guava's
// SmoothRateLimiter.SmoothWarmingUp (Apache-2.0) and Alibaba Sentinel's
// WarmUpController (Apache-2.0), which made coldFactor configurable.

import type { Clock } from '../clock/clock.js';
import { deriveConstants, type WarmupConstants, type WarmupOptions } from './constants.js';
import { reserve } from './reserve.js';
import type { WarmupState } from './state.js';

/**
 * The synchronous SmoothWarmingUp state machine, driven by a {@link Clock}.
 *
 * Time is kept internally as whole microseconds since construction, stored in
 * a `number`. That is exact for about 285 years of uptime (spec §6).
 */
export class SmoothWarmingUp {
  private readonly clock: Clock;
  private readonly originNanos: bigint;
  private readonly constants: WarmupConstants;
  private readonly state: WarmupState;
  private readonly maxPermitsPerCall: number;

  /**
   * @throws RangeError if any option is invalid (see `deriveConstants`).
   */
  constructor(options: WarmupOptions, clock: Clock) {
    this.constants = deriveConstants(options);
    this.clock = clock;
    this.originNanos = clock.now();
    // A new limiter starts fully cold.
    this.state = {
      storedPermits: this.constants.maxPermits,
      nextFreeTicketMicros: 0,
    };
    // The largest request whose cost is still exact in whole microseconds.
    //
    // Permits taken from the pot cost more than the stable interval, so the
    // stored part is subtracted as headroom first: draining a full pot always
    // costs 1.5 × the warm-up period — the trapezoid above the threshold is
    // exactly the warm-up period, the rectangle below it exactly half.
    // At least 1, so an extremely slow rate cannot reject every call.
    const warmupPeriodMicros =
      this.constants.coolDownIntervalMicros * this.constants.maxPermits;
    this.maxPermitsPerCall = Math.max(
      1,
      Math.floor(
        (Number.MAX_SAFE_INTEGER - 1.5 * warmupPeriodMicros) / this.constants.stableIntervalMicros,
      ),
    );
  }

  /**
   * @throws RangeError if `permits` is not a positive safe integer, or is
   * large enough that its cost would not be representable exactly.
   */
  private checkPermit(permits: number): void {
    if (permits <= 0 || !Number.isSafeInteger(permits)) {
      throw new RangeError(`permits must be a positive integer, got ${String(permits)}`);
    }
    if (permits > this.maxPermitsPerCall) {
      throw new RangeError(
        `permits must be at most ${String(this.maxPermitsPerCall)} at this rate, got ${String(permits)}`,
      );
    }
  }

  /**
   * Reserves `permits` now and returns how long the caller must wait before
   * using them, in microseconds. The first caller after an idle period waits
   * zero; the cost of their permits is paid by the next caller (spec §5.8).
   *
   * @throws RangeError if `permits` is not a positive safe integer, or is
   * too large for its cost to be exact at this rate.
   */
  reserve(permits = 1): number {
    this.checkPermit(permits);
    const now = this.nowMicros();
    const grant = reserve(this.state, this.constants, permits, now);
    return grant - now;
  }

  /**
   * The wait `reserve(permits)` would return if called now, without changing
   * any state. Used by `tryAcquire`, which must not move the timeline when it
   * decides to refuse (spec §8.2).
   *
   * @throws RangeError if `permits` is not a positive safe integer, or is
   * too large for its cost to be exact at this rate.
   */
  peekWaitMicros(permits = 1): number {
    this.checkPermit(permits);
    const now = this.nowMicros();
    const copy = { ...this.state };
    return reserve(copy, this.constants, permits, now) - now;
  }

  /** A copy of the current state, for inspection. Changing it has no effect. */
  snapshot(): WarmupState {
    return { ...this.state };
  }

  private nowMicros(): number {
    return Number((this.clock.now() - this.originNanos) / 1000n);
  }
}
