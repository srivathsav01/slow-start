import type { Clock } from '../clock/clock.js';
import { SystemClock } from '../clock/system-clock.js';
import { requirePositiveInteger } from '../core/validation-helper.js';
import {
  deriveWindowConstants,
  type WindowConstants,
  type WindowOptions,
} from './window-constants.js';

interface Bucket {
  startMicros: number;
  pass: number;
  block: number;
  error: number;
}

export type MetricKind = 'pass' | 'block' | 'error';

export interface Counters {
  readonly pass: number;
  readonly block: number;
  readonly error: number;
}


export interface WindowSnapshot extends Counters {
  readonly total: number;
  readonly passPerSecond: number;
  readonly errorRatio: number;
}

/**
 * A ring of fixed time buckets holding counters for the last `windowMs`
 * (spec §10.2).
 *
 * Expiry is lazy: a bucket is wiped the moment a write lands on it after a
 * full lap, so there is no timer and no sweep, and memory is fixed whatever
 * the throughput. That is the whole reason for a ring rather than a list of
 * timestamps, which grows with traffic.
 *
 * It knows nothing about limiters (§10.3) — it depends only on a `Clock`.
 */
export class RollingWindow {
  private readonly clock: Clock;
  private readonly originNanos: bigint;
  private readonly constants: WindowConstants;
  private readonly buckets: Bucket[];

  /**
   * @throws RangeError if any option is invalid (see `deriveWindowConstants`).
   */
  constructor(options: WindowOptions, clock: Clock = new SystemClock()) {
    this.constants = deriveWindowConstants(options);
    this.clock = clock;
    this.originNanos = clock.now();

    // Allocated once and never grown. NEGATIVE_INFINITY marks "never used",
    // so the first write to each bucket takes the stale path and resets it.
    this.buckets = Array.from({ length: this.constants.bucketCount }, () => ({
      startMicros: Number.NEGATIVE_INFINITY,
      pass: 0,
      block: 0,
      error: 0,
    }));
  }

  /**
   * Adds to the counter for the current instant.
   *
   * @throws RangeError if `count` is not a positive integer.
   */
  record(kind: MetricKind, count = 1): void {
    requirePositiveInteger('count', count);
    const bucket = this.bucketFor(this.nowMicros());
    bucket[kind] += count;
  }

  /** The counts across the window, excluding buckets that have aged out. */
  totals(): Counters {
    const oldestMicros = this.nowMicros() - this.constants.windowMicros;
    let pass = 0;
    let block = 0;
    let error = 0;

    for (const bucket of this.buckets) {
      // Buckets left from an earlier lap that nobody has written to yet still
      // hold their old counts; their start time is what excludes them.
      if (bucket.startMicros <= oldestMicros) continue;
      pass += bucket.pass;
      block += bucket.block;
      error += bucket.error;
    }

    return { pass, block, error };
  }

  /**
   * The counts plus the values derivable from them (spec §10.1).
   *
   * `total` is `pass + block`, the decisions the window saw. An error happens
   * to a request that was already admitted, so counting it again would count
   * that request twice.
   *
   * `passPerSecond` divides by the whole window even when the limiter has
   * been running for less than that, so it reads low at first: it is a
   * rolling average, not an instantaneous rate.
   *
   * There is deliberately no percentile here, and there never will be on this
   * structure. A sum and a count cannot produce one — that information is
   * destroyed by summing — and a method claiming otherwise would be a lie.
   */
  snapshot(): WindowSnapshot {
    const { pass, block, error } = this.totals();
    const total = pass + block;

    return {
      pass,
      block,
      error,
      total,
      passPerSecond: pass / (this.constants.windowMicros / 1_000_000),
      // 0/0 is NaN, which poisons every dashboard it reaches. No requests is
      // better described as no errors than as unknown.
      errorRatio: total === 0 ? 0 : error / total,
    };
  }

  /** The bucket covering `nowMicros`, reset first if it is a lap behind. */
  private bucketFor(nowMicros: number): Bucket {
    const { bucketLengthMicros, bucketCount } = this.constants;
    const index = Math.floor(nowMicros / bucketLengthMicros) % bucketCount;
    const startMicros = nowMicros - (nowMicros % bucketLengthMicros);

    const bucket = this.buckets[index];
    if (!bucket) {
      // The index is always in range; reaching here means the ring itself is
      // broken, which is worth failing on rather than recovering from.
      throw new Error(`RollingWindow: no bucket at index ${String(index)}`);
    }

    if (bucket.startMicros === startMicros) {
      return bucket;
    }

    if (bucket.startMicros > startMicros) {
      // A monotonic clock makes this impossible. Blending two eras of counts
      // silently would be worse than stopping.
      throw new Error(
        `RollingWindow: time went backwards, bucket starts at ${String(bucket.startMicros)} but now is ${String(nowMicros)}`,
      );
    }

    // Stale from a previous lap: this is the lazy expiry.
    bucket.startMicros = startMicros;
    bucket.pass = 0;
    bucket.block = 0;
    bucket.error = 0;
    return bucket;
  }

  private nowMicros(): number {
    return Number((this.clock.now() - this.originNanos) / 1000n);
  }
}
