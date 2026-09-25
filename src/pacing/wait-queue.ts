import type { Clock } from '../clock/clock.js';

/** A caller waiting for its grant. Cancelled entries stay as tombstones. */
interface QueueEntry {
  grantMicros: number;
  resolve: () => void;
  cancelled: boolean;
}

/**
 * Holds callers until their wait elapses, using a **single** timer armed for
 * the head of the queue (spec §9.4).
 *
 * It knows nothing about rates, slots or bounds: it is told how long a caller
 * must wait and holds them for exactly that long. Deciding *whether* a caller
 * may queue is policy, and stays with whoever owns the bounds.
 *
 * One timer is sufficient as long as callers are enqueued with non-decreasing
 * grant times, which every scheduler here guarantees.
 */
export class WaitQueue {
  private readonly clock: Clock;
  private readonly originNanos: bigint;

  private queue: QueueEntry[] = [];
  private head = 0;
  private waiting = 0;
  private armed: AbortController | undefined;

  /**
   * @param clock - The time source; also used to sleep.
   * @param originNanos - The owner's time origin, so both agree on "now".
   */
  constructor(clock: Clock, originNanos: bigint) {
    this.clock = clock;
    this.originNanos = originNanos;
  }

  /** Callers currently waiting. Cancelled callers do not count. */
  get depth(): number {
    return this.waiting;
  }

  /**
   * Resolves once `waitMicros` have elapsed.
   *
   * @param signal - Aborting rejects with `signal.reason`. The caller keeps
   *   its place as a tombstone: the slot is forfeited, not reassigned (§8.3).
   */
  async wait(waitMicros: number, signal?: AbortSignal): Promise<void> {
    const entry: QueueEntry = {
      grantMicros: this.nowMicros() + waitMicros,
      resolve: () => undefined,
      cancelled: false,
    };

    const promise = new Promise<void>((resolve, reject) => {
      if (!signal) {
        entry.resolve = resolve;
        return;
      }

      const onAbort = (): void => {
        entry.cancelled = true;
        this.waiting -= 1;
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- `reason` is whatever the caller passed to abort(); the AbortSignal convention is to propagate it unchanged.
        reject(signal.reason);
        if (this.waiting === 0) {
          this.reset();
        }
      };

      signal.addEventListener('abort', onAbort, { once: true });
      // Unsubscribe on the way out, or a long-lived controller keeps every
      // finished caller's closure alive.
      entry.resolve = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
    });

    this.queue.push(entry);
    this.waiting += 1;
    this.arm();
    await promise;
  }

  /** Arms one timer for the head of the queue, if none is armed already. */
  private arm(): void {
    if (this.armed) {
      return;
    }
    const entry = this.queue[this.head];
    if (!entry) {
      return;
    }

    const controller = new AbortController();
    this.armed = controller;
    const waitNanos = BigInt(Math.ceil(Math.max(0, entry.grantMicros - this.nowMicros()) * 1000));

    // clock.sleep, not setTimeout: it already refuses to resolve early (§7.4)
    // and it keeps the queue deterministic under a ManualClock.
    void this.clock.sleep(waitNanos, controller.signal).then(
      () => {
        this.armed = undefined;
        this.drain();
      },
      () => {
        // Aborted because the queue emptied; nothing left to release.
        this.armed = undefined;
      },
    );
  }

  /** Releases everyone now due, then re-arms for whoever is left. */
  private drain(): void {
    const now = this.nowMicros();

    while (this.head < this.queue.length) {
      const entry = this.queue[this.head];
      // The timer says "probably due"; the clock says whether it really is.
      if (!entry || entry.grantMicros > now) {
        break;
      }
      this.head += 1;
      if (!entry.cancelled) {
        this.waiting -= 1;
        entry.resolve();
      }
    }

    if (this.head >= this.queue.length) {
      this.queue = [];
      this.head = 0;
    } else if (this.head > this.queue.length / 2) {
      // Compact rather than shift(): shift() reindexes the whole array.
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }

    this.arm();
  }

  /** Drops an all-tombstone queue and cancels the timer holding it open. */
  private reset(): void {
    this.queue = [];
    this.head = 0;
    this.armed?.abort();
    this.armed = undefined;
  }

  private nowMicros(): number {
    return Number((this.clock.now() - this.originNanos) / 1000n);
  }
}

