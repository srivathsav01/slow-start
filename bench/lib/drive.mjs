// The deterministic driver every behavioural scenario runs on.
//
// Callers arrive at known times on a ManualClock; this records when each was
// let through. No real time passes, so a scenario spanning minutes of
// simulated time finishes in milliseconds and produces identical numbers on
// every machine.

import { setImmediate } from 'node:timers';

const DEFAULT_STEP_MICROS = 100;
const DEFAULT_MAX_MICROS = 600_000_000; // Ten minutes of simulated time.

/** Lets promises that became due actually run their callbacks. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {import('slow-start').ManualClock} clock
 * @param {{ acquire: (permits?: number) => Promise<unknown> }} limiter
 *   Built on `clock`.
 * @param {{ atMicros: number, permits?: number }[]} arrivals
 *   Sorted by `atMicros`.
 * @param {{ stepMicros?: number, maxMicros?: number }} [options]
 * @returns {Promise<{ atMicros: number, permits: number, grantMicros: number }[]>}
 *   One record per arrival, in arrival order.
 */
export async function drive(clock, limiter, arrivals, options = {}) {
  const stepMicros = options.stepMicros ?? DEFAULT_STEP_MICROS;
  const maxMicros = options.maxMicros ?? DEFAULT_MAX_MICROS;

  const records = arrivals.map((arrival) => ({
    atMicros: arrival.atMicros,
    permits: arrival.permits ?? 1,
    grantMicros: Number.NaN,
    result: undefined,
  }));

  let nowMicros = 0;
  let nextToIssue = 0;
  let pending = 0;

  while (nextToIssue < records.length || pending > 0) {
    // 1. Everyone who has arrived reserves now, in arrival order. The
    //    reservations are synchronous, so order is preserved exactly.
    while (nextToIssue < records.length && records[nextToIssue].atMicros <= nowMicros) {
      const record = records[nextToIssue];
      nextToIssue += 1;
      pending += 1;
      void limiter.acquire(record.permits).then((result) => {
        // Read the clock here: this is when the caller was released.
        record.grantMicros = nowMicros;
        record.result = result;
        pending -= 1;
      });
    }

    // 2. Let every caller whose wait has elapsed resolve.
    await flush();
    if (nextToIssue >= records.length && pending === 0) break;

    // 3. Move time on: to the next arrival if nothing is waiting, otherwise
    //    one step. Jumping keeps long idle gaps cheap.
    const nextArrival = nextToIssue < records.length ? records[nextToIssue].atMicros : Infinity;
    const target = pending > 0 ? Math.min(nowMicros + stepMicros, nextArrival) : nextArrival;
    const delta = Math.max(1, Math.ceil(target - nowMicros));

    clock.advance(BigInt(delta) * 1000n);
    nowMicros += delta;

    // 4. A caller that never resolves is a bug; fail rather than hang.
    if (nowMicros > maxMicros) {
      throw new Error(
        `drive: gave up at ${nowMicros} µs with ${pending} caller(s) still waiting ` +
          `and ${records.length - nextToIssue} still to arrive`,
      );
    }
  }

  return records;
}

/** Arrivals all at once at `atMicros`, the shape a burst scenario needs. */
export function burst(count, atMicros = 0, permits = 1) {
  return Array.from({ length: count }, () => ({ atMicros, permits }));
}

/** `count` arrivals spaced `everyMicros` apart, starting at `fromMicros`. */
export function paced(count, everyMicros, fromMicros = 0, permits = 1) {
  return Array.from({ length: count }, (_, index) => ({
    atMicros: fromMicros + index * everyMicros,
    permits,
  }));
}
