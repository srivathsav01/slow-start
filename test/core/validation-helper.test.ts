import { describe, expect, it } from 'vitest';
import { requireFiniteAbove } from '../../src/core/validation-helper.js';

describe('requireFiniteAbove', () => {
  describe('accepts values strictly above the minimum', () => {
    it.each([
      { name: 'permitsPerSecond', value: 100, minimum: 0 },
      { name: 'permitsPerSecond', value: Number.MIN_VALUE, minimum: 0 },
      { name: 'coldFactor', value: 1.5, minimum: 1 },
      { name: 'offset', value: -0.5, minimum: -1 },
    ])('$name = $value with minimum $minimum', ({ name, value, minimum }) => {
      expect(requireFiniteAbove(name, value, minimum)).toBe(value);
    });
  });

  describe('rejects values at or below the minimum', () => {
    it.each([
      { name: 'permitsPerSecond', value: 0, minimum: 0 },
      { name: 'permitsPerSecond', value: -0, minimum: 0 },
      { name: 'permitsPerSecond', value: -5, minimum: 0 },
      { name: 'coldFactor', value: 1, minimum: 1 },
      { name: 'coldFactor', value: 0.5, minimum: 1 },
    ])('$name = $value with minimum $minimum', ({ name, value, minimum }) => {
      expect(() => requireFiniteAbove(name, value, minimum)).toThrow(RangeError);
    });
  });

  describe('rejects non-finite values', () => {
    it.each([NaN, Infinity, -Infinity])('%s', (value) => {
      expect(() => requireFiniteAbove('warmupPeriodMs', value, 0)).toThrow(RangeError);
    });
  });

  it('rejects a non-number passed from untyped JavaScript', () => {
    const fromJavaScript = '100' as unknown as number;
    expect(() => requireFiniteAbove('permitsPerSecond', fromJavaScript, 0)).toThrow(RangeError);
  });

  describe('error messages name the option, the rule and the actual value', () => {
    it.each([
      { value: NaN, shown: 'NaN' },
      { value: Infinity, shown: 'Infinity' },
      { value: -Infinity, shown: '-Infinity' },
      { value: 0, shown: '0' },
      { value: -5, shown: '-5' },
    ])('$shown', ({ value, shown }) => {
      expect(() => requireFiniteAbove('warmupPeriodMs', value, 0)).toThrow(
        `warmupPeriodMs must be a finite number greater than 0, got ${shown}`,
      );
    });
  });
});
