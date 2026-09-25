import { describe, expect, it } from 'vitest';
import { requireFiniteAbove, requirePositiveInteger } from '../../src/core/validation-helper.js';

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

  describe('requirePositiveInteger', () => {
    it.each([1, 2, 1000, Number.MAX_SAFE_INTEGER])('accepts %s', (value) => {
      expect(requirePositiveInteger('maxQueueDepth', value)).toBe(value);
    });

    it.each([0, -0, -1, 2.5, 0.5, NaN, Infinity, -Infinity, 2 ** 53])('rejects %s', (value) => {
      // 2^53 is rejected because integers above it are no longer exact.
      expect(() => requirePositiveInteger('maxQueueDepth', value)).toThrow(RangeError);
    });

    it('names the option and the actual value', () => {
      expect(() => requirePositiveInteger('maxQueueDepth', 2.5)).toThrow(
        'maxQueueDepth must be a positive integer, got 2.5',
      );
    });
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
