import { requireFiniteAbove, requirePositiveInteger } from '../core/validation-helper.js';

export interface PacerOptions {
  /** The pace: one permit every `1 / permitsPerSecond` seconds. */
  permitsPerSecond: number;
  /**
   * Refuse a caller whose wait would exceed this. The primary control, and
   * the bound that keeps queued callers from exhausting memory (spec §9.3).
   */
  maxQueueDelayMs?: number;
  /** Hard cap on callers waiting at once. A backstop against huge bursts. */
  maxQueueDepth?: number;
}

/** Times are microseconds; milliseconds do not exist past this point. */
export interface PacingConstants {
  readonly intervalMicros: number;
  readonly maxQueueDelayMicros: number;
  readonly maxQueueDepth: number;
}

export const DEFAULT_MAX_QUEUE_DELAY_MS = 1000;
export const DEFAULT_MAX_QUEUE_DEPTH = 1000;

/**
 * Validates the pacer's options and converts them to the units the scheduler
 * works in.
 *
 * @throws RangeError if the rate or delay bound is not finite and above zero,
 * or if the depth bound is not a positive integer.
 */
export function derivePacingConstants(options: PacerOptions): PacingConstants {
  const permitsPerSecond = requireFiniteAbove('permitsPerSecond', options.permitsPerSecond, 0);
  const maxQueueDelayMs = requireFiniteAbove(
    'maxQueueDelayMs',
    options.maxQueueDelayMs ?? DEFAULT_MAX_QUEUE_DELAY_MS,
    0,
  );
  const maxQueueDepth = requirePositiveInteger(
    'maxQueueDepth',
    options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
  );

  return {
    intervalMicros: 1_000_000 / permitsPerSecond,
    maxQueueDelayMicros: maxQueueDelayMs * 1000,
    maxQueueDepth,
  };
}
