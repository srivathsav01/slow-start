import type { Clock } from './clock.js';

type SleepQueueEntry = {
  wakeAt: bigint;
  resolve: () => void;
};

/**
 * A clock that moves only when told to, for deterministic tests.
 *
 * Starts at `0n` and changes only through {@link ManualClock.advance}.
 * Reading it never moves time forward.
 */
export class ManualClock implements Clock {
  private nanos = 0n;
  private sleepQueue: Array<SleepQueueEntry> = [];

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

    // Remove due sleepers before waking them, and wake them in time order.
    const [ready, remaining] = this.sleepQueue.reduce<[SleepQueueEntry[], SleepQueueEntry[]]>(
      (acc, element) => {
        if (element.wakeAt <= this.nanos) {
          acc[0].push(element);
        } else {
          acc[1].push(element);
        }
        return acc;
      },
      [[], []],
    );

    this.sleepQueue = remaining;
    ready.sort((a, b) => (a.wakeAt < b.wakeAt ? -1 : a.wakeAt > b.wakeAt ? 1 : 0));
    for (const entry of ready) {
      entry.resolve();
    }
  }

  /**
   * Resolves when {@link ManualClock.advance} moves time to at least `nanos`
   * past now. Sleepers woken by the same `advance` resolve in wake-time
   * order, ties in the order they started sleeping.
   *
   * @param signal - Aborting it rejects this sleep with `signal.reason` and
   *   drops the sleeper from the queue. An already-aborted signal rejects
   *   without ever queueing.
   */
  async sleep(nanos: bigint, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (nanos <= 0n) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      // Replaced below when there is a signal to unsubscribe from.
      let cleanup = (): void => undefined;

      const entry: SleepQueueEntry = {
        wakeAt: this.nanos + nanos,
        resolve: () => {
          cleanup();
          resolve();
        },
      };

      if (signal) {
        const onAbort = (): void => {
          this.sleepQueue = this.sleepQueue.filter((queued) => queued !== entry);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- `reason` is whatever the caller passed to abort(); the AbortSignal convention is to propagate it unchanged.
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // Without this, a long-lived controller would hold on to every
        // finished sleeper's closure.
        cleanup = (): void => {
          signal.removeEventListener('abort', onAbort);
        };
      }

      this.sleepQueue.push(entry);
    });
  }
}
