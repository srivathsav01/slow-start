import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/clock/manual-clock.js';
import { deriveConstants, type WarmupOptions } from '../../src/warmup/constants.js';
import { SmoothWarmingUp } from '../../src/warmup/smooth-warming-up.js';
import type { WarmupState } from '../../src/warmup/state.js';
import { expectWithin } from '../helpers/expect-within.js';
import { loadGoldenConfig, loadGoldenVectors } from '../helpers/golden-vectors.js';

// The verified configuration: stable 10000 µs, cold 30000 µs, threshold 150,
// max 300, warm-up 3,000,000 µs.
const OPTIONS: WarmupOptions = { permitsPerSecond: 100, warmupPeriodMs: 3000, coldFactor: 3 };
const C = deriveConstants(OPTIONS);
const TOLERANCE = 1e-6;

function setup(): { clock: ManualClock; limiter: SmoothWarmingUp } {
  const clock = new ManualClock();
  return { clock, limiter: new SmoothWarmingUp(OPTIONS, clock) };
}

function micros(value: number): bigint {
  return BigInt(value) * 1000n;
}

/**
 * Simulates callers that each wait out their full wait before the next one
 * arrives, and returns the grant times in microseconds.
 *
 * The clock moves in whole microseconds, matching the limiter's own
 * resolution, so `now + wait` is exactly the grant time.
 */
function sustainedDemand(clock: ManualClock, limiter: SmoothWarmingUp, calls: number): number[] {
  const grants: number[] = [];
  let now = 0;
  for (let i = 0; i < calls; i++) {
    const wait = limiter.reserve();
    grants.push(now + wait);
    const step = Math.ceil(wait);
    clock.advance(micros(step));
    now += step;
  }
  return grants;
}

describe('SmoothWarmingUp', () => {
  describe('construction', () => {
    it('starts fully cold', () => {
      expect(setup().limiter.snapshot()).toEqual({ storedPermits: 300, nextFreeTicketMicros: 0 });
    });

    it('measures time from its own construction, not from the clock origin', () => {
      const clock = new ManualClock();
      clock.advance(micros(7_000_000));
      const limiter = new SmoothWarmingUp(OPTIONS, clock);
      expect(limiter.reserve()).toBe(0);
      expectWithin(limiter.reserve(), 29_933 + 1 / 3, TOLERANCE);
    });

    it('rejects invalid options', () => {
      expect(() => new SmoothWarmingUp({ ...OPTIONS, coldFactor: 1 }, new ManualClock())).toThrow(
        RangeError,
      );
    });
  });

  it('replays all golden vectors on a ManualClock', () => {
    const config = loadGoldenConfig();
    const { clock, limiter } = setup();
    const { timeMicros, permits } = config.tolerance;
    let clockMicros = 0;

    for (const vector of loadGoldenVectors()) {
      const at = `step ${String(vector.step)} (${vector.exercises})`;
      clock.advance(micros(vector.nowMicros - clockMicros));
      clockMicros = vector.nowMicros;

      const grant = vector.nowMicros + limiter.reserve(vector.permits);
      const state = limiter.snapshot();

      expect.soft(Math.abs(grant - vector.expectGrantMicros), `${at}: grant`).toBeLessThanOrEqual(
        timeMicros,
      );
      expect
        .soft(Math.abs(state.storedPermits - vector.expectStoredAfter), `${at}: stored after`)
        .toBeLessThanOrEqual(permits);
      expect
        .soft(
          Math.abs(state.nextFreeTicketMicros - vector.expectNextFreeMicros),
          `${at}: next free after`,
        )
        .toBeLessThanOrEqual(timeMicros);
    }
  });

  describe('reserve', () => {
    it('reserves one permit by default', () => {
      const { limiter } = setup();
      limiter.reserve();
      expect(limiter.snapshot().storedPermits).toBe(299);
    });

    it('gives three synchronous calls strictly increasing waits', () => {
      const { limiter } = setup();
      const waits = [limiter.reserve(), limiter.reserve(), limiter.reserve()];
      expect(waits[0]).toBe(0);
      expect(waits[1]).toBeGreaterThan(0);
      expect(waits[2]).toBeGreaterThan(waits[1] ?? Infinity);
    });

    it('ignores time below one microsecond', () => {
      const { clock, limiter } = setup();
      limiter.reserve();
      clock.advance(999n);
      // 999 ns rounds down to 0 µs, so the second caller still waits the full cost.
      expectWithin(limiter.reserve(), 29_933 + 1 / 3, TOLERANCE);
    });

    it('takes n exactly equal to the stored permits', () => {
      const { limiter } = setup();
      expect(limiter.reserve(300)).toBe(0);
      expect(limiter.snapshot().storedPermits).toBe(0);
      // Trapezoid (3,000,000) + rectangle (150 × 10,000).
      expectWithin(limiter.reserve(), 4_500_000, TOLERANCE);
    });

    it('takes n far beyond maxPermits, charging fresh permits at the stable interval', () => {
      const { limiter } = setup();
      expect(limiter.reserve(1_000)).toBe(0);
      expect(limiter.snapshot().storedPermits).toBe(0);
      expectWithin(limiter.reserve(), 4_500_000 + 700 * 10_000, TOLERANCE);
    });

    describe('rejects invalid permits and leaves the state unchanged', () => {
      it.each([0, -1, 1.5, NaN, Infinity, -Infinity, 2 ** 53])('%s', (permits) => {
        const { clock, limiter } = setup();
        limiter.reserve();
        clock.advance(micros(5_000));
        const before = limiter.snapshot();

        expect(() => limiter.reserve(permits)).toThrow(
          `permits must be a positive integer, got ${String(permits)}`,
        );
        expect(() => limiter.reserve(permits)).toThrow(RangeError);
        expect(limiter.snapshot()).toEqual(before);
      });
    });
  });

  describe('peekWaitMicros', () => {
    it('returns what reserve would return', () => {
      const { clock, limiter } = setup();
      limiter.reserve(40);
      clock.advance(micros(250_000));
      expect(limiter.peekWaitMicros(7)).toBe(limiter.reserve(7));
    });

    it('leaves the state untouched, however often it is called', () => {
      const { limiter } = setup();
      const before = limiter.snapshot();
      for (let i = 0; i < 100; i++) limiter.peekWaitMicros(50);
      expect(limiter.snapshot()).toEqual(before);
    });

    it('peeks one permit by default', () => {
      const { limiter } = setup();
      expect(limiter.peekWaitMicros()).toBe(limiter.peekWaitMicros(1));
    });

    it.each([0, -1, 1.5, NaN, 2 ** 53])('rejects %s', (permits) => {
      const { limiter } = setup();
      expect(() => limiter.peekWaitMicros(permits)).toThrow(RangeError);
    });
  });

  describe('snapshot', () => {
    it('returns a copy that cannot change the limiter', () => {
      const { limiter } = setup();
      const copy: WarmupState = limiter.snapshot();
      copy.storedPermits = 0;
      copy.nextFreeTicketMicros = 123;
      expect(limiter.snapshot()).toEqual({ storedPermits: 300, nextFreeTicketMicros: 0 });
    });
  });

  // Spec §12.1 and §5.9.
  describe('warm-up behaviour', () => {
    it('starts close to stableRate / coldFactor', () => {
      const { clock, limiter } = setup();
      const grants = sustainedDemand(clock, limiter, 2);
      const firstInterval = (grants[1] ?? 0) - (grants[0] ?? 0);
      // Within 1% of the cold interval (30,000 µs): 3 × slower than stable.
      expect(Math.abs(firstInterval - C.coldIntervalMicros) / C.coldIntervalMicros).toBeLessThan(
        0.01,
      );
    });

    it('ramps without jumps and reaches stableRate after the warm-up period', () => {
      const { clock, limiter } = setup();
      const grants = sustainedDemand(clock, limiter, 400);

      const intervals = grants.slice(1).map((grant, i) => grant - (grants[i] ?? 0));
      for (let i = 1; i < intervals.length; i++) {
        // Never slower than the previous permit: continuous through the threshold.
        expect(intervals[i]).toBeLessThanOrEqual((intervals[i - 1] ?? 0) + TOLERANCE);
      }

      // The 150 permits above the threshold take exactly the warm-up period.
      expectWithin(grants[150] ?? 0, 3_000_000, 1);
      for (const [i, interval] of intervals.entries()) {
        if ((grants[i] ?? 0) >= 3_000_000) {
          expectWithin(interval, C.stableIntervalMicros, TOLERANCE);
        }
      }
    });

    it('re-cools fully after a warm-up period of idleness', () => {
      const { clock, limiter } = setup();
      limiter.reserve(300); // Empty the pot; the timeline now ends at 4,500,000 µs.
      clock.advance(micros(4_500_000 + 3_000_000));
      expect(limiter.reserve()).toBe(0);
      expectWithin(limiter.snapshot().storedPermits, 299, TOLERANCE);
    });

    it('re-cools partly after half a warm-up period of idleness', () => {
      const { clock, limiter } = setup();
      limiter.reserve(300);
      clock.advance(micros(4_500_000 + 1_500_000));
      limiter.reserve();
      expectWithin(limiter.snapshot().storedPermits, 149, TOLERANCE);
    });

    it('does not gain permits while the clock stands still', () => {
      const { limiter } = setup();
      for (let i = 0; i < 50; i++) limiter.reserve();
      expect(limiter.snapshot().storedPermits).toBe(250);
    });
  });

  describe('invariants', () => {
    // A fixed, varied script: bursts, idle gaps shorter and longer than the
    // warm-up period, and requests larger than maxPermits.
    const SCRIPT: readonly (readonly [advanceMicros: number, permits: number])[] = [
      [0, 1], [0, 5], [12_345, 1], [0, 40], [250_000, 3], [7, 1], [3_100_000, 1],
      [0, 150], [0, 1], [900_000, 20], [1, 1], [0, 500], [10_000_000, 2], [0, 299],
      [33_333, 1], [0, 1], [1_500_000, 75], [0, 1],
    ];

    function run(): { waits: number[]; states: WarmupState[] } {
      const { clock, limiter } = setup();
      const waits: number[] = [];
      const states: WarmupState[] = [limiter.snapshot()];
      for (const [advance, permits] of SCRIPT) {
        clock.advance(micros(advance));
        waits.push(limiter.reserve(permits));
        states.push(limiter.snapshot());
      }
      return { waits, states };
    }

    it('keeps storedPermits within [0, maxPermits] and nextFreeTicket non-decreasing', () => {
      const { waits, states } = run();
      for (const [i, state] of states.entries()) {
        expect(state.storedPermits).toBeGreaterThanOrEqual(0);
        expect(state.storedPermits).toBeLessThanOrEqual(C.maxPermits);
        if (i > 0) {
          expect(state.nextFreeTicketMicros).toBeGreaterThanOrEqual(
            states[i - 1]?.nextFreeTicketMicros ?? Infinity,
          );
        }
      }
      // Never granted before now.
      for (const wait of waits) expect(wait).toBeGreaterThanOrEqual(0);
    });

    it('produces identical output for the same clock script', () => {
      expect(run()).toEqual(run());
    });
  });
});
