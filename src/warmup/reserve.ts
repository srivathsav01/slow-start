import type { WarmupConstants } from './constants.js';
import { storedPermitsToWaitTime } from './cost.js';
import { resync, type WarmupState } from './state.js';

/**
 * Reserves `permits` at `nowMicros` and returns the time the caller may proceed
 * (Guava's `reserveEarliestAvailable`).
 *
 * The caller is granted the current next free ticket; the cost of their permits
 * pushes the ticket forward for whoever comes next (the debt model).
 *
 * @param state - The limiter's own state. Updated in place.
 * @param constants - The constants from `deriveConstants`.
 * @param permits - Permits requested. Validated by the caller, not here.
 * @param nowMicros - The current time in microseconds.
 * @returns The grant time in microseconds, which may be later than `nowMicros`.
 */
export function reserve(
  state: WarmupState,
  constants: WarmupConstants,
  permits: number,
  nowMicros: number,
): number {
  resync(state, constants, nowMicros);
  const grantMicros = state.nextFreeTicketMicros;

  const storedToSpend = Math.min(permits, state.storedPermits);
  const freshPermits = permits - storedToSpend;

  // The cost is based on the pot before spending, so update storedPermits last.
  state.nextFreeTicketMicros +=
    storedPermitsToWaitTime(constants, state.storedPermits, storedToSpend) +
    freshPermits * constants.stableIntervalMicros;
  state.storedPermits -= storedToSpend;

  return grantMicros;
}
