// The behavioural scenarios of §13.1, scenarios 1–5.
//
// Scenarios 6 and 7 compose warm-up with pacing, which does not exist before
// v0.2.0; they are listed in the README as deferred rather than faked here.
//
// Every scenario runs on a ManualClock, so the numbers are exact properties
// of the algorithm and identical on every machine.

import { ManualClock, Pacer, QueuedLimiter, WarmupLimiter } from 'slow-start';
import { FixedRateLimiter, FixedWindowLimiter, TokenBucketLimiter } from './lib/baselines.mjs';
import { burst, drive, paced as pacedArrivals } from './lib/drive.mjs';
import { intervals, summarize, throughputSeries } from './lib/stats.mjs';

/** The verified configuration from verification/config.json. */
export const CONFIG = { permitsPerSecond: 100, warmupPeriodMs: 3000, coldFactor: 3 };

const STABLE_INTERVAL_MICROS = 1_000_000 / CONFIG.permitsPerSecond;
const COLD_INTERVAL_MICROS = STABLE_INTERVAL_MICROS * CONFIG.coldFactor;
const WARMUP_MICROS = CONFIG.warmupPeriodMs * 1000;
const MAX_PERMITS = 300; // See verification/config.json.

const STEP_MICROS = 250;

function warmupLimiter() {
  const clock = new ManualClock();
  return { clock, limiter: new WarmupLimiter(CONFIG, clock) };
}

async function run(limiterFactory, arrivals, options = {}) {
  const { clock, limiter } = limiterFactory();
  return drive(clock, limiter, arrivals, { stepMicros: STEP_MICROS, ...options });
}

const factories = {
  warmup: warmupLimiter,
  fixedRate: () => {
    const clock = new ManualClock();
    return { clock, limiter: new FixedRateLimiter(CONFIG, clock) };
  },
  tokenBucket: () => {
    const clock = new ManualClock();
    return {
      clock,
      limiter: new TokenBucketLimiter(
        { permitsPerSecond: CONFIG.permitsPerSecond, capacity: MAX_PERMITS },
        clock,
      ),
    };
  },
  // The shipped pacer, with bounds set wide so this measures pacing rather
  // than the queue policy, which scenario 7 covers.
  pacer: () => {
    const clock = new ManualClock();
    return {
      clock,
      limiter: new Pacer(
        { permitsPerSecond: CONFIG.permitsPerSecond, maxQueueDelayMs: 600_000, maxQueueDepth: 5000 },
        clock,
      ),
    };
  },
  fixedWindow: () => {
    const clock = new ManualClock();
    return {
      clock,
      limiter: new FixedWindowLimiter({ limit: CONFIG.permitsPerSecond, windowMs: 1000 }, clock),
    };
  },
};

/** 1. Steady state: continuous demand, well past the warm-up period. */
async function steadyState() {
  const records = await run(warmupLimiter, burst(600));
  const warmRecords = records.filter((record) => record.grantMicros >= WARMUP_MICROS);
  const warmIntervals = intervals(warmRecords);

  return {
    name: 'steady-state',
    title: '1. Steady state — sustained demand past warm-up',
    columns: ['index', 'grant_micros'],
    rows: records.map((record, index) => [index, record.grantMicros]),
    summary: {
      permitsAfterWarmup: warmRecords.length,
      stableIntervalMicros: STABLE_INTERVAL_MICROS,
      intervalMicros: summarize(warmIntervals),
      meanErrorPercent:
        ((summarize(warmIntervals).mean - STABLE_INTERVAL_MICROS) / STABLE_INTERVAL_MICROS) * 100,
    },
  };
}

/**
 * What one permit really costs when taken from a full pot, asked of the
 * limiter rather than read off grant times that the driver's step rounds.
 */
function firstPermitCostMicros() {
  const { limiter } = warmupLimiter();
  limiter.acquire(1).catch(() => undefined); // the first caller is free
  return limiter.peekWaitMicros(1);
}

/** 2. Cold-start burst: 400 requests at t=0 on a fresh limiter. */
async function coldStartBurst() {
  const arrivals = burst(400);
  const [warm, fixed, bucket] = await Promise.all([
    run(factories.warmup, arrivals),
    run(factories.fixedRate, arrivals),
    run(factories.tokenBucket, arrivals),
  ]);

  const bucketMicros = 250_000;
  const series = throughputSeries(warm, bucketMicros);

  const admittedBy = (records, micros) =>
    records.filter((record) => record.grantMicros <= micros).length;

  return {
    name: 'cold-start-burst',
    title: '2. Cold-start burst — 400 requests at t=0',
    columns: ['t_micros', 'warmup_permits_per_second'],
    rows: series.map((point) => [point.tMicros, point.permitsPerSecond]),
    summary: {
      admittedInFirstSecond: {
        warmup: admittedBy(warm, 1_000_000),
        fixedRate: admittedBy(fixed, 1_000_000),
        tokenBucket: admittedBy(bucket, 1_000_000),
      },
      firstIntervalMicros: {
        // Measured from grant times, so it is rounded up to the driver's step.
        measuredAtStepMicros: warm[1].grantMicros - warm[0].grantMicros,
        driverStepMicros: STEP_MICROS,
        // Asked of the limiter directly, so exact: one permit taken from a
        // full pot costs coldInterval minus half a slope step, not the cold
        // interval itself.
        exactFirstPermitMicros: firstPermitCostMicros(),
        coldIntervalMicros: COLD_INTERVAL_MICROS,
      },
      rampReachesStableAtMicros:
        series.find((point) => point.permitsPerSecond >= CONFIG.permitsPerSecond * 0.99)?.tMicros ??
        null,
      drainedAtMicros: Math.max(...warm.map((record) => record.grantMicros)),
    },
  };
}

/** 3. Idle → burst: warm the limiter, idle a full warm-up period, burst again. */
async function idleRecooling() {
  const firstBurst = burst(150, 0);
  const secondBurstAt = 4_000_000 + WARMUP_MICROS;
  const arrivals = [...firstBurst, ...burst(150, secondBurstAt)];
  const records = await run(warmupLimiter, arrivals);

  const first = records.slice(0, 150).map((record) => record.grantMicros);
  const second = records.slice(150).map((record) => record.grantMicros - secondBurstAt);
  const differences = first.map((grant, index) => Math.abs(second[index] - grant));

  return {
    name: 'idle-recooling',
    title: '3. Idle → burst — re-cooling after a full warm-up period of idleness',
    columns: ['index', 'first_burst_micros', 'second_burst_micros'],
    rows: first.map((grant, index) => [index, grant, second[index]]),
    summary: {
      firstBurstSpanMicros: first[first.length - 1],
      secondBurstSpanMicros: second[second.length - 1],
      maxDifferenceMicros: Math.max(...differences),
      note: 'The second burst is throttled like the first: the limiter went fully cold again.',
    },
  };
}

/** 4. Repeated burst/idle cycles: no drift, no leak, no corruption. */
async function repeatedCycles() {
  const cycles = 10;
  const cycleMicros = 2_000_000 + WARMUP_MICROS;
  const arrivals = Array.from({ length: cycles }, (_, cycle) =>
    burst(50, cycle * cycleMicros),
  ).flat();

  const records = await run(warmupLimiter, arrivals);
  const spans = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const slice = records.slice(cycle * 50, (cycle + 1) * 50);
    spans.push(slice[slice.length - 1].grantMicros - cycle * cycleMicros);
  }

  const drift = spans.slice(1).map((span) => Math.abs(span - spans[1]));

  return {
    name: 'repeated-cycles',
    title: '4. Repeated burst/idle cycles — drift check over 10 cycles',
    columns: ['cycle', 'span_micros'],
    rows: spans.map((span, cycle) => [cycle, span]),
    summary: {
      cycles,
      spanMicros: summarize(spans.slice(1)),
      maxDriftFromSecondCycleMicros: Math.max(...drift),
      note: 'Cycle 0 differs: the limiter starts fully cold with an empty timeline.',
    },
  };
}

/** 5. Warm-up versus token bucket versus fixed window, same burst. */
async function algorithmComparison() {
  const arrivals = burst(300);
  const [warm, bucket, window, fixed] = await Promise.all([
    run(factories.warmup, arrivals),
    run(factories.tokenBucket, arrivals),
    run(factories.fixedWindow, arrivals),
    run(factories.fixedRate, arrivals),
  ]);

  const bucketMicros = 250_000;
  const asSeries = (records) => throughputSeries(records, bucketMicros);
  const [warmSeries, bucketSeries, windowSeries, fixedSeries] = [warm, bucket, window, fixed].map(
    asSeries,
  );
  const length = Math.max(
    warmSeries.length,
    bucketSeries.length,
    windowSeries.length,
    fixedSeries.length,
  );

  const rows = [];
  for (let index = 0; index < length; index += 1) {
    rows.push([
      index * bucketMicros,
      warmSeries[index]?.permitsPerSecond ?? 0,
      bucketSeries[index]?.permitsPerSecond ?? 0,
      windowSeries[index]?.permitsPerSecond ?? 0,
      fixedSeries[index]?.permitsPerSecond ?? 0,
    ]);
  }

  const peak = (series) => Math.max(...series.map((point) => point.permitsPerSecond));

  return {
    name: 'algorithm-comparison',
    title: '5. Warm-up vs token bucket vs fixed window vs fixed rate — 300 requests at t=0',
    columns: [
      't_micros',
      'warmup_pps',
      'token_bucket_pps',
      'fixed_window_pps',
      'fixed_rate_pps',
    ],
    rows,
    summary: {
      peakPermitsPerSecond: {
        warmup: peak(warmSeries),
        tokenBucket: peak(bucketSeries),
        fixedWindow: peak(windowSeries),
        fixedRate: peak(fixedSeries),
      },
      note: 'Not a throughput contest (§13.4). The token bucket and fixed window admit the burst at once by design; the warm-up limiter exists to ramp instead.',
    },
  };
}

/**
 * 6. Warm-up versus fixed pacing, using the shipped Pacer.
 *
 * Fixed pacing spaces callers evenly at the stable interval from the very
 * first call. It smooths a burst, but it does not ramp: a cold process is hit
 * at full rate immediately. That contrast is the whole scenario.
 */
async function warmupVsPacing() {
  const arrivals = burst(300);
  const [warm, paced] = await Promise.all([
    run(factories.warmup, arrivals),
    run(factories.pacer, arrivals),
  ]);

  const bucketMicros = 250_000;
  const warmSeries = throughputSeries(warm, bucketMicros);
  const pacedSeries = throughputSeries(paced, bucketMicros);
  const length = Math.max(warmSeries.length, pacedSeries.length);

  const rows = [];
  for (let index = 0; index < length; index += 1) {
    rows.push([
      index * bucketMicros,
      warmSeries[index]?.permitsPerSecond ?? 0,
      pacedSeries[index]?.permitsPerSecond ?? 0,
    ]);
  }

  const firstSecond = (records) =>
    records.filter((record) => record.grantMicros <= 1_000_000).length;

  return {
    name: 'warmup-vs-pacing',
    title: '6. Warm-up vs fixed pacing — pacing smooths, only warm-up ramps',
    columns: ['t_micros', 'warmup_pps', 'fixed_pacing_pps'],
    rows,
    summary: {
      admittedInFirstSecond: { warmup: firstSecond(warm), fixedPacing: firstSecond(paced) },
      intervalMicros: {
        warmupFirst: warm[1].grantMicros - warm[0].grantMicros,
        warmupLast: warm[warm.length - 1].grantMicros - warm[warm.length - 2].grantMicros,
        fixedPacingFirst: paced[1].grantMicros - paced[0].grantMicros,
        fixedPacingLast: paced[paced.length - 1].grantMicros - paced[paced.length - 2].grantMicros,
      },
      note: 'Fixed pacing holds one interval from the first call to the last. Warm-up starts at the cold interval and converges to the same steady interval.',
    },
  };
}

/**
 * 7. Warm-up composed with pacing.
 *
 * The warm-up limiter decides the rate; the queue enforces the bounds. Both
 * properties at once: callers are admitted on the ramp, and callers who would
 * wait past the bound are refused instead of queueing without limit.
 *
 * The contrast is against warm-up alone, where every caller waits however
 * long the timeline says — up to 4.5 seconds for this burst.
 */
async function warmupComposedWithPacing() {
  // Sustained overload rather than a single burst: 200 requests/second for
  // six seconds against a limiter that tops out at 100/s. A burst at one
  // instant cannot show this — everything beyond the bound is refused in the
  // first moment and no traffic remains to ride the ramp.
  const arrivals = pacedArrivals(1200, 5_000);
  const MAX_QUEUE_DELAY_MS = 500;

  const composed = () => {
    const clock = new ManualClock();
    const warm = new WarmupLimiter(CONFIG, clock);
    return {
      clock,
      limiter: new QueuedLimiter(warm, { maxQueueDelayMs: MAX_QUEUE_DELAY_MS }, clock),
    };
  };

  const [withBounds, unbounded] = await Promise.all([
    run(composed, arrivals),
    run(factories.warmup, arrivals),
  ]);

  const admitted = withBounds.filter((record) => record.refused === undefined);
  const refused = withBounds.filter((record) => record.refused !== undefined);
  const longestWait = (records) =>
    Math.max(...records.map((record) => record.grantMicros - record.atMicros));

  const bucketMicros = 250_000;
  const composedSeries = throughputSeries(admitted, bucketMicros);
  const unboundedSeries = throughputSeries(unbounded, bucketMicros);
  const length = Math.max(composedSeries.length, unboundedSeries.length);

  const rows = [];
  for (let index = 0; index < length; index += 1) {
    rows.push([
      index * bucketMicros,
      composedSeries[index]?.permitsPerSecond ?? 0,
      unboundedSeries[index]?.permitsPerSecond ?? 0,
    ]);
  }

  return {
    name: 'warmup-with-pacing',
    title: '7. Warm-up composed with pacing — ramping rate, bounded queue',
    columns: ['t_micros', 'composed_pps', 'warmup_alone_pps'],
    rows,
    summary: {
      maxQueueDelayMs: MAX_QUEUE_DELAY_MS,
      requests: arrivals.length,
      arrivalRatePerSecond: 200,
      composed: {
        admitted: admitted.length,
        refused: refused.length,
        refusalReasons: [...new Set(refused.map((record) => record.refused))],
        longestWaitMicros: longestWait(admitted),
        meanWaitMicros:
          admitted.reduce((sum, record) => sum + (record.grantMicros - record.atMicros), 0) /
          admitted.length,
      },
      warmupAlone: {
        admitted: unbounded.length,
        refused: 0,
        longestWaitMicros: longestWait(unbounded),
        meanWaitMicros:
          unbounded.reduce((sum, record) => sum + (record.grantMicros - record.atMicros), 0) /
          unbounded.length,
      },
      note: 'Composition costs one line: new QueuedLimiter(warmupLimiter, bounds, clock). Both admit at the warm-up rate; the bounded one refuses callers it cannot serve within the bound instead of letting waits grow without limit.',
    },
  };
}

/**
 * Not a §13.1 scenario: the data behind the §13.3 cost-function graph.
 *
 * Measured, not computed — the x values are the stored-permit levels the
 * limiter itself reported, and the y values are the gaps it actually imposed.
 */
async function costFunction() {
  const records = await run(warmupLimiter, burst(MAX_PERMITS + 20), { stepMicros: 100 });
  const rows = [];
  for (let index = 0; index < records.length - 1; index += 1) {
    const stored = records[index].result?.storedPermitsAfter;
    if (stored === undefined) continue;
    // The gap after a grant is the cost that caller imposed, computed at the
    // pot level BEFORE it spent — one permit above what it left behind.
    // Pairing the gap with `storedPermitsAfter` would shift the curve by one.
    rows.push([stored + records[index].permits, records[index + 1].grantMicros - records[index].grantMicros]);
  }

  return {
    name: 'cost-function',
    title: 'Cost function — acquisition interval against stored permits (§5.4)',
    columns: ['stored_permits', 'interval_micros'],
    rows,
    summary: {
      thresholdPermits: 150,
      stableIntervalMicros: STABLE_INTERVAL_MICROS,
      coldIntervalMicros: COLD_INTERVAL_MICROS,
      note: 'Flat at the stable interval below the threshold, sloping up to the cold interval at maxPermits.',
    },
  };
}

export const scenarios = [
  steadyState,
  coldStartBurst,
  idleRecooling,
  repeatedCycles,
  algorithmComparison,
  warmupVsPacing,
  warmupComposedWithPacing,
  costFunction,
];
