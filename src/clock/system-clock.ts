import type { Clock } from './clock.js';

/** The longest delay `setTimeout` honours; longer ones fire after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

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

  /**
   * Waits at least `nanos` by this clock. Usually resolves up to about 1 ms
   * late, because timers have millisecond resolution; never early.
   *
   * @param signal - Aborting it rejects this sleep with `signal.reason` and
   *   cancels the pending timer, so it cannot keep the process alive.
   */
  async sleep(nanos: bigint, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const wakeAt = this.now() + nanos;

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Replaced below when there is a signal to unsubscribe from.
      let cleanup = (): void => undefined;

      const check = (): void => {
        const remaining = wakeAt - this.now();
        if (remaining <= 0n) {
          cleanup();
          resolve();
          return;
        }
        // Timers keep their own millisecond clock and can fire slightly early
        // by hrtime, and long delays are capped, so recheck and sleep again
        // for whatever is left.
        const delayMs = Math.min(Math.ceil(Number(remaining) / 1_000_000), MAX_TIMEOUT_MS);
        timer = setTimeout(check, delayMs);
      };

      if (signal) {
        const onAbort = (): void => {
          clearTimeout(timer);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- `reason` is whatever the caller passed to abort(); the AbortSignal convention is to propagate it unchanged.
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup = (): void => {
          signal.removeEventListener('abort', onAbort);
        };
      }

      check();
    });
  }
}
