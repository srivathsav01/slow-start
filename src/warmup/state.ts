import type { WarmupConstants } from './constants.js';

export interface WarmupState {
  storedPermits: number;
  nextFreeTicketMicros: number;
}

/**
 * Brings the state up to `nowMicros`, turning idle time into stored permits
 * (Guava's `resync`).
 *
 * Does nothing when `nowMicros` is at or before the next free ticket: either no
 * time has passed, or the limiter is still paying off an earlier reservation.
 *
 * @param state - The limiter's own state. Updated in place.
 * @param constants - The constants from `deriveConstants`.
 * @param nowMicros - The current time in microseconds.
 */
export function resync(state: WarmupState, constants: WarmupConstants, nowMicros: number): void {
  if (nowMicros > state.nextFreeTicketMicros) {
    const newPermits = (nowMicros - state.nextFreeTicketMicros) / constants.coolDownIntervalMicros;
    state.storedPermits = Math.min(constants.maxPermits, state.storedPermits + newPermits);
    state.nextFreeTicketMicros = nowMicros;
  }
}
