import { describe, expect, it } from 'vitest';
import * as publicApi from '../src/index.js';
import type { AcquireOptions, AcquireResult, Clock, WarmupOptions } from '../src/index.js';

describe('public surface', () => {
  // Adding a name here is a minor release; removing one is breaking. This
  // test exists so neither happens by accident.
  it('exports exactly the documented names', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'ManualClock',
      'Pacer',
      'QueuedLimiter',
      'RateLimitRejectedError',
      'SystemClock',
      'WarmupLimiter',
    ]);
  });

  it('keeps the algorithm internals unexported', () => {
    for (const name of [
      'SmoothWarmingUp',
      'reserve',
      'resync',
      'deriveConstants',
      'WaitQueue',
      'reserveSlot',
      'checkBounds',
      'derivePacingConstants',
    ]) {
      expect(publicApi).not.toHaveProperty(name);
    }
  });

  it('exports the types callers need to write their own signatures', () => {
    // Checked by the type checker: this stops compiling if a type is dropped
    // or renamed.
    const options: WarmupOptions = { permitsPerSecond: 10, warmupPeriodMs: 100 };
    const clock: Clock = new publicApi.ManualClock();
    const acquireOptions: AcquireOptions = { signal: new AbortController().signal };
    const result: AcquireResult = { waitedMs: 0, storedPermitsAfter: 0 };

    expect([options, clock, acquireOptions, result]).toHaveLength(4);
  });

  it('builds a working limiter from the entry point alone', async () => {
    const clock = new publicApi.ManualClock();
    const limiter = new publicApi.WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);

    expect(await limiter.acquire()).toEqual({ waitedMs: 0, storedPermitsAfter: 299 });
    expect(await limiter.tryAcquire(1, 0)).toBe(false);
  });
});
