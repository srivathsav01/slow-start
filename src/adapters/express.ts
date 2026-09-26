import { attempt, type GuardOptions, type Limiter } from './guard.js';

// Express types are deliberately not imported. The middleware needs three
// methods, so they are declared structurally: the published .d.ts then has no
// dependency on @types/express, and the same middleware works with Express 4
// and 5 alike.

/** The part of an Express response this middleware uses. */
export interface RateLimitResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

/** Express's `next`, which takes an error to forward to the error handler. */
export type RateLimitNext = (error?: unknown) => void;

export interface ExpressRateLimitOptions extends GuardOptions {
  /** Status for a refused request. Defaults to 429, Too Many Requests. */
  statusCode?: number;
  /** Body for a refused request. Defaults to `{ error: 'rate limited' }`. */
  body?: (refusal: { reason: 'delay' | 'depth'; retryAfterMs: number }) => unknown;
}

/**
 * Express middleware that admits a request when the limiter allows it and
 * answers 429 with a `Retry-After` when it does not.
 *
 * ```ts
 * import { WarmupLimiter } from 'slow-start';
 * import { expressRateLimit } from 'slow-start/adapters';
 *
 * const limiter = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 });
 * app.use(expressRateLimit(limiter));
 * ```
 *
 * It is a thin wrapper over {@link attempt}: anything that is not a refusal —
 * an invalid option, or a cancelled signal — is forwarded to `next(error)` so
 * Express's error handling deals with it, rather than being reported to the
 * client as backpressure.
 */
export function expressRateLimit(limiter: Limiter, options: ExpressRateLimitOptions = {}) {
  const statusCode = options.statusCode ?? 429;
  const body = options.body ?? (() => ({ error: 'rate limited' }));

  return function rateLimit(_request: unknown, response: RateLimitResponse, next: RateLimitNext) {
    attempt(limiter, options).then((result) => {
      if (result.ok) {
        next();
        return;
      }

      // Seconds, rounded up: a client told to retry in 0 s comes straight
      // back before the wait has elapsed.
      response.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      response.status(statusCode).json(body(result));
    }, next);
  };
}
