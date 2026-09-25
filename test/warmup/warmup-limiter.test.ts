import { setImmediate } from 'node:timers';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/clock/manual-clock.js';
import type { Scheduler } from '../../src/core/scheduler.js';
import type { WarmupOptions } from '../../src/warmup/constants.js';
import { WarmupLimiter } from '../../src/warmup/warmup-limiter.js';

const OPTIONS: WarmupOptions = { permitsPerSecond: 100, warmupPeriodMs: 3000, coldFactor: 3 };

function setup(): { clock: ManualClock; limiter: WarmupLimiter } {
  const clock = new ManualClock();
  return { clock, limiter: new WarmupLimiter(OPTIONS, clock) };
}

/** Lets resolved promises run their callbacks without advancing time. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function track<T>(promise: Promise<T>): { readonly settled: boolean; readonly result: T | undefined } {
  const state: { settled: boolean; result: T | undefined } = { settled: false, result: undefined };
  void promise.then((result) => {
    state.settled = true;
    state.result = result;
  });
  return state;
}

describe('WarmupLimiter', () => {
  describe('acquire', () => {
    it('resolves the first caller immediately, even when cold', async () => {
      const { limiter } = setup();
      const result = await limiter.acquire();
      expect(result).toEqual({ waitedMs: 0, storedPermitsAfter: 299 });
    });

    it('makes the next caller pay the previous caller’s bill', async () => {
      const { clock, limiter } = setup();
      await limiter.acquire();

      const second = track(limiter.acquire());
      await flush();
      expect(second.settled).toBe(false);

      // Golden step 2: the wait is 29,933.33 µs, rounded up to 29,934 µs.
      clock.advance(29_933_000n);
      await flush();
      expect(second.settled).toBe(false);

      clock.advance(1_000n);
      await flush();
      expect(second.settled).toBe(true);
      expect(second.result?.storedPermitsAfter).toBe(298);
      expect(second.result?.waitedMs).toBeCloseTo(29.934, 6);
    });

    it('gives three concurrent callers three increasing slots (spec §7.1)', async () => {
      const { clock, limiter } = setup();
      const a = track(limiter.acquire());
      const b = track(limiter.acquire());
      const c = track(limiter.acquire());

      // All three reservations happened synchronously, in call order.
      await flush();
      expect([a.settled, b.settled, c.settled]).toEqual([true, false, false]);
      expect(a.result?.storedPermitsAfter).toBe(299);

      clock.advance(29_934_000n);
      await flush();
      expect([b.settled, c.settled]).toEqual([true, false]);
      expect(b.result?.storedPermitsAfter).toBe(298);

      clock.advance(29_800_000n);
      await flush();
      expect(c.settled).toBe(true);
      expect(c.result?.storedPermitsAfter).toBe(297);
    });

    it('resolves callers in the order they arrived', async () => {
      const { clock, limiter } = setup();
      const order: number[] = [];
      const calls = [1, 2, 3, 4, 5].map((n) => limiter.acquire().then(() => order.push(n)));

      clock.advance(1_000_000_000n);
      await Promise.all(calls);
      expect(order).toEqual([1, 2, 3, 4, 5]);
    });

    it('takes one permit by default', async () => {
      const { limiter } = setup();
      expect((await limiter.acquire()).storedPermitsAfter).toBe(299);
    });

    it('allows more permits than the pot holds', async () => {
      const { clock, limiter } = setup();
      const big = track(limiter.acquire(1_000));
      await flush();
      expect(big.settled).toBe(true);
      expect(big.result?.storedPermitsAfter).toBe(0);

      // 4,500,000 µs to drain the pot, plus 700 fresh permits at 10,000 µs.
      const next = track(limiter.acquire());
      clock.advance(11_499_999_000n);
      await flush();
      expect(next.settled).toBe(false);

      clock.advance(1_000n);
      await flush();
      expect(next.settled).toBe(true);
      expect(next.result?.waitedMs).toBeCloseTo(11_500, 6);
    });

    it('reports the wait it actually incurred, including lateness', async () => {
      const { clock, limiter } = setup();
      await limiter.acquire();
      const late = track(limiter.acquire());

      // The clock jumps well past the grant time; the report reflects that.
      clock.advance(50_000_000n);
      await flush();
      expect(late.result?.waitedMs).toBe(50);
    });

    describe('rejects invalid permit counts', () => {
      it.each([0, -1, 1.5, NaN, Infinity, 2 ** 53])('%s', async (permits) => {
        const { limiter } = setup();
        await expect(limiter.acquire(permits)).rejects.toThrow(RangeError);
        // The failed call left the timeline untouched.
        expect((await limiter.acquire()).waitedMs).toBe(0);
      });

      it('rejects rather than throwing synchronously', () => {
        const { limiter } = setup();
        // Would throw here, before returning a promise, if acquire were not async.
        const promise = limiter.acquire(0);
        expect(promise).toBeInstanceOf(Promise);
        return expect(promise).rejects.toBeInstanceOf(RangeError);
      });
    });
  });

  describe('tryAcquire', () => {
    it('succeeds with a zero timeout only while a permit is free right now', async () => {
      const { limiter } = setup();
      expect(await limiter.tryAcquire(1, 0)).toEqual({ waitedMs: 0, storedPermitsAfter: 299 });
      // The next caller owes about 29.93 ms, so the probe refuses.
      expect(await limiter.tryAcquire(1, 0)).toBe(false);
    });

    it('refuses immediately when the wait exceeds the timeout', async () => {
      const { limiter } = setup();
      await limiter.acquire();
      const probe = track(limiter.tryAcquire(1, 20));
      await flush();
      // Refused without waiting out the 20 ms budget first.
      expect(probe.settled).toBe(true);
      expect(probe.result).toBe(false);
    });

    it('waits when the wait fits inside the timeout', async () => {
      const { clock, limiter } = setup();
      await limiter.acquire();
      const probe = track(limiter.tryAcquire(1, 30));

      clock.advance(29_933_000n);
      await flush();
      expect(probe.settled).toBe(false);

      clock.advance(1_000n);
      await flush();
      expect(probe.result).toEqual({ waitedMs: 29.934, storedPermitsAfter: 298 });
    });

    it('waits as long as needed when no timeout is given', async () => {
      const { clock, limiter } = setup();
      await limiter.acquire(300);
      const probe = track(limiter.tryAcquire());

      clock.advance(4_500_000_000n);
      await flush();
      expect(probe.result).toEqual({ waitedMs: 4_500, storedPermitsAfter: 0 });
    });

    describe('changes nothing when it refuses', () => {
      it('leaves the timeline where a failing probe found it', async () => {
        const { clock, limiter } = setup();
        await limiter.acquire();

        for (let i = 0; i < 50; i++) {
          expect(await limiter.tryAcquire(1, 1)).toBe(false);
        }

        // Still exactly the second caller's bill, unchanged by 50 probes.
        const next = track(limiter.acquire());
        clock.advance(29_933_000n);
        await flush();
        expect(next.settled).toBe(false);

        clock.advance(1_000n);
        await flush();
        expect(next.result?.storedPermitsAfter).toBe(298);
      });

      it('refuses a large request without spending the pot', async () => {
        const { clock, limiter } = setup();
        // The very first caller waits zero however large the request, so the
        // probe has to come after someone has put debt on the timeline.
        await limiter.acquire();
        expect(await limiter.tryAcquire(1_000, 10)).toBe(false);
        expect(await limiter.tryAcquire(1_000, 0)).toBe(false);
        // The pot still holds 299: the next caller takes it to 298, and waits
        // only the second caller's bill rather than a drained pot's.
        const next = track(limiter.acquire());
        clock.advance(29_934_000n);
        await flush();
        expect(next.result?.storedPermitsAfter).toBe(298);
      });
    });

    it('rejects an invalid timeout', async () => {
      const { limiter } = setup();
      for (const timeoutMs of [-1, NaN, -Infinity]) {
        await expect(limiter.tryAcquire(1, timeoutMs)).rejects.toThrow(
          `timeoutMs must be a non-negative number, got ${String(timeoutMs)}`,
        );
      }
      // The failed calls did not reserve anything.
      expect((await limiter.acquire()).storedPermitsAfter).toBe(299);
    });

    it('rejects an invalid permit count', async () => {
      const { limiter } = setup();
      await expect(limiter.tryAcquire(0, 5)).rejects.toThrow(RangeError);
      await expect(limiter.tryAcquire(1.5)).rejects.toThrow(RangeError);
    });
  });

  // Spec §8.3: cancelling stops you waiting; it does not return the permit.
  describe('cancellation', () => {
    it('reserves nothing when the signal is already aborted', async () => {
      const { clock, limiter } = setup();
      const controller = new AbortController();
      controller.abort();

      await expect(limiter.acquire(1, { signal: controller.signal })).rejects.toThrow();

      // The timeline never moved, so the next caller is still the first one.
      const next = track(limiter.acquire());
      await flush();
      expect(next.result).toEqual({ waitedMs: 0, storedPermitsAfter: 299 });
      expect(clock.now()).toBe(0n);
    });

    it('rejects with the abort reason when cancelled while waiting', async () => {
      const { limiter } = setup();
      const controller = new AbortController();
      const reason = new Error('request timed out');
      await limiter.acquire();

      const cancelled = limiter.acquire(1, { signal: controller.signal });
      controller.abort(reason);
      await expect(cancelled).rejects.toBe(reason);
    });

    it('forfeits the permit: the timeline keeps the cancelled reservation', async () => {
      const { clock, limiter } = setup();
      const controller = new AbortController();
      await limiter.acquire(); // Grant 1: next free ticket at 29,933.33 µs.

      // Grant 2 is reserved, then abandoned. Its cost stays on the timeline.
      const cancelled = limiter.acquire(1, { signal: controller.signal });
      controller.abort();
      await expect(cancelled).rejects.toThrow();

      // The next caller waits for grant 3, not grant 2.
      const next = track(limiter.acquire());
      clock.advance(59_733_000n);
      await flush();
      expect(next.settled).toBe(false);

      clock.advance(1_000n);
      await flush();
      expect(next.result?.storedPermitsAfter).toBe(297);
    });

    it('does nothing when the signal aborts after the call resolved', async () => {
      const { limiter } = setup();
      const controller = new AbortController();
      const result = await limiter.acquire(1, { signal: controller.signal });

      controller.abort();
      await flush();
      expect(result.storedPermitsAfter).toBe(299);
    });

    it('cancels a tryAcquire that is waiting', async () => {
      const { limiter } = setup();
      const controller = new AbortController();
      await limiter.acquire();

      const probe = limiter.tryAcquire(1, 60, { signal: controller.signal });
      controller.abort();
      await expect(probe).rejects.toThrow();
    });

    it('rejects tryAcquire when the signal is already aborted', async () => {
      const { limiter } = setup();
      const controller = new AbortController();
      controller.abort();
      await expect(limiter.tryAcquire(1, 0, { signal: controller.signal })).rejects.toThrow();
    });
  });

  // The seam that lets the pacer's queue hold warm-up callers (spec §9.5).
  describe('as a Scheduler', () => {
    it('satisfies the interface', () => {
      const scheduler: Scheduler = new WarmupLimiter(OPTIONS, new ManualClock());
      expect(typeof scheduler.peekWaitMicros(1)).toBe('number');
      expect(typeof scheduler.reserveMicros(1)).toBe('number');
    });

    it('peeks without moving the timeline', async () => {
      const { limiter } = setup();
      const peeked = [limiter.peekWaitMicros(), limiter.peekWaitMicros(), limiter.peekWaitMicros()];
      expect(peeked).toEqual([0, 0, 0]);
      // Three peeks changed nothing: the first caller still goes immediately.
      expect((await limiter.acquire()).waitedMs).toBe(0);
    });

    it('reserves without waiting, moving the timeline exactly as acquire does', () => {
      const { clock, limiter } = setup();
      expect(limiter.reserveMicros()).toBe(0);

      // Reserved synchronously: the caller waits however it likes, or not yet.
      const waitMicros = limiter.reserveMicros();
      expect(waitMicros).toBeCloseTo(29_933.333, 2);

      // Wait it out by hand; the timeline is where the golden trace says.
      // The clock lands at 29,933,334 ns, which the limiter reads as 29,933
      // whole microseconds, so the next caller owes the remainder to 59,733.
      clock.advance(BigInt(Math.ceil(waitMicros * 1000)));
      expect(limiter.peekWaitMicros()).toBeCloseTo(59_733.333 - 29_933, 2);
    });

    it('defaults to one permit', () => {
      const { limiter } = setup();
      expect(limiter.peekWaitMicros()).toBe(limiter.peekWaitMicros(1));
    });

    it.each([0, -1, 1.5, NaN])('rejects permits = %s', (permits) => {
      const { limiter } = setup();
      expect(() => limiter.peekWaitMicros(permits)).toThrow(RangeError);
      expect(() => limiter.reserveMicros(permits)).toThrow(RangeError);
    });
  });

  it('defaults to a real clock when none is given', async () => {
    const limiter = new WarmupLimiter({ permitsPerSecond: 1_000_000, warmupPeriodMs: 1 });
    const result = await limiter.acquire();
    // Measured against real time, so it is small but not exactly zero.
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
    expect(result.waitedMs).toBeLessThan(50);
  });

  it('rejects invalid options at construction', () => {
    expect(() => new WarmupLimiter({ permitsPerSecond: 0, warmupPeriodMs: 1 })).toThrow(RangeError);
  });
});
