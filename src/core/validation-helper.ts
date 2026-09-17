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
