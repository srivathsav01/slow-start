import type { Clock } from './clock.js';

/**
 * The real monotonic clock, for production use.
 *
 * Wraps `process.hrtime.bigint()`, which is unaffected by NTP corrections,
 * manual changes to the system time, or daylight saving. This is the only
 * place in the library allowed to read the real clock.
 */
export class SystemClock implements Clock {
  /** Current time in nanoseconds from an arbitrary origin. */
  now(): bigint {
    return process.hrtime.bigint();
  }
}
