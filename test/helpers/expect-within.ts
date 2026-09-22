import { expect } from 'vitest';

/**
 * Asserts that `actual` is within an absolute `tolerance` of `expected`.
 *
 * Vitest's `toBeCloseTo` takes a number of decimal places rather than an
 * absolute tolerance, which does not match how config.json states its
 * tolerances.
 */
export function expectWithin(actual: number, expected: number, tolerance: number): void {
  const difference = Math.abs(actual - expected);
  expect(
    difference,
    `expected ${String(actual)} to be within ${String(tolerance)} of ${String(expected)}`,
  ).toBeLessThanOrEqual(tolerance);
}
