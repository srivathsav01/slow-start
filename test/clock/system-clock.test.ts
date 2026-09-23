import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/clock/clock.js';
import { SystemClock } from '../../src/clock/system-clock.js';

describe('SystemClock', () => {
  it('satisfies the Clock interface', () => {
    const clock: Clock = new SystemClock();
    expect(typeof clock.now()).toBe('bigint');
  });

  it('never goes backwards across successive readings', () => {
    const clock = new SystemClock();
    let previous = clock.now();
    for (let i = 0; i < 1_000; i++) {
      const current = clock.now();
      // Greater than or equal: two readings can legitimately be identical.
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  // The only tests in the suite that use real time. Kept to a few
  // milliseconds, and they assert only "never early", which a slow CI
  // machine cannot break.
  describe('sleep', () => {
    it('never resolves before the requested time has passed', async () => {
      const clock = new SystemClock();
      for (const nanos of [1n, 500_000n, 1_000_000n, 2_300_000n, 20_000_000n]) {
        const start = clock.now();
        await clock.sleep(nanos);
        expect(clock.now() - start).toBeGreaterThanOrEqual(nanos);
      }
    });

    it('rejects an already-aborted sleep immediately', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(new SystemClock().sleep(10_000_000_000n, controller.signal)).rejects.toThrow();
    });

    it('rejects with the abort reason while waiting, without waiting it out', async () => {
      const clock = new SystemClock();
      const controller = new AbortController();
      const reason = new Error('caller gave up');
      const start = clock.now();

      // A one-hour sleep, cancelled a tick later.
      const sleep = clock.sleep(3_600_000_000_000n, controller.signal);
      setTimeout(() => {
        controller.abort(reason);
      }, 1);

      await expect(sleep).rejects.toBe(reason);
      expect(clock.now() - start).toBeLessThan(1_000_000_000n);
    });

    it('stops listening to the signal once it resolves', async () => {
      const clock = new SystemClock();
      const controller = new AbortController();
      for (let i = 0; i < 5; i++) {
        await clock.sleep(1_000_000n, controller.signal);
      }
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    it.each([0n, -1n])('resolves before any timer runs for %sn', async (nanos) => {
      const clock = new SystemClock();
      let timerRan = false;
      const timer = setTimeout(() => {
        timerRan = true;
      }, 0);
      await clock.sleep(nanos);
      clearTimeout(timer);
      expect(timerRan).toBe(false);
    });
  });
});
