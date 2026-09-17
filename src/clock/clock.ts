/**
 * A source of monotonic time.
 *
 * Every time-dependent part of the library reads time through a `Clock`
 * rather than calling the system clock directly, so tests can substitute
 * a `ManualClock` and control time exactly.
 */
export interface Clock {
  /**
   * Current time in **nanoseconds**, measured from an arbitrary fixed origin.
   *
   * Never decreases between calls. The absolute value has no meaning;
   * only the difference between two readings does.
   */
  now(): bigint;
}
