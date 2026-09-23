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
  }

  /** @throws RangeError if `permits` is not a positive safe integer. */
  private checkPermit(permits: number): void {
    if (permits <= 0 || !Number.isSafeInteger(permits)) {
      throw new RangeError(`permits must be a positive integer, got ${String(permits)}`);
    }
  }

  /**
   * Reserves `permits` now and returns how long the caller must wait before
   * using them, in microseconds. The first caller after an idle period waits
   * zero; the cost of their permits is paid by the next caller (spec §5.8).
   *
   * @throws RangeError if `permits` is not a positive safe integer.
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
   * @throws RangeError if `permits` is not a positive safe integer.
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
