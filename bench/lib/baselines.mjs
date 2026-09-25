// Reference limiters to compare against (§13.1 scenarios 2 and 5).
//
// These are deliberately minimal, textbook implementations, written only to
// show the behavioural contrast. They are not part of the package and are not
// tuned; §13.4's rule applies — the point is the difference in shape, not a
// throughput contest.
//
// Each exposes the same `acquire(permits)` the driver calls, and reads time
// only through the injected clock, so every comparison runs on the same
// deterministic timeline.

/** No warm-up: every permit costs the same, from the very first call. */
export class FixedRateLimiter {
  #clock;
  #intervalNanos;
  #nextFreeNanos;

  constructor({ permitsPerSecond }, clock) {
    this.#clock = clock;
    this.#intervalNanos = BigInt(Math.round(1e9 / permitsPerSecond));
    this.#nextFreeNanos = clock.now();
  }

  async acquire(permits = 1) {
    const now = this.#clock.now();
    if (this.#nextFreeNanos < now) this.#nextFreeNanos = now;
    const grant = this.#nextFreeNanos;
    this.#nextFreeNanos += this.#intervalNanos * BigInt(permits);
    await this.#clock.sleep(grant - now);
  }
}

/**
 * Classic token bucket: a burst of up to `capacity` permits is admitted at
 * once, then callers are spaced at the refill rate. Unused capacity
 * accumulates while idle, up to `capacity`.
 */
export class TokenBucketLimiter {
  #clock;
  #intervalNanos;
  #capacity;
  #tokens;
  #lastNanos;

  constructor({ permitsPerSecond, capacity }, clock) {
    this.#clock = clock;
    this.#intervalNanos = 1e9 / permitsPerSecond;
    this.#capacity = capacity;
    this.#tokens = capacity;
    this.#lastNanos = clock.now();
  }

  async acquire(permits = 1) {
    const now = this.#clock.now();
    const elapsed = Number(now - this.#lastNanos);
    this.#lastNanos = now;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed / this.#intervalNanos);

    // Going negative is the reservation: later callers queue behind it, which
    // keeps arrival order the same as in the warm-up limiter.
    this.#tokens -= permits;
    const waitNanos = this.#tokens >= 0 ? 0 : -this.#tokens * this.#intervalNanos;
    await this.#clock.sleep(BigInt(Math.ceil(waitNanos)));
  }
}

/**
 * Fixed window: up to `limit` permits per window, refusing nothing but making
 * callers wait for the next window. The sawtooth this produces is the classic
 * boundary problem.
 */
export class FixedWindowLimiter {
  #clock;
  #windowNanos;
  #limit;
  #windowIndex = -1n;
  #used = 0;

  constructor({ limit, windowMs }, clock) {
    this.#clock = clock;
    this.#windowNanos = BigInt(windowMs) * 1_000_000n;
    this.#limit = limit;
  }

  async acquire(permits = 1) {
    const now = this.#clock.now();

    // The window only ever moves forward. Taking the index from `now` alone
    // is what keeps the count honest: deriving it from a prospective grant
    // time lets a later caller fall back into an earlier window and reset the
    // counter, which admits far more than the limit.
    const currentIndex = now / this.#windowNanos;
    if (currentIndex > this.#windowIndex) {
      this.#windowIndex = currentIndex;
      this.#used = 0;
    }

    // Skip to the next window until this caller fits. A single request larger
    // than the whole limit takes a window to itself rather than looping.
    while (this.#used > 0 && this.#used + permits > this.#limit) {
      this.#windowIndex += 1n;
      this.#used = 0;
    }
    this.#used += permits;

    const startNanos = this.#windowIndex * this.#windowNanos;
    await this.#clock.sleep(startNanos > now ? startNanos - now : 0n);
  }
}
