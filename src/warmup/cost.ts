import type { WarmupConstants } from './constants.js';

/** Height of the cost curve at a point on the sloped part above the threshold. */
function permitsToTime(constants: WarmupConstants, permitsAboveThreshold: number): number {
  return constants.stableIntervalMicros + permitsAboveThreshold * constants.slopeMicrosPerPermit;
}

/**
 * The time, in microseconds, that taking permits from the stored pot costs
 * (Guava's `storedPermitsToWaitTime`). It is the area under the cost curve
 * between `storedPermits - permitsToTake` and `storedPermits`.
 *
 * Unlike Guava, the result is not truncated to whole microseconds (spec §5A).
 *
 * @param constants - The constants from `deriveConstants`.
 * @param storedPermits - Permits in the pot before taking any.
 * @param permitsToTake - Permits taken from the pot. Must not exceed `storedPermits`.
 */
export function storedPermitsToWaitTime(
  constants: WarmupConstants,
  storedPermits: number,
  permitsToTake: number,
): number {
  const availableAboveThreshold = storedPermits - constants.thresholdPermits;
  let remaining = permitsToTake;
  let micros = 0;

  // The sloped part: permits above the threshold are taken first.
  if (availableAboveThreshold > 0) {
    const takeAbove = Math.min(availableAboveThreshold, remaining);
    const length =
      permitsToTime(constants, availableAboveThreshold) +
      permitsToTime(constants, availableAboveThreshold - takeAbove);
    micros = (takeAbove * length) / 2;
    remaining -= takeAbove;
  }

  // The flat part: every permit at or below the threshold costs the stable interval.
  micros += constants.stableIntervalMicros * remaining;
  return micros;
}
