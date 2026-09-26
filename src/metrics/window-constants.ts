import { requireFiniteAbove, requirePositiveInteger } from '../core/validation-helper.js';

export interface WindowOptions {
  /** How far back the window looks. */
  windowMs: number;
  /**
   * How many buckets the window is divided into. More buckets means finer
   * resolution and a smoother edge as old counts expire, at a fixed cost per
   * bucket. The default gives 50 ms resolution for a one-second window.
   */
  buckets?: number;
}

/** Times are microseconds; milliseconds do not exist past this point. */
export interface WindowConstants {
  readonly windowMicros: number;
  readonly bucketCount: number;
  readonly bucketLengthMicros: number;
}

export const DEFAULT_BUCKETS = 20;

/**
 * Validates the window's options and converts them to the units the ring
 * works in.
 *
 * @throws RangeError if `windowMs` is not finite and above zero, if `buckets`
 * is not a positive integer, or if the two do not divide into a whole number
 * of microseconds per bucket.
 */
export function deriveWindowConstants(options: WindowOptions): WindowConstants {
  const windowMs = requireFiniteAbove('windowMs', options.windowMs, 0);
  const buckets = requirePositiveInteger('buckets', options.buckets ?? DEFAULT_BUCKETS);

  const windowMicros = windowMs * 1000;
  const bucketLengthMicros = windowMicros / buckets;

  // Bucket lookup floors `now / bucketLength`. A fractional bucket length
  // puts every boundary at a time that cannot be represented exactly, making
  // writes near an edge land in whichever bucket the rounding picks.
  if (!Number.isInteger(bucketLengthMicros)) {
    throw new RangeError(
      `windowMs ${String(windowMs)} does not divide evenly into ${String(buckets)} buckets`,
    );
  }

  return {
    windowMicros,
    bucketCount: buckets,
    bucketLengthMicros,
  };
}
