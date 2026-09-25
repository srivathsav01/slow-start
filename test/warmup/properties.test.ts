import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/clock/manual-clock.js';
import {
  deriveConstants,
  type WarmupConstants,
  type WarmupOptions,
} from '../../src/warmup/constants.js';
import { SmoothWarmingUp } from '../../src/warmup/smooth-warming-up.js';
import { resync, type WarmupState } from '../../src/warmup/state.js';

// Spec §12.2. Every property maps to an invariant in §5.9.
//
// The configurations are random and deliberately unround, so nothing here
// depends on the verified 100/s, 3000 ms case the golden vectors use.

const options = fc
  .record({
    permitsPerSecond: fc.double({ min: 0.5, max: 10_000, noNaN: true, noDefaultInfinity: true }),
    warmupPeriodMs: fc.double({ min: 1, max: 60_000, noNaN: true, noDefaultInfinity: true }),
    coldFactor: fc.double({ min: 1.01, max: 10, noNaN: true, noDefaultInfinity: true }),
  })
  .map((record): WarmupOptions => record);

/** An arrival: wait this long, then ask for this many permits. */
const operations = fc.array(
  fc.record({
    advanceMicros: fc.nat({ max: 20_000_000 }),
    permits: fc.integer({ min: 1, max: 2_000 }),
  }),
  { maxLength: 50 },
);

type Operation = { advanceMicros: number; permits: number };

function build(options: WarmupOptions): {
  clock: ManualClock;
  machine: SmoothWarmingUp;
  constants: WarmupConstants;
} {
  const clock = new ManualClock();
  return { clock, machine: new SmoothWarmingUp(options, clock), constants: deriveConstants(options) };
}

const micros = (value: number): bigint => BigInt(value) * 1000n;

/** Relative comparison, so it works across configurations of any scale. */
function expectRelative(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThanOrEqual(tolerance);
}

describe('properties (fast-check)', () => {
  it('1, 4, 8: state stays bounded, no wait is negative, idle only adds permits', () => {
    fc.assert(
      fc.property(options, operations, (config, ops: Operation[]) => {
        const { clock, machine, constants } = build(config);

        for (const op of ops) {
          const beforeIdle = machine.snapshot().storedPermits;
          clock.advance(micros(op.advanceMicros));

          // peek resyncs on a copy, so it reports the post-idle level
          // without spending anything.
          machine.peekWaitMicros(1);
          const wait = machine.reserveMicros(op.permits);
          const after = machine.snapshot();

          expect(wait).toBeGreaterThanOrEqual(0);
          expect(after.storedPermits).toBeGreaterThanOrEqual(0);
          expect(after.storedPermits).toBeLessThanOrEqual(constants.maxPermits);
          if (op.advanceMicros === 0) {
            // Property 10: no time passed, so no permits can have appeared.
            expect(after.storedPermits).toBeLessThanOrEqual(beforeIdle);
          }
        }
      }),
    );
  });

  it('2: the next free ticket never moves backwards', () => {
    fc.assert(
      fc.property(options, operations, (config, ops: Operation[]) => {
        const { clock, machine } = build(config);
        let previous = machine.snapshot().nextFreeTicketMicros;

        for (const op of ops) {
          clock.advance(micros(op.advanceMicros));
          machine.reserveMicros(op.permits);
          const current = machine.snapshot().nextFreeTicketMicros;
          expect(current).toBeGreaterThanOrEqual(previous);
          previous = current;
        }
      }),
    );
  });

  it('3: an acquisition never increases stored permits', () => {
    fc.assert(
      fc.property(options, operations, (config, ops: Operation[]) => {
        const { clock, machine } = build(config);

        for (const op of ops) {
          clock.advance(micros(op.advanceMicros));
          // Two reservations at the same instant: the second cannot resync,
          // so its only effect is the acquisition itself.
          machine.reserveMicros(1);
          const before = machine.snapshot().storedPermits;
          machine.reserveMicros(op.permits);
          expect(machine.snapshot().storedPermits).toBeLessThanOrEqual(before);
        }
      }),
    );
  });

  it('4: with no acquisitions, permits only grow and stay capped', () => {
    fc.assert(
      fc.property(
        options,
        fc.array(fc.nat({ max: 5_000_000 }), { maxLength: 30 }),
        (config, gaps: number[]) => {
          // Driven through resync directly: this property is about idle time
          // alone, and every path through the machine also spends permits.
          const constants = deriveConstants(config);
          const state: WarmupState = { storedPermits: 0, nextFreeTicketMicros: 0 };
          let nowMicros = 0;
          let previous = state.storedPermits;

          for (const gap of gaps) {
            nowMicros += gap;
            resync(state, constants, nowMicros);
            expect(state.storedPermits).toBeGreaterThanOrEqual(previous);
            expect(state.storedPermits).toBeLessThanOrEqual(constants.maxPermits);
            previous = state.storedPermits;
          }
        },
      ),
    );
  });

  it('5: idling for the warm-up period refills the pot exactly', () => {
    fc.assert(
      fc.property(options, fc.integer({ min: 1, max: 2_000 }), (config, permits) => {
        const { clock, machine, constants } = build(config);
        machine.reserveMicros(permits);

        // Idle past the end of the reservation by a full warm-up period.
        const idleMicros = machine.snapshot().nextFreeTicketMicros + config.warmupPeriodMs * 1000;
        clock.advance(micros(Math.ceil(idleMicros)));
        machine.reserveMicros(1);

        // Full again, less the single permit just taken. Some configurations
        // hold less than one permit in total, and then the pot is simply
        // emptied.
        const expected = Math.max(0, constants.maxPermits - 1);
        expect(Math.abs(machine.snapshot().storedPermits - expected)).toBeLessThanOrEqual(
          1e-9 * Math.max(1, constants.maxPermits),
        );
      }),
    );
  });

  it('6: sustained demand converges to the stable rate', () => {
    fc.assert(
      fc.property(options, (config) => {
        const { clock, machine, constants } = build(config);
        let nowMicros = 0;

        // Drive continuous demand past the warm-up period.
        const drive = (): number => {
          const wait = Math.ceil(machine.reserveMicros(1));
          clock.advance(micros(wait));
          nowMicros += wait;
          return wait;
        };
        while (nowMicros <= config.warmupPeriodMs * 1000) drive();

        // The pot is drained now, so every further permit costs the stable
        // interval, give or take the microsecond rounding of the clock.
        for (let i = 0; i < 20; i++) {
          expectRelative(drive(), constants.stableIntervalMicros, 0.01);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('7: from fully cold, the first permit costs the cold interval', () => {
    fc.assert(
      fc.property(options, (config) => {
        const { machine, constants } = build(config);
        machine.reserveMicros(1); // The first caller is free; its cost lands here.
        const firstCost = machine.peekWaitMicros(1);

        // One permit taken from the very top of the curve: its average cost
        // sits within one slope-step of the cold interval, which is
        // stableInterval × coldFactor.
        expect(firstCost).toBeLessThanOrEqual(constants.coldIntervalMicros + 1e-6);
        expect(firstCost).toBeGreaterThanOrEqual(
          constants.coldIntervalMicros - constants.slopeMicrosPerPermit - 1e-6,
        );
      }),
    );
  });

  it('9: the same script replays identically', () => {
    fc.assert(
      fc.property(options, operations, (config, ops: Operation[]) => {
        const run = (): { waits: number[]; stored: number[]; nextFree: number[] } => {
          const { clock, machine } = build(config);
          const waits: number[] = [];
          const stored: number[] = [];
          const nextFree: number[] = [];
          for (const op of ops) {
            clock.advance(micros(op.advanceMicros));
            waits.push(machine.reserveMicros(op.permits));
            const state = machine.snapshot();
            stored.push(state.storedPermits);
            nextFree.push(state.nextFreeTicketMicros);
          }
          return { waits, stored, nextFree };
        };

        expect(run()).toEqual(run());
      }),
    );
  });

  it('10: a clock that does not move produces no permits and no corruption', () => {
    fc.assert(
      fc.property(options, fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 40 }),
        (config, requests: number[]) => {
          const { machine, constants } = build(config);
          let previousStored = machine.snapshot().storedPermits;
          let previousNextFree = machine.snapshot().nextFreeTicketMicros;

          for (const permits of requests) {
            machine.reserveMicros(permits);
            const state = machine.snapshot();
            expect(state.storedPermits).toBeLessThanOrEqual(previousStored);
            expect(state.storedPermits).toBeGreaterThanOrEqual(0);
            expect(state.nextFreeTicketMicros).toBeGreaterThanOrEqual(previousNextFree);
            expect(Number.isFinite(state.nextFreeTicketMicros)).toBe(true);
            previousStored = state.storedPermits;
            previousNextFree = state.nextFreeTicketMicros;
          }

          expect(previousStored).toBeLessThanOrEqual(constants.maxPermits);
        },
      ),
    );
  });
});
