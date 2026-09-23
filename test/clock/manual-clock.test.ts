import { getEventListeners } from 'node:events';
import { setImmediate } from 'node:timers';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/clock/clock.js';
import { ManualClock } from '../../src/clock/manual-clock.js';

describe('ManualClock', () => {
  it('satisfies the Clock interface', () => {
    // Checked by the type checker: this line stops compiling if
    // ManualClock no longer matches Clock.
    const clock: Clock = new ManualClock();
    expect(clock.now()).toBe(0n);
  });

  it('starts at zero', () => {
    expect(new ManualClock().now()).toBe(0n);
  });

  it('advances by exactly the amount given', () => {
    const clock = new ManualClock();
    clock.advance(1_500n);
    expect(clock.now()).toBe(1_500n);
  });

  it('accumulates successive advances', () => {
    const clock = new ManualClock();
    clock.advance(100n);
    clock.advance(250n);
    clock.advance(1_000_000_000n);
    expect(clock.now()).toBe(1_000_000_350n);
  });

  it('does not move on its own', () => {
    const clock = new ManualClock();
    clock.advance(42n);
    expect(clock.now()).toBe(clock.now());
    expect(clock.now()).toBe(42n);
  });

  it('allows advancing by zero', () => {
    const clock = new ManualClock();
    clock.advance(42n);
    clock.advance(0n);
    expect(clock.now()).toBe(42n);
  });

  it('rejects a negative advance and leaves time unchanged', () => {
    const clock = new ManualClock();
    clock.advance(42n);
    expect(() => {
      clock.advance(-1n);
    }).toThrow(RangeError);
    expect(clock.now()).toBe(42n);
  });

  describe('sleep', () => {
    // Lets every already-resolved promise run its callbacks. A macrotask runs
    // only after all pending microtasks, so this cannot finish too early.
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    function track(promise: Promise<void>): { done: boolean } {
      const state = { done: false };
      void promise.then(() => {
        state.done = true;
      });
      return state;
    }

    it('stays pending until time reaches the wake time', async () => {
      const clock = new ManualClock();
      const sleep = track(clock.sleep(100n));
      await flush();
      expect(sleep.done).toBe(false);

      clock.advance(99n);
      await flush();
      expect(sleep.done).toBe(false);

      clock.advance(1n);
      await flush();
      expect(sleep.done).toBe(true);
    });

    it.each([0n, -5n])('resolves without any advance for %sn', async (nanos) => {
      const clock = new ManualClock();
      const sleep = track(clock.sleep(nanos));
      await flush();
      expect(sleep.done).toBe(true);
    });

    it('counts from the moment sleep is called', async () => {
      const clock = new ManualClock();
      clock.advance(50n);
      const sleep = track(clock.sleep(100n));

      clock.advance(50n);
      await flush();
      expect(sleep.done).toBe(false);

      clock.advance(100n);
      await flush();
      expect(sleep.done).toBe(true);
    });

    it('wakes sleepers passed by one advance in wake-time order', async () => {
      const clock = new ManualClock();
      const woken: string[] = [];
      const sleeps = [
        clock.sleep(300n).then(() => woken.push('300')),
        clock.sleep(100n).then(() => woken.push('100')),
        clock.sleep(200n).then(() => woken.push('200')),
      ];

      clock.advance(1_000n);
      await Promise.all(sleeps);
      expect(woken).toEqual(['100', '200', '300']);
    });

    it('wakes sleepers with the same wake time in the order they started', async () => {
      const clock = new ManualClock();
      const woken: string[] = [];
      const sleeps = ['a', 'b', 'c'].map((name) => clock.sleep(10n).then(() => woken.push(name)));

      clock.advance(10n);
      await Promise.all(sleeps);
      expect(woken).toEqual(['a', 'b', 'c']);
    });

    it('wakes only the sleepers that are due', async () => {
      const clock = new ManualClock();
      const early = track(clock.sleep(10n));
      const late = track(clock.sleep(20n));

      clock.advance(15n);
      await flush();
      expect(early.done).toBe(true);
      expect(late.done).toBe(false);

      clock.advance(5n);
      await flush();
      expect(late.done).toBe(true);
    });

    describe('cancellation', () => {
      it('rejects an already-aborted sleep without queueing it', async () => {
        const clock = new ManualClock();
        const controller = new AbortController();
        controller.abort();

        await expect(clock.sleep(100n, controller.signal)).rejects.toThrow(
          controller.signal.reason as Error,
        );
        // Nothing was queued, so advancing past the wake time wakes nobody.
        expect(() => {
          clock.advance(1_000n);
        }).not.toThrow();
      });

      it('rejects with the abort reason while waiting', async () => {
        const clock = new ManualClock();
        const controller = new AbortController();
        const reason = new Error('caller gave up');
        const sleep = clock.sleep(100n, controller.signal);

        controller.abort(reason);
        await expect(sleep).rejects.toBe(reason);
      });

      it('leaves other sleepers alone when one is cancelled', async () => {
        const clock = new ManualClock();
        const controller = new AbortController();
        const cancelled = clock.sleep(100n, controller.signal);
        const other = track(clock.sleep(100n));

        controller.abort();
        await expect(cancelled).rejects.toThrow();

        clock.advance(100n);
        await flush();
        expect(other.done).toBe(true);
      });

      it('ignores an abort that arrives after the sleeper woke', async () => {
        const clock = new ManualClock();
        const controller = new AbortController();
        const sleep = clock.sleep(10n, controller.signal);

        clock.advance(10n);
        await expect(sleep).resolves.toBeUndefined();

        controller.abort();
        await flush();
      });

      it('stops listening to the signal once the sleeper wakes', async () => {
        const clock = new ManualClock();
        const controller = new AbortController();
        for (let i = 0; i < 5; i++) {
          const sleep = clock.sleep(10n, controller.signal);
          clock.advance(10n);
          await sleep;
        }
        // Every finished sleep unsubscribed, so nothing is left listening.
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      });

      it('resolves a zero-length sleep even with a live signal', async () => {
        const clock = new ManualClock();
        const controller = new AbortController();
        await expect(clock.sleep(0n, controller.signal)).resolves.toBeUndefined();
      });
    });

    it('does not wake anyone when an advance is rejected', async () => {
      const clock = new ManualClock();
      const sleep = track(clock.sleep(10n));
      expect(() => {
        clock.advance(-1n);
      }).toThrow(RangeError);
      await flush();
      expect(sleep.done).toBe(false);
    });
  });
});
