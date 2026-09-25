import { requireFiniteAbove, requirePositiveInteger } from '../core/validation-helper.js';

/** The bounds every queueing limiter accepts. */
export interface QueueOptions {
  /**
   * Refuse a caller whose wait would exceed this. The primary control, and
   * the bound that keeps queued callers from exhausting memory (spec §9.3).
   */
  maxQueueDelayMs?: number;
  /** Hard cap on callers waiting at once. A backstop against huge bursts. */
  maxQueueDepth?: number;
}

/** Per-call options. */
export interface PaceOptions {
  /** Cancels the call. A queued caller that aborts forfeits its slot (§8.3). */
  signal?: AbortSignal;
  /**
   * This caller's own budget. It may only **tighten** `maxQueueDelayMs`,
   * never extend past it, so no call can opt out of the standing bound.
   */
  timeoutMs?: number;
}

/** The bounds in the units the queue works in. */
export interface QueueBounds {
  readonly maxQueueDelayMicros: number;
  readonly maxQueueDepth: number;
}

export interface PacerOptions extends QueueOptions {
  /** The pace: one permit every `1 / permitsPerSecond` seconds. */
  permitsPerSecond: number;
}

/** Times are microseconds; milliseconds do not exist past this point. */
export interface PacingConstants extends QueueBounds {
  readonly intervalMicros: number;
}

export const DEFAULT_MAX_QUEUE_DELAY_MS = 1000;
export const DEFAULT_MAX_QUEUE_DEPTH = 1000;

/**
 * Validates the queue bounds and converts them to microseconds.
 *
 * @throws RangeError if the delay bound is not finite and above zero, or the
 * depth bound is not a positive integer.
 */
export function deriveQueueBounds(options: QueueOptions): QueueBounds {
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
    maxQueueDelayMicros: maxQueueDelayMs * 1000,
    maxQueueDepth,
  };
}

/**
 * Validates the pacer's options and converts them to the units the scheduler
 * works in.
 *
 * @throws RangeError if the rate or delay bound is not finite and above zero,
 * or if the depth bound is not a positive integer.
 */
export function derivePacingConstants(options: PacerOptions): PacingConstants {
  const permitsPerSecond = requireFiniteAbove('permitsPerSecond', options.permitsPerSecond, 0);
  const queueBounds = deriveQueueBounds(options);

  return {
    ...queueBounds,
    intervalMicros: 1_000_000 / permitsPerSecond,
  };
}
