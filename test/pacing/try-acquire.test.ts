import { setImmediate } from 'node:timers';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/clock/manual-clock.js';
import { Pacer } from '../../src/pacing/pacer.js';
import { QueuedLimiter } from '../../src/pacing/queued-limiter.js';
import { WarmupLimiter } from '../../src/warmup/warmup-limiter.js';

// The package-wide rule: `acquire` throws on refusal, `tryAcquire` returns a
// boolean. These tests hold both halves of the pair to it.

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const micros = (value: number): bigint => BigInt(value) * 1000n;

function pacer(options = {}): { clock: ManualClock; limiter: Pacer } {
  const clock = new ManualClock();
  return {
    clock,
    limiter: new Pacer({ permitsPerSecond: 100, maxQueueDelayMs: 15, ...options }, clock),
  };
}

function composed(options = {}): { clock: ManualClock; limiter: QueuedLimiter } {
  const clock = new ManualClock();
  const warm = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);
  return { clock, limiter: new QueuedLimiter(warm, { maxQueueDelayMs: 15, ...options }, clock) };
}

describe.each([
  ['Pacer', pacer],
  ['QueuedLimiter', composed],
])('%s.tryAcquire', (_name, setup) => {
  it('returns true when admitted', async () => {
    const { limiter } = setup();
    expect(await limiter.tryAcquire()).toBe(true);
  });

  it('returns false instead of throwing when a bound refuses', async () => {
    const { limiter } = setup();
    await limiter.tryAcquire(); // the first caller is free
    void limiter.acquire().catch(() => undefined); // fills the timeline
    await flush();

    expect(await limiter.tryAcquire()).toBe(false);
  });

  it('returns false when the queue is full', async () => {
    const { limiter } = setup({ maxQueueDepth: 1, maxQueueDelayMs: 60_000 });
    await limiter.tryAcquire();
    void limiter.acquire().catch(() => undefined); // occupies the one slot
    await flush();

    expect(await limiter.tryAcquire()).toBe(false);
  });

  it('waits for its slot when admitted', async () => {
    const { clock, limiter } = setup({ maxQueueDelayMs: 60_000 });
    await limiter.tryAcquire();

    let settled = false;
    void limiter.tryAcquire().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    clock.advance(micros(60_000));
    await flush();
    expect(settled).toBe(true);
  });

  it('probes without waiting when given a zero timeout', async () => {
    const { limiter } = setup({ maxQueueDelayMs: 60_000 });
    expect(await limiter.tryAcquire(1, { timeoutMs: 0 })).toBe(true);
    expect(await limiter.tryAcquire(1, { timeoutMs: 0 })).toBe(false);
  });

  describe('does not disguise other failures as refusal', () => {
    it.each([0, -1, 1.5, NaN])('throws RangeError for permits = %s', async (permits) => {
      const { limiter } = setup();
      await expect(limiter.tryAcquire(permits)).rejects.toBeInstanceOf(RangeError);
    });

    it('throws when the signal is already aborted', async () => {
      const { limiter } = setup();
      const controller = new AbortController();
      controller.abort(new Error('caller left'));
      await expect(limiter.tryAcquire(1, { signal: controller.signal })).rejects.toThrow(
        'caller left',
      );
    });

    it('throws for an invalid timeout', async () => {
      const { limiter } = setup();
      await expect(limiter.tryAcquire(1, { timeoutMs: -1 })).rejects.toThrow('timeoutMs must be');
    });
  });

  // Spec §8.2: a failed tryAcquire must leave the state byte-identical. Two
  // identical limiters are driven in lockstep; one is probed until it refuses,
  // the other is not. If a refusal touched the timeline, the queue or the
  // armed timer, the two would diverge.
  it('leaves state byte-identical when it refuses', async () => {
    const probed = setup({ maxQueueDelayMs: 60_000 });
    const untouched = setup({ maxQueueDelayMs: 60_000 });

    // Identical history on both.
    for (const { limiter } of [probed, untouched]) {
      await limiter.tryAcquire();
      void limiter.acquire().catch(() => undefined);
      void limiter.acquire().catch(() => undefined);
    }
    await flush();

    // Only one of them is probed, thirty times.
    for (let i = 0; i < 30; i++) {
      expect(await probed.limiter.tryAcquire(1, { timeoutMs: 0 })).toBe(false);
    }
    expect(probed.limiter.queueDepth).toBe(untouched.limiter.queueDepth);

    // Release both in lockstep and compare when each caller is let through.
    const releases: Record<string, number[]> = { probed: [], untouched: [] };
    const track = (key: string, limiter: Pacer | QueuedLimiter, at: () => number): void => {
      void limiter.tryAcquire(1, { timeoutMs: 60_000 }).then(() => releases[key]?.push(at()));
    };
    let now = 0;
    track('probed', probed.limiter, () => now);
    track('untouched', untouched.limiter, () => now);

    for (let step = 0; step < 20; step++) {
      now += 10_000;
      probed.clock.advance(micros(10_000));
      untouched.clock.advance(micros(10_000));
      await flush();
      expect(probed.limiter.queueDepth).toBe(untouched.limiter.queueDepth);
    }

    expect(releases.probed).toEqual(releases.untouched);
    expect(releases.probed).toHaveLength(1);
  });
});

describe('the acquire / tryAcquire pair', () => {
  it('agrees across every limiter in the package', async () => {
    const clock = new ManualClock();
    const warm = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);
    const paced = new Pacer({ permitsPerSecond: 100, maxQueueDelayMs: 15 }, clock);
    const queued = new QueuedLimiter(
      new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock),
      { maxQueueDelayMs: 15 },
      clock,
    );

    // Every limiter exposes both halves of the pair.
    for (const limiter of [warm, paced, queued]) {
      expect(typeof limiter.acquire).toBe('function');
      expect(typeof limiter.tryAcquire).toBe('function');
    }

    // And a first call succeeds on each, whichever half is used.
    expect(await warm.tryAcquire(1, 0)).not.toBe(false);
    expect(await paced.tryAcquire(1, { timeoutMs: 0 })).toBe(true);
    expect(await queued.tryAcquire(1, { timeoutMs: 0 })).toBe(true);
  });
});
