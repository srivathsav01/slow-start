import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLD_FACTOR,
  deriveConstants,
  type WarmupOptions,
} from '../../src/warmup/constants.js';
import { expectWithin } from '../helpers/expect-within.js';
import { loadGoldenConfig } from '../helpers/golden-vectors.js';

describe('deriveConstants', () => {
  describe('matches the verified configuration in config.json', () => {
    const config = loadGoldenConfig();
    const constants = deriveConstants({
      permitsPerSecond: config.input.stableRatePermitsPerSecond,
      warmupPeriodMs: config.input.warmupPeriodMicros / 1000,
      coldFactor: config.input.coldFactor,
    });

    it.each([
      ['stableIntervalMicros', config.tolerance.timeMicros],
      ['coldIntervalMicros', config.tolerance.timeMicros],
      ['thresholdPermits', config.tolerance.permits],
      ['maxPermits', config.tolerance.permits],
      ['slopeMicrosPerPermit', config.tolerance.timeMicros],
      ['coolDownIntervalMicros', config.tolerance.timeMicros],
    ] as const)('%s', (key, tolerance) => {
      expectWithin(constants[key], config.derived[key], tolerance);
    });
  });

  // These check the shape the constants must describe, not the formulas that
  // produce them, so a typo in a formula cannot be copied into the test.
  // The configuration is deliberately unround so no result is a whole number.
  describe('describes the warm-up geometry for an unround configuration', () => {
    const permitsPerSecond = 7;
    const warmupPeriodMs = 1234;
    const coldFactor = 4.5;
    const warmupPeriodMicros = warmupPeriodMs * 1000;
    const tolerance = 1e-6;
    const c = deriveConstants({ permitsPerSecond, warmupPeriodMs, coldFactor });

    it('spaces permits 1/permitsPerSecond seconds apart when warm', () => {
      expectWithin(c.stableIntervalMicros * permitsPerSecond, 1_000_000, tolerance);
    });

    it('makes the cold interval coldFactor times the stable interval', () => {
      expectWithin(c.coldIntervalMicros / c.stableIntervalMicros, coldFactor, tolerance);
    });

    it('makes the rectangle below the threshold half the warm-up period', () => {
      expectWithin(c.thresholdPermits * c.stableIntervalMicros, warmupPeriodMicros / 2, tolerance);
    });

    it('makes the trapezoid above the threshold equal to the warm-up period', () => {
      const width = c.maxPermits - c.thresholdPermits;
      const area = (width * (c.stableIntervalMicros + c.coldIntervalMicros)) / 2;
      expectWithin(area, warmupPeriodMicros, tolerance);
    });

    it('climbs from the stable to the cold interval across the trapezoid', () => {
      const costAtMax =
        c.stableIntervalMicros + c.slopeMicrosPerPermit * (c.maxPermits - c.thresholdPermits);
      expectWithin(costAtMax, c.coldIntervalMicros, tolerance);
    });

    it('refills an empty bucket in exactly the warm-up period', () => {
      expectWithin(c.coolDownIntervalMicros * c.maxPermits, warmupPeriodMicros, tolerance);
    });
  });

  it(`defaults coldFactor to ${String(DEFAULT_COLD_FACTOR)}`, () => {
    expect(DEFAULT_COLD_FACTOR).toBe(3);
    expect(deriveConstants({ permitsPerSecond: 7, warmupPeriodMs: 1234 })).toEqual(
      deriveConstants({ permitsPerSecond: 7, warmupPeriodMs: 1234, coldFactor: 3 }),
    );
  });

  it('does not modify the options it is given', () => {
    const options: WarmupOptions = Object.freeze({ permitsPerSecond: 100, warmupPeriodMs: 3000 });
    expect(() => deriveConstants(options)).not.toThrow();
    expect(options).toEqual({ permitsPerSecond: 100, warmupPeriodMs: 3000 });
  });

  describe('rejects invalid options with a RangeError naming the option', () => {
    const valid: WarmupOptions = { permitsPerSecond: 100, warmupPeriodMs: 3000, coldFactor: 3 };

    it.each([
      { option: 'permitsPerSecond', value: 0 },
      { option: 'permitsPerSecond', value: -1 },
      { option: 'permitsPerSecond', value: NaN },
      { option: 'permitsPerSecond', value: Infinity },
      // Guava allows 0; we reject it because it makes coolDownInterval 0/0 = NaN.
      { option: 'warmupPeriodMs', value: 0 },
      { option: 'warmupPeriodMs', value: -1 },
      { option: 'warmupPeriodMs', value: NaN },
      { option: 'warmupPeriodMs', value: Infinity },
      { option: 'coldFactor', value: 1 },
      { option: 'coldFactor', value: 0.5 },
      { option: 'coldFactor', value: NaN },
      { option: 'coldFactor', value: Infinity },
    ] as const)('$option = $value', ({ option, value }) => {
      expect(() => deriveConstants({ ...valid, [option]: value })).toThrow(RangeError);
      expect(() => deriveConstants({ ...valid, [option]: value })).toThrow(`${option} must be`);
    });
  });
});
