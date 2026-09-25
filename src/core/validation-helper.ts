/**
 * Validates that a number is finite and above a minimum value.
 *
 * @param name - The option's name, used in the error message.
 * @param value - The value to validate.
 * @param min - The value must be strictly greater than this.
 * @returns The validated value.
 * @throws RangeError if the value is not finite or is at or below the minimum.
 */
export function requireFiniteAbove(name: string, value: number, min: number): number {
  if (!Number.isFinite(value) || value <= min) {
    throw new RangeError(
      `${name} must be a finite number greater than ${min}, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Validates that a number is a whole count above zero: no fractions, no
 * `NaN`, no `Infinity`, and nothing large enough to lose precision.
 *
 * @param name - The option's name, used in the error message.
 * @param value - The value to validate.
 * @returns The validated value.
 * @throws RangeError if the value is not a positive safe integer.
 */
export function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}