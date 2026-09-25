import { describe, expect, it } from 'vitest';
import { RateLimitRejectedError } from '../../src/core/errors.js';
import { derivePacingConstants } from '../../src/pacing/pacing-constants.js';
import {
  checkBounds,
  type PacingState,
  reserveSlot,
  waitForNextSlotMicros,
} from '../../src/pacing/slot.js';

// interval 10,000 us; delay bound 1,000,000 us; depth bound 1000.
const constants = derivePacingConstants({ permitsPerSecond: 100 });

describe('reserveSlot', () => {
  it('admits the first caller immediately and advances the slot', () => {
    const state: PacingState = { nextSlotMicros: 0 };
    expect(reserveSlot(state, constants, 1, 0)).toBe(0);
    expect(state.nextSlotMicros).toBe(10_000);
  });

  it('spaces callers by one interval each', () => {
    const state: PacingState = { nextSlotMicros: 0 };
    const waits = [0, 0, 0].map(() => reserveSlot(state, constants, 1, 0));
    expect(waits).toEqual([0, 10_000, 20_000]);
    expect(state.nextSlotMicros).toBe(30_000);
  });

  it('charges one interval per permit', () => {
    const state: PacingState = { nextSlotMicros: 0 };
    expect(reserveSlot(state, constants, 3, 0)).toBe(0);
    expect(state.nextSlotMicros).toBe(30_000);
  });

  it('does not bank idle time, unlike a token bucket', () => {
    const state: PacingState = { nextSlotMicros: 20_000 };
    // Idle from 20,000 to 50,000 would be three permits' worth of credit in a
    // token bucket. Here it buys nothing beyond going first.
    expect(reserveSlot(state, constants, 1, 50_000)).toBe(0);
    expect(state.nextSlotMicros).toBe(60_000);
    expect(reserveSlot(state, constants, 1, 50_000)).toBe(10_000);
  });

  it('keeps grant times non-decreasing, which is what lets one timer serve the queue', () => {
    const state: PacingState = { nextSlotMicros: 0 };
    let now = 0;
    let previousGrant = -Infinity;
    for (const step of [0, 0, 5_000, 0, 100_000, 1, 0, 40_000]) {
      now += step;
      const grant = now + reserveSlot(state, constants, 1, now);
      expect(grant).toBeGreaterThanOrEqual(previousGrant);
      previousGrant = grant;
    }
  });
});

describe('waitForNextSlotMicros', () => {
  it('reports the wait without taking the slot', () => {
    const state: PacingState = { nextSlotMicros: 30_000 };
    expect(waitForNextSlotMicros(state, 0)).toBe(30_000);
    expect(waitForNextSlotMicros(state, 0)).toBe(30_000);
    expect(state).toEqual({ nextSlotMicros: 30_000 });
  });

  it('is never negative for a slot already in the past', () => {
    expect(waitForNextSlotMicros({ nextSlotMicros: 10_000 }, 90_000)).toBe(0);
  });

  it('agrees with what reserveSlot goes on to return', () => {
    const state: PacingState = { nextSlotMicros: 45_000 };
    expect(waitForNextSlotMicros(state, 12_000)).toBe(reserveSlot(state, constants, 1, 12_000));
  });
});

describe('checkBounds', () => {
  it('permits a wait inside the standing bound', () => {
    expect(() => {
      checkBounds(500_000, 0, constants);
    }).not.toThrow();
  });

  it('refuses a wait beyond the standing bound', () => {
    try {
      checkBounds(1_500_000, 7, constants);
      expect.unreachable('should have thrown');
    } catch (caught) {
      const error = caught as RateLimitRejectedError;
      expect(error).toBeInstanceOf(RateLimitRejectedError);
      expect(error.reason).toBe('delay');
      expect(error.waitMs).toBe(1500);
      expect(error.queueDepth).toBe(7);
      expect(error.message).toContain('maxQueueDelayMs of 1000ms');
    }
  });

  it('lets a per-call timeout tighten the bound', () => {
    expect(() => {
      checkBounds(500_000, 0, constants, 250_000);
    }).toThrow(RateLimitRejectedError);
    expect(() => {
      checkBounds(200_000, 0, constants, 250_000);
    }).not.toThrow();
  });

  // The surprising direction, pinned down on purpose.
  it('does NOT let a generous per-call timeout extend past the standing bound', () => {
    try {
      checkBounds(1_500_000, 0, constants, 60_000_000); // caller asked for 60 s
      expect.unreachable('should have thrown');
    } catch (caught) {
      const error = caught as RateLimitRejectedError;
      expect(error.reason).toBe('delay');
      // Refused at the standing 1,000 ms, and the message says so rather
      // than quoting the 60,000 ms the caller asked for.
      expect(error.message).toContain('maxQueueDelayMs of 1000ms');
      expect(error.message).not.toContain('60000');
    }
  });

  it('refuses when the queue is full, whatever the wait', () => {
    try {
      checkBounds(0, 1000, constants);
      expect.unreachable('should have thrown');
    } catch (caught) {
      const error = caught as RateLimitRejectedError;
      expect(error.reason).toBe('depth');
      expect(error.queueDepth).toBe(1000);
      expect(error.message).toBe('queue is full: 1000 callers already waiting');
    }
  });

  it('reports depth rather than delay when both bounds are exceeded', () => {
    try {
      checkBounds(9_000_000, 1000, constants);
      expect.unreachable('should have thrown');
    } catch (caught) {
      expect((caught as RateLimitRejectedError).reason).toBe('depth');
    }
  });

  it('accepts a queue one below the cap', () => {
    expect(() => {
      checkBounds(0, 999, constants);
    }).not.toThrow();
  });

  it('accepts a wait exactly at the bound', () => {
    expect(() => {
      checkBounds(1_000_000, 0, constants);
    }).not.toThrow();
  });
});
