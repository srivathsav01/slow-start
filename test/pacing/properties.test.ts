import { setImmediate } from 'node:timers';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/clock/manual-clock.js';
import { RateLimitRejectedError } from '../../src/core/errors.js';
import { Pacer } from '../../src/pacing/pacer.js';
import type { PacerOptions } from '../../src/pacing/pacing-constants.js';

// Model-based properties for the pacer. A separate model of the slot
// scheduler and the queue policy is stepped alongside the real one, and every
// decision is compared: admitted or refused, why, who is released and when.
//
// Rates are chosen so 1,000,000 / rate is a whole number of microseconds, and
// the clock only ever moves in whole microseconds. Every value is then exact,
// so a disagreement is a real one rather than a rounding artefact.

const EXACT_RATES = [1, 2, 4, 5, 8, 10, 20, 25, 40, 50, 100, 125, 200, 250, 500, 1000];

const configArb = fc.record({
  permitsPerSecond: fc.constantFrom(...EXACT_RATES),
  maxQueueDelayMs: fc.integer({ min: 1, max: 5_000 }),
  maxQueueDepth: fc.integer({ min: 1, max: 20 }),
});

type Operation =
  | { kind: 'arrive'; permits: number; timeoutMs: number | undefined }
  | { kind: 'advance'; micros: number }
  | { kind: 'abort' };

// Weighted so queues actually form: arrivals outnumber advances, and most
// advances are short. With uniform weights and long advances, most scripts
// drain the queue immediately and never exercise tombstones or the depth
// bound at all.
const operationsArb = fc.array(
  fc.oneof(
    {
      arbitrary: fc.record({
        kind: fc.constant('arrive' as const),
        permits: fc.integer({ min: 1, max: 5 }),
        timeoutMs: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: undefined }),
      }),
      weight: 5,
    },
    {
      arbitrary: fc.record({
        kind: fc.constant('advance' as const),
        micros: fc.integer({ min: 0, max: 40_000 }),
      }),
      weight: 3,
    },
    {
      arbitrary: fc.record({
        kind: fc.constant('advance' as const),
        micros: fc.integer({ min: 0, max: 2_000_000 }),
      }),
      weight: 1,
    },
    // Cancels whoever has been waiting longest, if anyone is.
    { arbitrary: fc.record({ kind: fc.constant('abort' as const) }), weight: 2 },
  ),
  { minLength: 5, maxLength: 30 },
);

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Caller {
  id: number;
  grantMicros: number;
  settled: boolean;
  rejected: unknown;
  controller: AbortController;
}

/** Runs a script against the real pacer and an independent model at once. */
async function run(
  config: PacerOptions & { maxQueueDelayMs: number; maxQueueDepth: number },
  operations: readonly Operation[],
): Promise<{
  failures: string[];
  outcomes: string[];
  grants: number[];
}> {
  const intervalMicros = 1_000_000 / config.permitsPerSecond;
  const delayBoundMicros = config.maxQueueDelayMs * 1000;

  const clock = new ManualClock();
  const pacer = new Pacer(config, clock);

  let nowMicros = 0;
  let slotMicros = 0; // the model's copy of nextSlotMicros
  let nextId = 0;
  const waiting: Caller[] = []; // admitted by the model, not yet due
  const failures: string[] = [];
  const outcomes: string[] = [];
  const grants: number[] = [];
  let previousGrant = -Infinity;

  const at = (index: number): string => `op ${String(index)}`;

  for (const [index, operation] of operations.entries()) {
    if (operation.kind === 'advance') {
      nowMicros += operation.micros;
      clock.advance(BigInt(operation.micros) * 1000n);
      await flush();

      for (const caller of waiting) {
        const due = caller.grantMicros <= nowMicros;
        if (!due && caller.settled) {
          failures.push(`${at(index)}: caller ${caller.id} released before ${caller.grantMicros}`);
        }
        if (due && !caller.settled) {
          failures.push(`${at(index)}: caller ${caller.id} not released at ${caller.grantMicros}`);
        }
      }
      // Everyone due has been checked; drop them from the model.
      for (let i = waiting.length - 1; i >= 0; i -= 1) {
        if ((waiting[i]?.grantMicros ?? Infinity) <= nowMicros) waiting.splice(i, 1);
      }
      // Draining is where a tombstone could be miscounted, so the depth is
      // compared here too, not only after arrivals.
      if (pacer.queueDepth !== waiting.length) {
        failures.push(
          `${at(index)}: after draining queueDepth ${pacer.queueDepth}, model says ${waiting.length}`,
        );
      }
      continue;
    }

    if (operation.kind === 'abort') {
      const victim = waiting.shift();
      if (!victim) continue;

      victim.controller.abort();
      await flush();
      outcomes.push(`abort ${String(victim.id)}`);

      if (victim.rejected === undefined) {
        failures.push(`${at(index)}: caller ${victim.id} did not reject on abort`);
      }
      // Its slot is forfeited, never reassigned, so the model's slot stays
      // exactly where it was.
      if (pacer.queueDepth !== waiting.length) {
        failures.push(
          `${at(index)}: after abort queueDepth ${pacer.queueDepth}, model says ${waiting.length}`,
        );
      }
      continue;
    }

    // --- an arrival: decide with the model first, then ask the pacer ---
    const wouldWait = Math.max(0, slotMicros - nowMicros);
    const depth = waiting.length;
    const limit = Math.min(delayBoundMicros, (operation.timeoutMs ?? Infinity) * 1000);

    let expected: 'admitted' | 'depth' | 'delay';
    if (depth >= config.maxQueueDepth) expected = 'depth';
    else if (wouldWait > limit) expected = 'delay';
    else expected = 'admitted';

    const id = nextId++;
    const caller: Caller = {
      id,
      grantMicros: Math.max(slotMicros, nowMicros),
      settled: false,
      rejected: undefined,
      controller: new AbortController(),
    };

    const options = {
      signal: caller.controller.signal,
      ...(operation.timeoutMs === undefined ? {} : { timeoutMs: operation.timeoutMs }),
    };
    // Never awaited: an admitted caller only resolves once the clock reaches
    // its grant, so awaiting here would deadlock the script.
    void pacer.acquire(operation.permits, options).then(
      () => {
        caller.settled = true;
      },
      (error: unknown) => {
        caller.settled = true;
        caller.rejected = error;
      },
    );
    await flush();

    const refused = caller.rejected;
    if (expected === 'admitted') {
      if (refused !== undefined) {
        failures.push(`${at(index)}: refused but the model admits (wait ${wouldWait}, depth ${depth})`);
        continue;
      }
      outcomes.push(`admit ${String(operation.permits)}`);
      grants.push(caller.grantMicros);
      if (caller.grantMicros < previousGrant) {
        failures.push(`${at(index)}: grant ${caller.grantMicros} went backwards from ${previousGrant}`);
      }
      previousGrant = caller.grantMicros;

      slotMicros = caller.grantMicros + operation.permits * intervalMicros;
      if (caller.grantMicros > nowMicros) waiting.push(caller);
      else if (!caller.settled) failures.push(`${at(index)}: zero-wait caller was queued`);
    } else {
      if (!(refused instanceof RateLimitRejectedError)) {
        failures.push(`${at(index)}: admitted but the model refuses with '${expected}'`);
        continue;
      }
      if (refused.reason !== expected) {
        failures.push(`${at(index)}: refused with '${refused.reason}', expected '${expected}'`);
      }
      outcomes.push(`refuse ${refused.reason}`);
      // A refusal must leave the timeline exactly where it was: the model's
      // slot is deliberately not advanced here.
    }

    if (pacer.queueDepth !== waiting.length) {
      failures.push(`${at(index)}: queueDepth ${pacer.queueDepth}, model says ${waiting.length}`);
    }
  }

  return { failures, outcomes, grants };
}

describe('pacer properties (fast-check)', () => {
  it('matches an independent model of the slots and the bounds', async () => {
    await fc.assert(
      fc.asyncProperty(configArb, operationsArb, async (config, operations: Operation[]) => {
        const { failures } = await run(config, operations);
        expect(failures).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it('never exceeds maxQueueDepth and never releases anyone early', async () => {
    await fc.assert(
      fc.asyncProperty(configArb, operationsArb, async (config, operations: Operation[]) => {
        const clock = new ManualClock();
        const pacer = new Pacer(config, clock);
        const settled: boolean[] = [];

        for (const operation of operations) {
          if (operation.kind === 'advance') {
            clock.advance(BigInt(operation.micros) * 1000n);
          } else if (operation.kind === 'arrive') {
            const index = settled.length;
            settled.push(false);
            void pacer
              .acquire(
                operation.permits,
                operation.timeoutMs === undefined ? {} : { timeoutMs: operation.timeoutMs },
              )
              .then(
                () => {
                  settled[index] = true;
                },
                () => {
                  settled[index] = true;
                },
              );
          }
          await flush();
          expect(pacer.queueDepth).toBeLessThanOrEqual(config.maxQueueDepth);
          expect(pacer.queueDepth).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('gives identical results when the same script is replayed', async () => {
    await fc.assert(
      fc.asyncProperty(configArb, operationsArb, async (config, operations: Operation[]) => {
        const first = await run(config, operations);
        const second = await run(config, operations);
        expect(second.outcomes).toEqual(first.outcomes);
        expect(second.grants).toEqual(first.grants);
      }),
      { numRuns: 40 },
    );
  });

  it('holds at most one live timer, whatever the script', async () => {
    class CountingClock extends ManualClock {
      live = 0;
      maxLive = 0;

      override async sleep(nanos: bigint, signal?: AbortSignal): Promise<void> {
        this.live += 1;
        this.maxLive = Math.max(this.maxLive, this.live);
        try {
          await super.sleep(nanos, signal);
        } finally {
          this.live -= 1;
        }
      }
    }

    await fc.assert(
      fc.asyncProperty(configArb, operationsArb, async (config, operations: Operation[]) => {
        const clock = new CountingClock();
        const pacer = new Pacer(config, clock);

        for (const operation of operations) {
          if (operation.kind === 'advance') clock.advance(BigInt(operation.micros) * 1000n);
          else if (operation.kind === 'arrive') {
            void pacer.acquire(operation.permits).catch(() => undefined);
          }
          await flush();
          expect(clock.maxLive).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('leaves the timeline untouched when it refuses', async () => {
    await fc.assert(
      fc.asyncProperty(
        configArb,
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 30 }),
        async (config, permits, probes) => {
          const clock = new ManualClock();
          const pacer = new Pacer(config, clock);

          // Issue without awaiting: queued callers never resolve on a clock
          // that does not move.
          const attempt = async (timeoutMs?: number): Promise<unknown> => {
            let outcome: unknown;
            void pacer
              .acquire(permits, timeoutMs === undefined ? {} : { timeoutMs })
              .catch((error: unknown) => {
                outcome = error;
              });
            await flush();
            return outcome;
          };

          // Fill the timeline until a caller is refused.
          let refused: RateLimitRejectedError | undefined;
          for (let i = 0; i < 200 && !refused; i += 1) {
            const error = await attempt();
            if (error instanceof RateLimitRejectedError) refused = error;
          }
          if (!refused) return; // this configuration never fills; nothing to check

          const depthBefore = pacer.queueDepth;
          for (let i = 0; i < probes; i += 1) {
            expect(await attempt(0)).toBeInstanceOf(RateLimitRejectedError);
          }

          // Refusals changed nothing: the same number of callers are waiting,
          // and a probe still refuses for the same reason.
          expect(pacer.queueDepth).toBe(depthBefore);
          expect((await attempt(0)) as RateLimitRejectedError).toHaveProperty(
            'reason',
            refused.reason,
          );
        },
      ),
      { numRuns: 40 },
    );
  });
});
