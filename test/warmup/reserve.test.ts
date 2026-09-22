import { describe, expect, it } from 'vitest';
import { deriveConstants } from '../../src/warmup/constants.js';
import { reserve } from '../../src/warmup/reserve.js';
import { resync, type WarmupState } from '../../src/warmup/state.js';
import { expectWithin } from '../helpers/expect-within.js';
import { loadGoldenConfig, loadGoldenVectors } from '../helpers/golden-vectors.js';

const config = loadGoldenConfig();
const constants = deriveConstants({
  permitsPerSecond: config.input.stableRatePermitsPerSecond,
  warmupPeriodMs: config.input.warmupPeriodMicros / 1000,
  coldFactor: config.input.coldFactor,
});

function coldState(): WarmupState {
  return {
    storedPermits: config.initialState.storedPermits,
    nextFreeTicketMicros: config.initialState.nextFreeTicketMicros,
  };
}

describe('reserve', () => {
  // One test replays the whole script: each step depends on the state the
  // previous steps left behind, so the steps cannot run independently.
  it('replays all golden vectors from a cold start', () => {
    const state = coldState();
    const { timeMicros, permits } = config.tolerance;

    for (const vector of loadGoldenVectors()) {
      const at = `step ${String(vector.step)} (${vector.exercises})`;
      const grant = reserve(state, constants, vector.permits, vector.nowMicros);

      expect.soft(Math.abs(grant - vector.expectGrantMicros), `${at}: grant`).toBeLessThanOrEqual(
        timeMicros,
      );
      expect
        .soft(Math.abs(state.storedPermits - vector.expectStoredAfter), `${at}: stored after`)
        .toBeLessThanOrEqual(permits);
      expect
        .soft(
          Math.abs(state.nextFreeTicketMicros - vector.expectNextFreeMicros),
          `${at}: next free after`,
        )
        .toBeLessThanOrEqual(timeMicros);
    }
  });

  // Spec §5.9 invariants 2 and 3. Calling resync first and then reserve at
  // the same instant separates the two halves: reserve's own resync is then a
  // no-op, so any change it makes is the acquisition alone.
  it('lets idle time only add permits, and acquisitions only remove them', () => {
    const state = coldState();
    const script: readonly (readonly [nowMicros: number, permits: number])[] = [
      [0, 1], [0, 40], [12_345, 1], [262_345, 3], [3_362_345, 150], [3_362_345, 1],
      [4_262_345, 20], [4_262_346, 500], [14_262_346, 2], [14_262_346, 299], [15_762_346, 75],
    ];

    for (const [nowMicros, permits] of script) {
      const beforeIdle = state.storedPermits;
      resync(state, constants, nowMicros);
      expect(state.storedPermits).toBeGreaterThanOrEqual(beforeIdle);
      expect(state.storedPermits).toBeLessThanOrEqual(constants.maxPermits);

      const beforeAcquire = state.storedPermits;
      reserve(state, constants, permits, nowMicros);
      expect(state.storedPermits).toBeLessThanOrEqual(beforeAcquire);
      expect(state.storedPermits).toBeGreaterThanOrEqual(0);
    }
  });

  it('grants the first caller immediately, even when cold', () => {
    expect(reserve(coldState(), constants, 1, 0)).toBe(0);
  });

  it('charges the stable interval for fresh permits once the pot is empty', () => {
    const state: WarmupState = { storedPermits: 0, nextFreeTicketMicros: 0 };
    reserve(state, constants, 5, 0);
    expectWithin(state.nextFreeTicketMicros, 5 * constants.stableIntervalMicros, 1e-9);
    expect(state.storedPermits).toBe(0);
  });

  it('grants a caller who arrives after the next free ticket at their own time', () => {
    const state: WarmupState = { storedPermits: 0, nextFreeTicketMicros: 40_000 };
    expect(reserve(state, constants, 1, 90_000)).toBe(90_000);
  });

  it('makes a caller who arrives during debt wait for the earlier reservation', () => {
    const state: WarmupState = { storedPermits: 0, nextFreeTicketMicros: 40_000 };
    expect(reserve(state, constants, 1, 10_000)).toBe(40_000);
    expect(state.nextFreeTicketMicros).toBe(50_000);
  });
});
