/**
 * Anything that can say how long a caller must wait.
 *
 * This is the seam between a rate model and the machinery that holds callers
 * until their turn: `pacing/` consumes it, `warmup/` implements it, and
 * neither imports the other (spec §11).
 *
 * Implementations read their own clock, so no time is passed in. Waits are in
 * microseconds, the unit every scheduler here works in.
 */
export interface Scheduler {
  /** What `reserveMicros` would return right now, changing nothing. */
  peekWaitMicros(permits: number): number;

  /** Takes the slot and returns the wait it imposes, in microseconds. */
  reserveMicros(permits: number): number;
}
