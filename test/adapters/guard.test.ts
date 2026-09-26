import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../src/clock/manual-clock.js';
import { attempt, guard, type Limiter } from '../../src/adapters/guard.js';
import { RateLimitRejectedError } from '../../src/core/errors.js';
import { QueuedLimiter } from '../../src/pacing/queued-limiter.js';
import { WarmupLimiter } from '../../src/warmup/warmup-limiter.js';

function bounded(maxQueueDelayMs = 10): { clock: ManualClock; limiter: QueuedLimiter } {
  const clock = new ManualClock();
  const warm = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);
  return { clock, limiter: new QueuedLimiter(warm, { maxQueueDelayMs }, clock) };
}

describe('attempt', () => {
  it('reports admission', async () => {
    const { limiter } = bounded();
    expect(await attempt(limiter)).toEqual({ ok: true });
  });

  it('reports a refusal instead of throwing', async () => {
    const { limiter } = bounded(10);
    await attempt(limiter); // the first caller is free
    const result = await attempt(limiter); // the second owes ~29.93 ms

    expect(result).toEqual({ ok: false, reason: 'delay', retryAfterMs: 30 });
  });

  it('rounds the retry hint up, never down', async () => {
    const { limiter } = bounded(10);
    await attempt(limiter);
    const result = await attempt(limiter);

    // The real wait is 29.933... ms; telling a client 29 would invite it back
    // before the wait has elapsed.
    if (result.ok) expect.unreachable('should have been refused');
    else expect(result.retryAfterMs).toBe(30);
  });

  it('reports a full queue as depth', async () => {
    const clock = new ManualClock();
    const warm = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);
    const limiter = new QueuedLimiter(warm, { maxQueueDepth: 1, maxQueueDelayMs: 60_000 }, clock);

    await attempt(limiter); // admitted at once
    void limiter.acquire(); // fills the single queue slot
    await Promise.resolve();

    const result = await attempt(limiter);
    if (result.ok) expect.unreachable('should have been refused');
    else expect(result.reason).toBe('depth');
  });

  it('passes the permit count through', async () => {
    const acquire = vi.fn(() => Promise.resolve(undefined));
    await attempt({ acquire }, { permits: 4 });
    expect(acquire).toHaveBeenCalledWith(4, {});
  });

  it('passes only the options the limiter takes', async () => {
    const acquire = vi.fn(() => Promise.resolve(undefined));
    const signal = new AbortController().signal;
    await attempt({ acquire }, { permits: 2, signal, timeoutMs: 50 });
    // `permits` is an argument, not an acquire option.
    expect(acquire).toHaveBeenCalledWith(2, { signal, timeoutMs: 50 });
  });

  it('omits absent options rather than passing undefined', async () => {
    const acquire = vi.fn(() => Promise.resolve(undefined));
    await attempt({ acquire });
    expect(acquire).toHaveBeenCalledWith(1, {});
  });

  describe('does not disguise other failures as refusals', () => {
    it('lets a RangeError through', async () => {
      const { limiter } = bounded();
      await expect(attempt(limiter, { permits: 0 })).rejects.toBeInstanceOf(RangeError);
    });

    it('lets an abort through', async () => {
      const { limiter } = bounded();
      const controller = new AbortController();
      controller.abort(new Error('caller left'));
      await expect(attempt(limiter, { signal: controller.signal })).rejects.toThrow('caller left');
    });

    it('lets an unrelated error through', async () => {
      const limiter: Limiter = {
        acquire: () => Promise.reject(new TypeError('limiter is broken')),
      };
      await expect(attempt(limiter)).rejects.toBeInstanceOf(TypeError);
    });
  });
});

describe('guard', () => {
  it('runs the work once admitted and returns its value', async () => {
    // A fresh limiter each time: the first caller is the one that never
    // waits, and a manual clock does not move on its own.
    expect(await guard(bounded(60_000).limiter, () => 'done')).toBe('done');
    expect(
      await guard(bounded(60_000).limiter, () => Promise.resolve(42), { timeoutMs: 60_000 }),
    ).toBe(42);
  });

  it('never runs the work when refused, and throws the refusal', async () => {
    const { limiter } = bounded(10);
    await guard(limiter, () => 'first');

    const work = vi.fn(() => 'second');
    await expect(guard(limiter, work)).rejects.toBeInstanceOf(RateLimitRejectedError);
    expect(work).not.toHaveBeenCalled();
  });

  it('propagates the work’s own error untouched', async () => {
    const { limiter } = bounded(60_000);
    const failure = new TypeError('work blew up');
    await expect(
      guard(limiter, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('does not roll back the permit when the work fails', async () => {
    const acquire = vi.fn(() => Promise.resolve(undefined));
    await expect(
      guard({ acquire }, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Acquired once, released never: there is no rollback path, by design.
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('works with any limiter shape, including a bare object', async () => {
    const calls: number[] = [];
    const limiter: Limiter = {
      acquire: (permits = 1) => {
        calls.push(permits);
        return Promise.resolve(undefined);
      },
    };
    expect(await guard(limiter, () => 'ok', { permits: 3 })).toBe('ok');
    expect(calls).toEqual([3]);
  });

  it('accepts the package’s own limiters without adaptation', async () => {
    const clock = new ManualClock();
    const warm: Limiter = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);
    expect(await guard(warm, () => 'warm')).toBe('warm');
  });
});
