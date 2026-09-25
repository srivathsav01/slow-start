/** Which bound refused the caller. */
export type RejectionReason = 'delay' | 'depth';

/**
 * Thrown when a limiter refuses a caller rather than queueing it.
 *
 * The two reasons call for different responses: `'delay'` means the system is
 * busy and the caller may retry later, while `'depth'` means the queue itself
 * is saturated and retrying immediately will not help.
 */
export class RateLimitRejectedError extends Error {
  /** Which bound was hit. */
  readonly reason: RejectionReason;
  /** The wait the caller would have had, in milliseconds. */
  readonly waitMs: number;
  /** How many callers were already waiting. */
  readonly queueDepth: number;

  constructor(reason: RejectionReason, waitMs: number, queueDepth: number, message: string) {
    super(message);
    this.reason = reason;
    this.waitMs = waitMs;
    this.queueDepth = queueDepth;
    // Not inherited from the class name: without this, an uncaught error
    // prints as plain `Error`.
    this.name = 'RateLimitRejectedError';
  }

  /** The caller's wait exceeded the effective queue-delay bound. */
  static tooLong(waitMs: number, limitMs: number, queueDepth: number): RateLimitRejectedError {
    return new RateLimitRejectedError(
      'delay',
      waitMs,
      queueDepth,
      `would wait ${waitMs}ms, which exceeds maxQueueDelayMs of ${limitMs}ms`,
    );
  }

  /** The queue already holds as many waiting callers as it is allowed to. */
  static queueFull(waitMs: number, maxDepth: number): RateLimitRejectedError {
    return new RateLimitRejectedError(
      'depth',
      waitMs,
      maxDepth,
      `queue is full: ${maxDepth} callers already waiting`,
    );
  }
}
