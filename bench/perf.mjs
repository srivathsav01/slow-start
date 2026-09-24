// Cost measurements: what the limiter itself costs to run (§13.2).
//
// These are properties of the machine, not of the algorithm, so unlike the
// behavioural scenarios they are NOT reproducible across hardware. The
// hardware, OS and Node version are recorded alongside the numbers, per
// §13.4. Run via `npm run bench:perf`.

import console from 'node:console';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { ManualClock, SystemClock, WarmupLimiter } from 'slow-start';
import { percentile, summarize } from './lib/stats.mjs';

const resultsDir = fileURLToPath(new URL('results/', import.meta.url));
mkdirSync(resultsDir, { recursive: true });

const CONFIG = { permitsPerSecond: 100, warmupPeriodMs: 3000, coldFactor: 3 };

// One simulated second per call: comfortably more than the 30 ms a fully cold
// permit costs, so every caller is granted immediately and no measurement is
// waiting on a clock that only moves between iterations.
const ADVANCE_PER_CALL_NANOS = 1_000_000_000n;

const nanosNow = () => process.hrtime.bigint();

/** A limiter-shaped object that does nothing, to subtract the harness cost. */
class NoopLimiter {
  async acquire() {
    return { waitedMs: 0, storedPermitsAfter: 0 };
  }
}

/**
 * Cost of one acquisition with no waiting involved.
 *
 * Time is advanced generously before each call, so every caller is granted
 * immediately and `sleep` returns an already-resolved promise. What is left
 * is the limiter's own arithmetic plus one `await`; the no-op baseline
 * measures that `await`, the loop and the clock, and is subtracted.
 */
async function acquisitionCost(iterations = 200_000) {
  const measure = async (limiter, clock) => {
    // Warm the JIT before measuring.
    for (let i = 0; i < 20_000; i += 1) {
      clock.advance(ADVANCE_PER_CALL_NANOS);
      await limiter.acquire();
    }
    const start = nanosNow();
    for (let i = 0; i < iterations; i += 1) {
      clock.advance(ADVANCE_PER_CALL_NANOS);
      await limiter.acquire();
    }
    return Number(nanosNow() - start) / iterations;
  };

  const clock = new ManualClock();
  const limiterNanos = await measure(new WarmupLimiter(CONFIG, clock), clock);
  const baselineClock = new ManualClock();
  const baselineNanos = await measure(new NoopLimiter(), baselineClock);

  return {
    iterations,
    perAcquisitionNanos: limiterNanos,
    baselineNanos,
    limiterWorkNanos: limiterNanos - baselineNanos,
  };
}

/**
 * Timer accuracy: `actual - requested` for real sleeps, which must never be
 * negative (invariant 8).
 */
async function timerAccuracy(samplesPerRequest = 40) {
  const clock = new SystemClock();
  const requests = [0n, 100_000n, 1_000_000n, 3_400_000n, 10_000_000n]; // ns
  const byRequest = {};
  const all = [];

  for (const requested of requests) {
    const errorsMicros = [];
    for (let i = 0; i < samplesPerRequest; i += 1) {
      const start = clock.now();
      await clock.sleep(requested);
      errorsMicros.push(Number(clock.now() - start - requested) / 1000);
    }
    byRequest[`${String(Number(requested) / 1000)}us`] = {
      lateByMicros: summarize(errorsMicros),
    };
    all.push(...errorsMicros);
  }

  return {
    samples: all.length,
    neverEarly: all.every((error) => error >= 0),
    lateByMicros: summarize(all),
    p99LateMicros: percentile(all, 99),
    byRequestedDuration: byRequest,
    note:
      'Timer granularity is an OS property. Windows schedules timers on a ~15.6 ms tick unless a ' +
      'process raises the resolution, so short sleeps land on that tick. Never-early is the ' +
      'contract (invariant 8); lateness is reported, not claimed away.',
  };
}

/**
 * Memory held per pending caller: the empirical check on §9.2's claim that a
 * waiting caller costs a promise and a queue entry, nothing more.
 */
async function pendingCallerMemory(callers = 50_000) {
  const heapAfterGc = () => {
    globalThis.gc?.();
    return process.memoryUsage().heapUsed;
  };

  // Control: the cost of holding the same number of unresolved promises in an
  // array, with no limiter involved. Subtracting it leaves the limiter's own
  // per-caller cost.
  const controlBefore = heapAfterGc();
  const control = [];
  for (let i = 0; i < callers; i += 1) control.push(new Promise(() => undefined));
  const controlBytes = heapAfterGc() - controlBefore;
  control.length = 0;

  // Layer 2: the sleep alone, without the limiter above it.
  const sleepClock = new ManualClock();
  const sleepBefore = heapAfterGc();
  const sleeps = [];
  for (let i = 0; i < callers; i += 1) sleeps.push(sleepClock.sleep(BigInt(i + 1) * 1_000_000n));
  const sleepBytes = heapAfterGc() - sleepBefore;
  sleepClock.advance(BigInt(callers + 10) * 1_000_000n);
  await Promise.all(sleeps);

  // Layer 3: a full acquisition waiting on a manual clock.
  const clock = new ManualClock();
  const limiter = new WarmupLimiter({ permitsPerSecond: 1, warmupPeriodMs: 1000 }, clock);
  const before = heapAfterGc();
  const pending = [];
  for (let i = 0; i < callers; i += 1) pending.push(limiter.acquire());
  const totalBytes = heapAfterGc() - before;
  clock.advance(BigInt(callers + 10) * 1_000_000_000n);
  await Promise.all(pending);

  // The production path: real timers instead of a queue entry. Aborting
  // releases them, which is also what clears the timers.
  const controller = new AbortController();
  const realLimiter = new WarmupLimiter({ permitsPerSecond: 1, warmupPeriodMs: 1000 });
  const realBefore = heapAfterGc();
  const realPending = [];
  for (let i = 0; i < callers; i += 1) {
    realPending.push(realLimiter.acquire(1, { signal: controller.signal }).catch(() => undefined));
  }
  const realBytes = heapAfterGc() - realBefore;
  controller.abort();
  await Promise.all(realPending);

  return {
    callers,
    bytesPerPendingCaller: {
      bareUnresolvedPromise: controlBytes / callers,
      clockSleepOnly: sleepBytes / callers,
      acquireOnManualClock: totalBytes / callers,
      acquireOnSystemClock: realBytes / callers,
    },
    gcForced: typeof globalThis.gc === 'function',
    note:
      'A waiting caller costs a fixed amount: two async frames (acquire and sleep), their ' +
      'promises, and either a queue entry (ManualClock) or a timer (SystemClock). Most of it is ' +
      "V8's per-suspension async frame, not the library's own data. The cost is per WAITING " +
      'caller and is released on resolution; nothing accumulates per acquisition — see the ' +
      'repeated-cycles scenario. Run with `node --expose-gc` for a figure not inflated by ' +
      'uncollected garbage.',
  };
}

const [cpu] = cpus();
const results = {
  methodology: {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: cpu?.model ?? 'unknown',
    cores: cpus().length,
    totalMemoryGb: Math.round(totalmem() / 1024 ** 3),
    note: 'Machine-dependent. Reproduce on your own hardware before quoting.',
  },
  acquisitionCost: await acquisitionCost(),
  timerAccuracy: await timerAccuracy(),
  pendingCallerMemory: await pendingCallerMemory(),
};

writeFileSync(join(resultsDir, 'perf.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
console.log('\nWrote bench/results/perf.json');
