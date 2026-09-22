import { describe, it } from 'vitest';
import { deriveConstants } from '../../src/warmup/constants.js';
import { storedPermitsToWaitTime } from '../../src/warmup/cost.js';
import { expectWithin } from '../helpers/expect-within.js';

// The verified configuration: threshold 150, max 300, stable 10000, cold 30000.
const constants = deriveConstants({ permitsPerSecond: 100, warmupPeriodMs: 3000, coldFactor: 3 });
const TOLERANCE = 1e-6;

describe('storedPermitsToWaitTime', () => {
  describe('matches hand-computed costs', () => {
    it.each([
      { why: 'taking nothing is free', stored: 300, take: 0, expected: 0 },
      { why: 'below the threshold every permit costs the stable interval', stored: 100, take: 50, expected: 500_000 },
      { why: 'the single most expensive permit', stored: 300, take: 1, expected: 29_933 + 1 / 3 },
      { why: 'the whole trapezoid costs the warm-up period', stored: 300, take: 150, expected: 3_000_000 },
      { why: 'a take that crosses the threshold pays for both parts', stored: 200, take: 100, expected: 1_166_666 + 2 / 3 },
      { why: 'emptying a full pot costs trapezoid plus rectangle', stored: 300, take: 300, expected: 4_500_000 },
      { why: 'exactly at the threshold is all flat', stored: 150, take: 10, expected: 100_000 },
    ])('$why', ({ stored, take, expected }) => {
      expectWithin(storedPermitsToWaitTime(constants, stored, take), expected, TOLERANCE);
    });
  });

  // The curve's height at a point, computed independently of the implementation:
  // flat at the stable interval up to the threshold, then a straight line to the
  // cold interval at maxPermits.
  function curveHeight(x: number): number {
    if (x <= constants.thresholdPermits) return constants.stableIntervalMicros;
    const fraction =
      (x - constants.thresholdPermits) / (constants.maxPermits - constants.thresholdPermits);
    return (
      constants.stableIntervalMicros +
      fraction * (constants.coldIntervalMicros - constants.stableIntervalMicros)
    );
  }

  it('equals the area under the curve, checked by numerical integration', () => {
    const steps = 100_000;
    for (const [stored, take] of [
      [300, 1],
      [280, 200],
      [170.5, 20.25],
      [120, 60],
    ] as const) {
      // Midpoint rule: exact for straight lines, so it matches up to rounding.
      const width = take / steps;
      let area = 0;
      for (let i = 0; i < steps; i++) {
        area += curveHeight(stored - take + (i + 0.5) * width) * width;
      }
      expectWithin(storedPermitsToWaitTime(constants, stored, take), area, 1e-3);
    }
  });

  it('costs the same whether permits are taken in one piece or several', () => {
    const once = storedPermitsToWaitTime(constants, 250, 180);
    const inSteps =
      storedPermitsToWaitTime(constants, 250, 30) +
      storedPermitsToWaitTime(constants, 220, 90) +
      storedPermitsToWaitTime(constants, 130, 60);
    expectWithin(inSteps, once, TOLERANCE);
  });

  it('does not truncate to whole microseconds', () => {
    const cost = storedPermitsToWaitTime(constants, 300, 1);
    expectWithin(cost - Math.trunc(cost), 1 / 3, TOLERANCE);
  });
});
