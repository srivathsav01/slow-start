/**
 * What an acquisition cost, returned once the caller may proceed.
 *
 * Every limiter reports this much. A limiter that knows more extends it —
 * see `WarmupAcquireResult`, which adds the permits left in the pot.
 */
export interface AcquireResult {
  /** Time actually waited, measured by the clock. Includes timer lateness. */
  readonly waitedMs: number;
}
