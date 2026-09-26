import { RateLimitRejectedError, type RejectionReason } from '../core/errors.js';

/**
 * Anything with an `acquire` of the right shape.
 *
 * Structural on purpose: `WarmupLimiter`, `Pacer`, `QueuedLimiter` and a
 * limiter of your own all satisfy it without knowing this type exists.
 */
export interface Limiter {
  acquire(permits?: number, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
}

export interface GuardOptions {
  /** Permits to take. Defaults to 1. */
  permits?: number;
  /** Cancels the attempt. Aborting is not a refusal; it propagates. */
  signal?: AbortSignal;
  /** This caller's budget, where the limiter supports one. */
  timeoutMs?: number;
}

/** The decision, with what a caller needs to answer a refused request. */
export type Attempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RejectionReason; readonly retryAfterMs: number };

function acquireOptions(options: GuardOptions): { signal?: AbortSignal; timeoutMs?: number } {
  // Built explicitly rather than spread: `permits` is not an acquire option,
  // and an explicit `undefined` is not the same as an absent property under
  // exactOptionalPropertyTypes.
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

/**
 * Asks the limiter for permission and reports the answer, without throwing
 * when the answer is no.
 *
 * This is the seam middleware needs: a refusal is a response to send, not an
 * exception to handle.
 *
 * @throws Anything that is not a refusal — a `RangeError` for bad arguments,
 * or the abort reason if `options.signal` fires. Reporting either as
 * backpressure would hide a bug behind a 429.
 */
export async function attempt(limiter: Limiter, options: GuardOptions = {}): Promise<Attempt> {
  try {
    await limiter.acquire(options.permits ?? 1, acquireOptions(options));
    return { ok: true };
  } catch (error) {
    if (error instanceof RateLimitRejectedError) {
      return {
        ok: false,
        reason: error.reason,
        // Rounded up: this feeds a Retry-After, and rounding down invites the
        // client back before the wait has elapsed.
        retryAfterMs: Math.ceil(error.waitMs),
      };
    }
    throw error;
  }
}

/**
 * Runs `work` once the limiter admits it.
 *
 * Deliberately transparent: a refusal rejects with the
 * `RateLimitRejectedError`, and `work`'s own errors propagate untouched. It
 * does not retry, record metrics or swallow anything.
 *
 * Not built on {@link attempt}, which discards the error this one must throw.
 */
export async function guard<T>(
  limiter: Limiter,
  work: () => T | Promise<T>,
  options: GuardOptions = {},
): Promise<T> {
  await limiter.acquire(options.permits ?? 1, acquireOptions(options));
  return await work();
}
