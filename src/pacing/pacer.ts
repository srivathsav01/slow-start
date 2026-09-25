import type { Clock } from '../clock/clock.js';
import { SystemClock } from '../clock/system-clock.js';
import { requirePositiveInteger } from '../core/validation-helper.js';
import {
  derivePacingConstants,
  type PacerOptions,
  type PacingConstants,
} from './pacing-constants.js';
import { checkBounds, type PacingState, reserveSlot, waitForNextSlotMicros } from './slot.js';

/** A caller waiting for its slot. Cancelled entries stay as tombstones. */
interface QueueEntry {
  grantMicros: number;
  resolve: () => void;
  cancelled: boolean;
}

/** Per-call options. */
export interface PaceOptions {
  /** Cancels the call. A queued caller that aborts forfeits its slot (§8.3). */
  signal?: AbortSignal;
  /**
   * This caller's own budget. It may only **tighten** `maxQueueDelayMs`,
   * never extend past it, so no call can opt out of the standing bound.
   */
  timeoutMs?: number;
}

/**
 * A virtual-slot pacer: it smooths bursts by spacing callers evenly, and
 * refuses rather than queueing without limit (spec §9).
 *
 * Scheduling state is one timestamp whatever the load. Waiting callers are
 * held in a FIFO served by a **single** timer armed for the queue head, which
 * is sufficient because grant times are non-decreasing (§9.4).
 */
export class Pacer {
  private readonly clock: Clock;
  private readonly originNanos: bigint;
  private readonly constants: PacingConstants;
  private readonly state: PacingState = { nextSlotMicros: 0 };

  private queue: QueueEntry[] = [];
  private head = 0;
  private waiting = 0;
  private armed: AbortController | undefined;

  /**
   * @throws RangeError if any option is invalid (see `derivePacingConstants`).
   */
  constructor(options: PacerOptions, clock: Clock = new SystemClock()) {
    this.constants = derivePacingConstants(options);
    this.clock = clock;
    this.originNanos = clock.now();
  }

  /** Callers currently waiting. Cancelled callers do not count. */
  get queueDepth(): number {
    return this.waiting;
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

    const entry: QueueEntry = {
      grantMicros: now + waitMicros,
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
    // and it keeps the pacer deterministic under a ManualClock.
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
