import { setImmediate } from 'node:timers';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/clock/manual-clock.js';
import { RateLimitRejectedError } from '../../src/core/errors.js';
import type { Scheduler } from '../../src/core/scheduler.js';
import { QueuedLimiter } from '../../src/pacing/queued-limiter.js';
import { WarmupLimiter } from '../../src/warmup/warmup-limiter.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const micros = (value: number): bigint => BigInt(value) * 1000n;

function track<T>(promise: Promise<T>): { settled: boolean; rejected: unknown } {
  const state: { settled: boolean; rejected: unknown } = { settled: false, rejected: undefined };
  promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.rejected = error;
    },
  );
  return state;
}

/** A scheduler with hand-chosen waits, so the queue can be tested alone. */
class ScriptedScheduler implements Scheduler {
  reserved: number[] = [];
  peeked = 0;

  constructor(private readonly waitsMicros: number[]) {}

  peekWaitMicros(): number {
    this.peeked += 1;
    return this.waitsMicros[0] ?? 0;
  }

  reserveMicros(permits: number): number {
    this.reserved.push(permits);
    return this.waitsMicros.shift() ?? 0;
  }
}

describe('QueuedLimiter', () => {
  describe('with a scripted scheduler', () => {
    it('lets a caller through immediately when the wait is zero', async () => {
      const limiter = new QueuedLimiter(new ScriptedScheduler([0]), {}, new ManualClock());
      await limiter.acquire();
      expect(limiter.queueDepth).toBe(0);
    });

    it('holds a caller for exactly the wait the scheduler returned', async () => {
      const clock = new ManualClock();
      const limiter = new QueuedLimiter(new ScriptedScheduler([25_000]), {}, clock);
      const call = track(limiter.acquire());
      await flush();
      expect(limiter.queueDepth).toBe(1);

      clock.advance(micros(24_999));
      await flush();
      expect(call.settled).toBe(false);

      clock.advance(micros(1));
      await flush();
      expect(call.settled).toBe(true);
      expect(limiter.queueDepth).toBe(0);
    });

    it('passes the permit count through to the scheduler', async () => {
      const scheduler = new ScriptedScheduler([0, 0]);
      const limiter = new QueuedLimiter(scheduler, {}, new ManualClock());
      await limiter.acquire(7);
      await limiter.acquire(3);
      expect(scheduler.reserved).toEqual([7, 3]);
    });

    it('never asks the scheduler to reserve when a bound refuses', async () => {
      const scheduler = new ScriptedScheduler([2_000_000]);
      const limiter = new QueuedLimiter(scheduler, { maxQueueDelayMs: 100 }, new ManualClock());

      await expect(limiter.acquire()).rejects.toBeInstanceOf(RateLimitRejectedError);
      // Peeked, refused, and never reserved: no trace left behind.
      expect(scheduler.reserved).toEqual([]);
      expect(scheduler.peeked).toBe(1);
    });

    it('refuses when the queue is full', async () => {
      const scheduler = new ScriptedScheduler(Array.from({ length: 10 }, () => 500_000));
      const limiter = new QueuedLimiter(
        scheduler,
        { maxQueueDepth: 2, maxQueueDelayMs: 60_000 },
        new ManualClock(),
      );

      track(limiter.acquire());
      track(limiter.acquire());
      await flush();
      expect(limiter.queueDepth).toBe(2);

      const error = (await limiter.acquire().catch((e: unknown) => e)) as RateLimitRejectedError;
      expect(error.reason).toBe('depth');
    });

    it.each([0, -1, 1.5, NaN])('rejects permits = %s', async (permits) => {
      const limiter = new QueuedLimiter(new ScriptedScheduler([0]), {}, new ManualClock());
      await expect(limiter.acquire(permits)).rejects.toBeInstanceOf(RangeError);
    });
  });

  // Spec §9.5: warm-up decides the rate, the queue enforces the bounds.
  describe('composed with a WarmupLimiter', () => {
    function setup(options: { maxQueueDelayMs?: number; maxQueueDepth?: number } = {}): {
      clock: ManualClock;
      limiter: QueuedLimiter;
    } {
      const clock = new ManualClock();
      const warm = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);
      return { clock, limiter: new QueuedLimiter(warm, options, clock) };
    }

    it('paces callers at the warm-up rate, not a fixed one', async () => {
      const { clock, limiter } = setup({ maxQueueDelayMs: 60_000 });
      const first = track(limiter.acquire());
      const second = track(limiter.acquire());
      await flush();
      expect(first.settled).toBe(true);

      // Cold: the second caller owes ~29.93 ms, three times the warm rate.
      clock.advance(micros(29_933));
      await flush();
      expect(second.settled).toBe(false);

      clock.advance(micros(1));
      await flush();
      expect(second.settled).toBe(true);
    });

    it('speeds up as the limiter warms, which a fixed pacer would not', async () => {
      const { clock, limiter } = setup({ maxQueueDelayMs: 60_000 });
      const intervals: number[] = [];
      let now = 0;

      // Drain the cold pot with sustained demand, recording each gap.
      for (let i = 0; i < 200; i++) {
        const call = track(limiter.acquire());
        let waited = 0;
        while (!call.settled) {
          clock.advance(micros(100));
          waited += 100;
          await flush();
        }
        intervals.push(waited);
        now += waited;
      }

      const first = intervals[1] ?? 0;
      const last = intervals[intervals.length - 1] ?? 0;
      expect(first).toBeGreaterThan(25_000); // near the 30 ms cold interval
      expect(last).toBeLessThanOrEqual(10_100); // at the 10 ms warm interval
      expect(now).toBeGreaterThan(3_000_000); // the warm-up period elapsed
    });

    it('refuses callers the warm-up rate would make wait too long', async () => {
      const { limiter } = setup({ maxQueueDelayMs: 50 });
      await limiter.acquire(); // free
      track(limiter.acquire()); // ~29.9 ms, inside the bound

      // The third caller would wait ~59.7 ms, past the 50 ms bound.
      const error = (await limiter.acquire().catch((e: unknown) => e)) as RateLimitRejectedError;
      expect(error).toBeInstanceOf(RateLimitRejectedError);
      expect(error.reason).toBe('delay');
    });

    it('refuses at the standing bound even when the caller allows far longer', async () => {
      const { limiter } = setup({ maxQueueDelayMs: 50 });
      await limiter.acquire();
      track(limiter.acquire());

      const error = (await limiter
        .acquire(1, { timeoutMs: 60_000 })
        .catch((e: unknown) => e)) as RateLimitRejectedError;
      expect(error.reason).toBe('delay');
      expect(error.message).toContain('maxQueueDelayMs of 50ms');
    });

    it('forfeits a cancelled caller’s slot', async () => {
      const { clock, limiter } = setup({ maxQueueDelayMs: 60_000 });
      const controller = new AbortController();
      await limiter.acquire();

      const cancelled = track(limiter.acquire(1, { signal: controller.signal }));
      const after = track(limiter.acquire());
      controller.abort();
      await flush();
      expect(cancelled.settled).toBe(true);

      // The next caller keeps its own later slot rather than inheriting one.
      clock.advance(micros(29_934));
      await flush();
      expect(after.settled).toBe(false);

      clock.advance(micros(29_800));
      await flush();
      expect(after.settled).toBe(true);
    });
  });
});
