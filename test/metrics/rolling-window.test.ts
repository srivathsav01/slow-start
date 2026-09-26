import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/clock/clock.js';
import { ManualClock } from '../../src/clock/manual-clock.js';
import { RollingWindow } from '../../src/metrics/rolling-window.js';
import type { WindowOptions } from '../../src/metrics/window-constants.js';

// A one-second window of twenty 50 ms buckets.
const OPTIONS = { windowMs: 1000 };

const OPTIONS_TYPED: WindowOptions = OPTIONS;

function setup(options: WindowOptions = OPTIONS_TYPED): {
  clock: ManualClock;
  window: RollingWindow;
} {
  const clock = new ManualClock();
  return { clock, window: new RollingWindow(options, clock) };
}

const micros = (value: number): bigint => BigInt(value) * 1000n;

describe('RollingWindow', () => {
  it('starts empty', () => {
    expect(setup().window.totals()).toEqual({ pass: 0, block: 0, error: 0 });
  });

  it('counts each kind separately', () => {
    const { window } = setup();
    window.record('pass');
    window.record('pass');
    window.record('block');
    window.record('error', 5);
    expect(window.totals()).toEqual({ pass: 2, block: 1, error: 5 });
  });

  it('keeps counts written to the same bucket together', () => {
    const { clock, window } = setup();
    window.record('pass');
    clock.advance(micros(49_999)); // still inside the first 50 ms bucket
    window.record('pass');
    expect(window.totals()).toEqual({ pass: 2, block: 0, error: 0 });
  });

  it('sums across buckets inside the window', () => {
    const { clock, window } = setup();
    for (let i = 0; i < 20; i++) {
      if (i > 0) clock.advance(micros(50_000)); // one bucket per step
      window.record('pass');
    }
    // Twenty writes in twenty buckets, spanning exactly one window. The last
    // write is not followed by an advance, so none has aged out yet.
    expect(window.totals().pass).toBe(20);
  });

  it('ages out counts after a full lap of the ring', () => {
    const { clock, window } = setup();
    window.record('pass');
    window.record('block');

    clock.advance(micros(999_999));
    expect(window.totals()).toEqual({ pass: 1, block: 1, error: 0 });

    clock.advance(micros(1)); // exactly one window later
    expect(window.totals()).toEqual({ pass: 0, block: 0, error: 0 });
  });

  it('drops only what has aged out, not the whole window', () => {
    const { clock, window } = setup();
    window.record('pass'); // bucket at t=0
    clock.advance(micros(500_000));
    window.record('pass'); // bucket at t=500,000

    clock.advance(micros(500_000)); // t=1,000,000: the first has aged out
    expect(window.totals().pass).toBe(1);

    clock.advance(micros(500_000)); // t=1,500,000: so has the second
    expect(window.totals().pass).toBe(0);
  });

  it('reuses a bucket rather than growing, over many laps', () => {
    const { clock, window } = setup();
    for (let lap = 0; lap < 50; lap++) {
      for (let bucket = 0; bucket < 20; bucket++) {
        window.record('pass');
        // Checked before advancing past the last bucket of the lap, when the
        // window holds exactly this lap's writes and none of the previous.
        if (bucket === 19) expect(window.totals().pass).toBe(20);
        clock.advance(micros(50_000));
      }
    }
  });

  it('wipes a stale bucket instead of adding to it', () => {
    const { clock, window } = setup();
    window.record('pass', 7); // bucket 0 at t=0

    clock.advance(micros(1_000_000)); // one lap: same index, new era
    window.record('pass'); // must reset, not accumulate
    expect(window.totals().pass).toBe(1);
  });

  it('counts a long idle gap as empty', () => {
    const { clock, window } = setup();
    window.record('pass', 3);
    clock.advance(micros(60_000_000)); // a minute of silence
    expect(window.totals()).toEqual({ pass: 0, block: 0, error: 0 });

    window.record('block');
    expect(window.totals()).toEqual({ pass: 0, block: 1, error: 0 });
  });

  it('works with a single bucket', () => {
    const { clock, window } = setup({ windowMs: 100, buckets: 1 });
    window.record('pass');
    clock.advance(micros(99_999));
    expect(window.totals().pass).toBe(1);
    clock.advance(micros(1));
    expect(window.totals().pass).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects count = %s', (count) => {
    const { window } = setup();
    expect(() => {
      window.record('pass', count);
    }).toThrow(RangeError);
    expect(window.totals()).toEqual({ pass: 0, block: 0, error: 0 });
  });

  it('refuses to blend two eras when the clock goes backwards', () => {
    // A Clock that lies. Monotonic clocks cannot do this, so a window that
    // silently accepted it would be mixing counts from different laps.
    class BackwardsClock implements Clock {
      // Origin, then forwards, then back to an earlier bucket.
      // 1.05 s and 50 ms map to the same bucket index one lap apart, which
      // is what makes the stored start newer than the computed one. Landing
      // in a different bucket would simply look like an unused one.
      private readonly readings = [0n, 1_050_000_000n, 50_000_000n];
      private index = 0;

      now(): bigint {
        const value = this.readings[Math.min(this.index, this.readings.length - 1)] ?? 0n;
        this.index += 1;
        return value;
      }

      sleep(): Promise<void> {
        return Promise.resolve();
      }
    }

    const window = new RollingWindow(OPTIONS, new BackwardsClock());
    window.record('pass');
    expect(() => {
      window.record('pass');
    }).toThrow('time went backwards');
  });

  describe('snapshot', () => {
    it('reports zeroes for an empty window, not NaN', () => {
      expect(setup().window.snapshot()).toEqual({
        pass: 0,
        block: 0,
        error: 0,
        total: 0,
        passPerSecond: 0,
        errorRatio: 0,
      });
    });

    it('counts decisions, and errors against them', () => {
      const { window } = setup();
      window.record('pass', 8);
      window.record('block', 2);
      expect(window.snapshot()).toMatchObject({ total: 10, passPerSecond: 8, errorRatio: 0 });

      window.record('error');
      expect(window.snapshot().errorRatio).toBeCloseTo(0.1, 10);
    });

    it('excludes errors from the total, since they happen to admitted requests', () => {
      const { window } = setup();
      window.record('pass', 3);
      window.record('block', 1);
      window.record('error', 3);
      // Four decisions were made, not seven.
      expect(window.snapshot().total).toBe(4);
    });

    it('scales the rate to the window length', () => {
      const half = new RollingWindow({ windowMs: 500 }, new ManualClock());
      half.record('pass', 50);
      // Fifty passes in half a second is one hundred per second.
      expect(half.snapshot().passPerSecond).toBe(100);

      const tenSeconds = new RollingWindow({ windowMs: 10_000, buckets: 100 }, new ManualClock());
      tenSeconds.record('pass', 50);
      expect(tenSeconds.snapshot().passPerSecond).toBe(5);
    });

    it('gives a zero ratio when nothing was decided, however many errors', () => {
      const { window } = setup();
      window.record('error', 3);
      const snapshot = window.snapshot();
      expect(snapshot.errorRatio).toBe(0);
      expect(Number.isNaN(snapshot.errorRatio)).toBe(false);
    });

    it('falls back to zero as counts age out', () => {
      const { clock, window } = setup();
      window.record('pass', 10);
      window.record('error', 1);
      expect(window.snapshot().passPerSecond).toBe(10);

      clock.advance(micros(1_000_000));
      expect(window.snapshot()).toEqual({
        pass: 0,
        block: 0,
        error: 0,
        total: 0,
        passPerSecond: 0,
        errorRatio: 0,
      });
    });

    it('agrees with totals()', () => {
      const { window } = setup();
      window.record('pass', 4);
      window.record('block', 6);
      window.record('error', 2);
      const { pass, block, error } = window.snapshot();
      expect({ pass, block, error }).toEqual(window.totals());
    });

    // Spec §10.1: a sum and a count cannot produce a percentile, so nothing
    // shaped like one may appear on this structure.
    it('offers no percentiles', () => {
      const window = setup().window as unknown as Record<string, unknown>;
      for (const name of ['p50', 'p95', 'p99', 'percentile', 'getP99', 'quantile']) {
        expect(window[name]).toBeUndefined();
      }
    });
  });

  it('measures from its own construction, not the clock origin', () => {
    const clock = new ManualClock();
    clock.advance(micros(7_000_000));
    const window = new RollingWindow(OPTIONS, clock);

    window.record('pass');
    clock.advance(micros(999_999));
    expect(window.totals().pass).toBe(1);
  });
});
