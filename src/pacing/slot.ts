import { RateLimitRejectedError } from '../core/errors.js';
import type { PacingConstants, QueueBounds } from './pacing-constants.js';

/** The pacer's entire scheduling state: one timestamp, whatever the load. */
export interface PacingState {
  nextSlotMicros: number;
}

/** How long a caller arriving now would wait. Changes nothing. */
export function waitForNextSlotMicros(state: PacingState, nowMicros: number): number {
  return Math.max(0, state.nextSlotMicros - nowMicros);
}

/**
 * Takes the next slot and advances it by the cost of `permits`.
 *
 * Idle time is not banked: a slot in the past is pulled up to now, so a long
 * quiet period earns no burst allowance. That is what separates a pacer from
 * a token bucket.
 *
 * @returns How long the caller must wait, in microseconds.
 */
export function reserveSlot(
  state: PacingState,
  constants: PacingConstants,
  permits: number,
  nowMicros: number,
): number {
  if (state.nextSlotMicros < nowMicros) {
    state.nextSlotMicros = nowMicros;
  }

  const grantMicros = state.nextSlotMicros;
  state.nextSlotMicros = grantMicros + permits * constants.intervalMicros;
  return grantMicros - nowMicros;
}

/**
 * The single refusal path for both queue bounds (spec §9.3).
 *
 * A per-call timeout may only **tighten** `maxQueueDelay`, never extend past
 * it: the standing bound is what caps the memory held by queued callers, so
 * no individual call may opt out of it.
 *
 * @param perCallTimeoutMicros - A caller's own budget. `Infinity` means the
 *   caller has no opinion and only the standing bound applies.
 * @throws RateLimitRejectedError if the caller must be refused rather than
 *   queued. Nothing is mutated, so a refusal leaves no trace.
 */
export function checkBounds(
  waitMicros: number,
  queueDepth: number,
  constants: QueueBounds,
  perCallTimeoutMicros = Infinity,
): void {
  // Depth first: a full queue is the more fundamental refusal, and reporting
  // 'delay' would send someone tuning the wrong bound.
  if (queueDepth >= constants.maxQueueDepth) {
    throw RateLimitRejectedError.queueFull(waitMicros / 1000, constants.maxQueueDepth);
  }

  const effectiveLimitMicros = Math.min(constants.maxQueueDelayMicros, perCallTimeoutMicros);
  if (waitMicros > effectiveLimitMicros) {
    // Report the effective limit, not the configured one: a caller refused at
    // 1,000 ms after asking for 60,000 ms needs to see 1,000.
    throw RateLimitRejectedError.tooLong(
      waitMicros / 1000,
      effectiveLimitMicros / 1000,
      queueDepth,
    );
  }
}
