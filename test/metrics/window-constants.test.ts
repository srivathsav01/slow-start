import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUCKETS,
  deriveWindowConstants,
  type WindowOptions,
} from '../../src/metrics/window-constants.js';

describe('deriveWindowConstants', () => {
  it('defaults to 50 ms resolution over a one-second window', () => {
    expect(DEFAULT_BUCKETS).toBe(20);
    expect(deriveWindowConstants({ windowMs: 1000 })).toEqual({
      windowMicros: 1_000_000,
      bucketCount: 20,
      bucketLengthMicros: 50_000,
    });
  });

  it.each([
    { windowMs: 60_000, buckets: 60, bucketLengthMicros: 1_000_000 },
    { windowMs: 1, buckets: 1000, bucketLengthMicros: 1 },
    { windowMs: 500, buckets: 1, bucketLengthMicros: 500_000 },
    { windowMs: 0.5, buckets: 5, bucketLengthMicros: 100 },
  ])('divides $windowMs ms into $buckets buckets', ({ windowMs, buckets, bucketLengthMicros }) => {
    expect(deriveWindowConstants({ windowMs, buckets })).toEqual({
      windowMicros: windowMs * 1000,
      bucketCount: buckets,
      bucketLengthMicros,
    });
  });

  it('keeps the parts consistent: bucketLength times count is the window', () => {
    for (const [windowMs, buckets] of [
      [1000, 20],
      [250, 25],
      [60_000, 600],
      [7, 7],
    ] as const) {
      const c = deriveWindowConstants({ windowMs, buckets });
      expect(c.bucketLengthMicros * c.bucketCount).toBe(c.windowMicros);
    }
  });

  it('does not modify the options it is given', () => {
    const options: WindowOptions = Object.freeze({ windowMs: 1000 });
    expect(() => deriveWindowConstants(options)).not.toThrow();
    expect(options).toEqual({ windowMs: 1000 });
  });

  describe('rejects a bucket length that is not a whole microsecond', () => {
    it.each([
      { windowMs: 1000, buckets: 3 },
      { windowMs: 1, buckets: 3 },
      { windowMs: 0.001, buckets: 2 },
    ])('$windowMs ms into $buckets buckets', ({ windowMs, buckets }) => {
      expect(() => deriveWindowConstants({ windowMs, buckets })).toThrow(RangeError);
      expect(() => deriveWindowConstants({ windowMs, buckets })).toThrow(
        `windowMs ${String(windowMs)} does not divide evenly into ${String(buckets)} buckets`,
      );
    });
  });

  describe('rejects invalid options', () => {
    const valid: WindowOptions = { windowMs: 1000, buckets: 20 };

    it.each([
      { option: 'windowMs', value: 0 },
      { option: 'windowMs', value: -1 },
      { option: 'windowMs', value: NaN },
      { option: 'windowMs', value: Infinity },
      { option: 'buckets', value: 0 },
      { option: 'buckets', value: -1 },
      { option: 'buckets', value: 2.5 },
      { option: 'buckets', value: NaN },
      { option: 'buckets', value: Infinity },
    ] as const)('$option = $value', ({ option, value }) => {
      expect(() => deriveWindowConstants({ ...valid, [option]: value })).toThrow(RangeError);
      expect(() => deriveWindowConstants({ ...valid, [option]: value })).toThrow(`${option} must`);
    });
  });
});
