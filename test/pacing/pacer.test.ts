import { getEventListeners } from 'node:events';
import { setImmediate } from 'node:timers';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/clock/manual-clock.js';
import { RateLimitRejectedError } from '../../src/core/errors.js';
import { Pacer } from '../../src/pacing/pacer.js';
import type { PacerOptions } from '../../src/pacing/pacing-constants.js';

const OPTIONS: PacerOptions = { permitsPerSecond: 100 }; // one permit per 10,000 us

function setup(options: PacerOptions = OPTIONS): { clock: ManualClock; pacer: Pacer } {
  const clock = new ManualClock();
  return { clock, pacer: new Pacer(options, clock) };
}

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

describe('Pacer', () => {
  describe('pacing', () => {
    it('admits the first caller immediately without queueing', async () => {
      const { pacer } = setup();
      await pacer.acquire();
      expect(pacer.queueDepth).toBe(0);
    });

    it('queues concurrent callers and releases them one interval apart', async () => {
      const { clock, pacer } = setup();
      const calls = [track(pacer.acquire()), track(pacer.acquire()), track(pacer.acquire())];
      await flush();

      expect(calls.map((c) => c.settled)).toEqual([true, false, false]);
      expect(pacer.queueDepth).toBe(2);

      clock.advance(micros(10_000));
      await flush();
      expect(calls.map((c) => c.settled)).toEqual([true, true, false]);
      expect(pacer.queueDepth).toBe(1);

      clock.advance(micros(10_000));
      await flush();
      expect(calls.every((c) => c.settled)).toBe(true);
      expect(pacer.queueDepth).toBe(0);
    });

    it('releases callers in arrival order', async () => {
      const { clock, pacer } = setup();
      const order: number[] = [];
      const calls = [1, 2, 3, 4, 5].map((n) => pacer.acquire().then(() => order.push(n)));

      clock.advance(micros(1_000_000));
      await Promise.all(calls);
      expect(order).toEqual([1, 2, 3, 4, 5]);
    });

    it('never releases a caller before its slot', async () => {
      const { clock, pacer } = setup();
      void pacer.acquire();
      const second = track(pacer.acquire());

      clock.advance(micros(9_999));
      await flush();
      expect(second.settled).toBe(false);

      clock.advance(micros(1));
      await flush();
      expect(second.settled).toBe(true);
    });

    it('charges one interval per permit', async () => {
      const { clock, pacer } = setup();
      await pacer.acquire(5);
      const next = track(pacer.acquire());

      clock.advance(micros(49_999));
      await flush();
      expect(next.settled).toBe(false);

      clock.advance(micros(1));
      await flush();
      expect(next.settled).toBe(true);
    });

    it('does not bank idle time', async () => {
      const { clock, pacer } = setup();
      clock.advance(micros(10_000_000)); // ten seconds of quiet
      await pacer.acquire();
      const second = track(pacer.acquire());
      await flush();
      // A token bucket would admit a burst here; a pacer admits one and paces.
      expect(second.settled).toBe(false);
    });
  });

  describe('bounds', () => {
    it('refuses a caller whose wait exceeds maxQueueDelayMs', async () => {
      const { pacer } = setup({ permitsPerSecond: 100, maxQueueDelayMs: 25 });
      await pacer.acquire(); // immediate; the slot moves to 10 ms
      track(pacer.acquire()); // waits 10 ms — inside the bound, so it queues
      track(pacer.acquire()); // waits 20 ms — still inside

      // This one would wait 30 ms, past the 25 ms bound.
      await expect(pacer.acquire()).rejects.toBeInstanceOf(RateLimitRejectedError);
    });

    it('refuses with reason delay and reports the wait', async () => {
      const { pacer } = setup({ permitsPerSecond: 100, maxQueueDelayMs: 15 });
      await pacer.acquire();
      void pacer.acquire();
      const error = (await pacer.acquire().catch((e: unknown) => e)) as RateLimitRejectedError;
      expect(error.reason).toBe('delay');
      expect(error.waitMs).toBe(20);
    });

    it('a zero timeout succeeds only while a slot is free now', async () => {
      const { clock, pacer } = setup();
      await expect(pacer.acquire(1, { timeoutMs: 0 })).resolves.toBeUndefined();
      await expect(pacer.acquire(1, { timeoutMs: 0 })).rejects.toBeInstanceOf(
        RateLimitRejectedError,
      );

      clock.advance(micros(10_000));
      await expect(pacer.acquire(1, { timeoutMs: 0 })).resolves.toBeUndefined();
    });

    // The precedence rule, pinned down: a per-call timeout may only tighten.
    it('refuses at the standing bound even when the caller allows far longer', async () => {
      const { pacer } = setup({ permitsPerSecond: 100, maxQueueDelayMs: 1000 });
      // Fill 1.5 seconds of timeline, well past the 1 s standing bound.
      await pacer.acquire(150);

      const error = (await pacer
        .acquire(1, { timeoutMs: 60_000 })
        .catch((e: unknown) => e)) as RateLimitRejectedError;

      expect(error).toBeInstanceOf(RateLimitRejectedError);
      expect(error.reason).toBe('delay');
      expect(error.message).toContain('maxQueueDelayMs of 1000ms');
      expect(error.message).not.toContain('60000');
    });

    it('refuses when the queue is full', async () => {
      const { pacer } = setup({ permitsPerSecond: 1000, maxQueueDepth: 3, maxQueueDelayMs: 60_000 });
      await pacer.acquire();
      const queued = [track(pacer.acquire()), track(pacer.acquire()), track(pacer.acquire())];
      await flush();
      expect(pacer.queueDepth).toBe(3);

      const error = (await pacer.acquire().catch((e: unknown) => e)) as RateLimitRejectedError;
      expect(error.reason).toBe('depth');
      expect(queued.every((c) => !c.settled)).toBe(true);
    });

    it('changes nothing when it refuses', async () => {
      const { clock, pacer } = setup({ permitsPerSecond: 100, maxQueueDelayMs: 15 });
      await pacer.acquire();

      for (let i = 0; i < 20; i++) {
        await expect(pacer.acquire(1, { timeoutMs: 0 })).rejects.toBeInstanceOf(
          RateLimitRejectedError,
        );
      }

      // Twenty refusals did not move the slot: the next caller still waits
      // exactly the one interval the first caller imposed.
      clock.advance(micros(10_000));
      await expect(pacer.acquire(1, { timeoutMs: 0 })).resolves.toBeUndefined();
    });

    it.each([0, -1, 1.5, NaN, Infinity])('rejects permits = %s', async (permits) => {
      const { pacer } = setup();
      await expect(pacer.acquire(permits)).rejects.toBeInstanceOf(RangeError);
    });

    it.each([-1, NaN])('rejects timeoutMs = %s', async (timeoutMs) => {
      const { pacer } = setup();
      await expect(pacer.acquire(1, { timeoutMs })).rejects.toThrow('timeoutMs must be');
    });
  });

  describe('cancellation', () => {
    it('reserves nothing when the signal is already aborted', async () => {
      const { pacer } = setup();
      const controller = new AbortController();
      controller.abort();

      await expect(pacer.acquire(1, { signal: controller.signal })).rejects.toThrow();
      // The slot never moved: the next caller goes immediately.
      await expect(pacer.acquire(1, { timeoutMs: 0 })).resolves.toBeUndefined();
    });

    it('rejects a queued caller with the abort reason and forfeits its slot', async () => {
      const { clock, pacer } = setup();
      const controller = new AbortController();
      const reason = new Error('caller left');
      await pacer.acquire(); // takes the slot at 0; the next slot is 10 ms

      const cancelled = pacer.acquire(1, { signal: controller.signal }); // grant at 10 ms
      const after = track(pacer.acquire()); // grant at 20 ms
      controller.abort(reason);
      await expect(cancelled).rejects.toBe(reason);

      // The forfeited 10 ms slot is not handed to the next caller: it still
      // waits for its own 20 ms grant, not a microsecond earlier.
      clock.advance(micros(19_999));
      await flush();
      expect(after.settled).toBe(false);

      clock.advance(micros(1));
      await flush();
      expect(after.settled).toBe(true);
    });

    it('skips tombstones when draining', async () => {
      const { clock, pacer } = setup();
      const controller = new AbortController();
      await pacer.acquire();
      const cancelled = track(pacer.acquire(1, { signal: controller.signal }));
      const live = track(pacer.acquire());

      controller.abort();
      await flush();
      expect(cancelled.settled).toBe(true);
      expect(pacer.queueDepth).toBe(1);

      clock.advance(micros(30_000));
      await flush();
      expect(live.settled).toBe(true);
      expect(pacer.queueDepth).toBe(0);
    });

    it('stops listening to the signal once a caller is released', async () => {
      const { clock, pacer } = setup();
      const controller = new AbortController();
      await pacer.acquire();

      for (let i = 0; i < 5; i++) {
        const call = pacer.acquire(1, { signal: controller.signal });
        clock.advance(micros(10_000));
        await call;
      }
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    it('lets the queue empty when every caller aborts', async () => {
      const { pacer } = setup();
      const controller = new AbortController();
      await pacer.acquire();
      const calls = [
        track(pacer.acquire(1, { signal: controller.signal })),
        track(pacer.acquire(1, { signal: controller.signal })),
      ];

      controller.abort();
      await flush();
      expect(calls.every((c) => c.settled)).toBe(true);
      expect(pacer.queueDepth).toBe(0);
    });
  });

  describe('the queue itself', () => {
    it('serves a long burst with one timer, in order, at the right pace', async () => {
      // Bounds raised deliberately: with the defaults, the 200th caller would
      // be two seconds out and refused, which the bounds tests cover.
      const { clock, pacer } = setup({
        permitsPerSecond: 100,
        maxQueueDelayMs: 60_000,
        maxQueueDepth: 500,
      });
      const released: number[] = [];
      const calls = Array.from({ length: 200 }, (_, index) =>
        pacer.acquire().then(() => released.push(index)),
      );

      // Release them one interval at a time; the timer must re-arm each time.
      for (let i = 0; i < 200; i++) {
        clock.advance(micros(10_000));
        await flush();
      }

      await Promise.all(calls);
      expect(released).toEqual(Array.from({ length: 200 }, (_, index) => index));
      expect(pacer.queueDepth).toBe(0);
    });

    // Spec §9.4: one timer for the head is sufficient, because grant times
    // are non-decreasing. This is the claim, so it gets measured.
    it('holds at most one live timer however many callers are queued', async () => {
      class CountingClock extends ManualClock {
        live = 0;
        maxLive = 0;
        total = 0;

        override async sleep(nanos: bigint, signal?: AbortSignal): Promise<void> {
          this.live += 1;
          this.total += 1;
          this.maxLive = Math.max(this.maxLive, this.live);
          try {
            await super.sleep(nanos, signal);
          } finally {
            this.live -= 1;
          }
        }
      }

      const clock = new CountingClock();
      const pacer = new Pacer(
        { permitsPerSecond: 100, maxQueueDelayMs: 60_000, maxQueueDepth: 500 },
        clock,
      );

      const calls = Array.from({ length: 100 }, () => track(pacer.acquire()));
      await flush();
      expect(pacer.queueDepth).toBe(99);
      expect(clock.maxLive).toBe(1);

      for (let i = 0; i < 100; i++) {
        clock.advance(micros(10_000));
        await flush();
      }

      expect(calls.every((c) => c.settled)).toBe(true);
      expect(clock.maxLive).toBe(1);
      // One sleep per drain, not one per caller.
      expect(clock.total).toBeLessThanOrEqual(101);
    });

    // Invariant 8 under tight spacing. At 10 ms apart, a drain that releases
    // a millisecond or two early overtakes nobody and goes unnoticed; at 1 ms
    // apart it releases the next caller early immediately.
    it('releases nobody early when grants are only 1 ms apart', async () => {
      const clock = new ManualClock();
      const pacer = new Pacer(
        { permitsPerSecond: 1000, maxQueueDelayMs: 60_000, maxQueueDepth: 1000 },
        clock,
      );

      const calls = Array.from({ length: 20 }, () => track(pacer.acquire()));
      await flush();

      for (let index = 1; index < calls.length; index++) {
        const grantMicros = index * 1000;
        clock.advance(micros(grantMicros - 1) - clock.now());
        await flush();
        expect(calls[index]?.settled, `caller ${String(index)} at ${String(grantMicros)} us`).toBe(
          false,
        );

        clock.advance(micros(1));
        await flush();
        expect(calls[index]?.settled).toBe(true);
      }
    });

    it('releases everyone due when the clock jumps past several slots', async () => {
      const { clock, pacer } = setup();
      const calls = Array.from({ length: 10 }, () => track(pacer.acquire()));
      await flush();

      clock.advance(micros(45_000)); // covers slots at 10k..40k
      await flush();
      expect(calls.filter((c) => c.settled)).toHaveLength(5);

      clock.advance(micros(1_000_000));
      await flush();
      expect(calls.every((c) => c.settled)).toBe(true);
    });

    it('keeps working after the queue empties and fills again', async () => {
      const { clock, pacer } = setup();
      for (let round = 0; round < 3; round++) {
        const calls = [track(pacer.acquire()), track(pacer.acquire())];
        clock.advance(micros(20_000));
        await flush();
        expect(calls.every((c) => c.settled)).toBe(true);
        expect(pacer.queueDepth).toBe(0);
      }
    });
  });
});
