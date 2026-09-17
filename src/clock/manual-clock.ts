import type { Clock } from './clock.js';

/**
 * A clock that moves only when told to, for deterministic tests.
 *
 * Starts at `0n` and changes only through {@link ManualClock.advance}.
 * Reading it never moves time forward.
 */
export class ManualClock implements Clock {
  private nanos = 0n;

  /** Current time in nanoseconds since this clock was created. */
  now(): bigint {
    return this.nanos;
  }

  /**
   * Moves time forward.
   *
   * @param nanos - How far to move, in **nanoseconds**. `0n` is allowed.
   * @throws RangeError if `nanos` is negative. Time is left unchanged,
   *   because a `Clock` must never go backwards.
   */
  advance(nanos: bigint): void {
    if (nanos < 0n) {
      throw new RangeError(`ManualClock cannot move backwards: advance(${nanos}n)`);
    }
    this.nanos += nanos;
  }
}
