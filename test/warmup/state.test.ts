import { describe, expect, it } from 'vitest';
import { deriveConstants } from '../../src/warmup/constants.js';
import { resync, type WarmupState } from '../../src/warmup/state.js';
import { expectWithin } from '../helpers/expect-within.js';

// The verified configuration: coolDownIntervalMicros = 10000, maxPermits = 300.
const constants = deriveConstants({ permitsPerSecond: 100, warmupPeriodMs: 3000, coldFactor: 3 });

describe('resync', () => {
  describe('when time has passed since the next free ticket', () => {
    it.each([
      { why: 'turns idle time into permits', stored: 0, next: 0, now: 50_000, expected: 5 },
      { why: 'keeps fractional permits', stored: 0, next: 0, now: 15_000, expected: 1.5 },
      { why: 'adds to permits already stored', stored: 20, next: 0, now: 30_000, expected: 23 },
      { why: 'counts only the time since the next free ticket', stored: 0, next: 70_000, now: 100_000, expected: 3 },
      { why: 'caps at maxPermits', stored: 295, next: 0, now: 1_000_000, expected: 300 },
      { why: 'stays at maxPermits when already full', stored: 300, next: 0, now: 40_000, expected: 300 },
    ])('$why', ({ stored, next, now, expected }) => {
      const state: WarmupState = { storedPermits: stored, nextFreeTicketMicros: next };
      resync(state, constants, now);
      expectWithin(state.storedPermits, expected, 1e-9);
      // The next free ticket moves to now even when the bucket is already full.
      expect(state.nextFreeTicketMicros).toBe(now);
    });
  });

  describe('when no idle time has passed', () => {
    it.each([
      { why: 'leaves the state alone when no time has passed', now: 80_000 },
      { why: 'does not pull a future next free ticket back to now', now: 50_000 },
    ])('$why', ({ now }) => {
      const state: WarmupState = { storedPermits: 10, nextFreeTicketMicros: 80_000 };
      resync(state, constants, now);
      expect(state).toEqual({ storedPermits: 10, nextFreeTicketMicros: 80_000 });
    });

    it('does not earn permits during debt (golden trace after step 4)', () => {
      const state: WarmupState = { storedPermits: 10, nextFreeTicketMicros: 129_674 };
      resync(state, constants, 100_000);
      expect(state).toEqual({ storedPermits: 10, nextFreeTicketMicros: 129_674 });
    });
  });

  it('gives the same result whether idle time arrives in one piece or several', () => {
    const once: WarmupState = { storedPermits: 0, nextFreeTicketMicros: 0 };
    resync(once, constants, 90_000);

    const inSteps: WarmupState = { storedPermits: 0, nextFreeTicketMicros: 0 };
    resync(inSteps, constants, 20_000);
    resync(inSteps, constants, 55_000);
    resync(inSteps, constants, 90_000);

    expectWithin(inSteps.storedPermits, once.storedPermits, 1e-9);
    expect(inSteps.nextFreeTicketMicros).toBe(once.nextFreeTicketMicros);
  });

  it('refills an empty bucket in exactly the warm-up period', () => {
    const state: WarmupState = { storedPermits: 0, nextFreeTicketMicros: 0 };
    resync(state, constants, 3_000_000);
    expectWithin(state.storedPermits, constants.maxPermits, 1e-9);
  });
});
