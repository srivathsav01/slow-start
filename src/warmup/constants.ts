// Derived constants of Guava's SmoothRateLimiter.SmoothWarmingUp (Apache-2.0),
// with the configurable coldFactor introduced by Alibaba Sentinel's
// WarmUpController (Apache-2.0). Derived from the published algorithm and its
// documented reasoning, not ported from either source. See spec §5.3.

import { requireFiniteAbove } from '../core/validation-helper.js';

export interface WarmupOptions {
  permitsPerSecond: number;
  warmupPeriodMs: number;
  coldFactor?: number;
}

export interface WarmupConstants {
  readonly stableIntervalMicros: number;
  readonly coldIntervalMicros: number;
  readonly thresholdPermits: number;
  readonly maxPermits: number;
  readonly slopeMicrosPerPermit: number;
  readonly coolDownIntervalMicros: number;
}

export const DEFAULT_COLD_FACTOR = 3;

/**
 * Derives the fixed constants of the SmoothWarmingUp model (spec §5.3).
 *
 * @param options - The limiter's configuration. It is read, never modified.
 * @returns The six derived constants. Times are in microseconds.
 * @throws RangeError if `permitsPerSecond` or `warmupPeriodMs` is not a finite
 * number above 0, or if `coldFactor` is not a finite number above 1.
 */
export function deriveConstants(options: WarmupOptions): WarmupConstants {
  const permitsPerSecond = requireFiniteAbove('permitsPerSecond', options.permitsPerSecond, 0);
  const warmupPeriodMs = requireFiniteAbove('warmupPeriodMs', options.warmupPeriodMs, 0);
  const coldFactor = requireFiniteAbove(
    'coldFactor',
    options.coldFactor ?? DEFAULT_COLD_FACTOR,
    1,
  );

  const warmupPeriodMicros = warmupPeriodMs * 1000;
  const stableIntervalMicros = 1_000_000 / permitsPerSecond;

  const coldIntervalMicros = stableIntervalMicros * coldFactor;
  const thresholdPermits = (0.5 * warmupPeriodMicros) / stableIntervalMicros;
  const maxPermits =
    thresholdPermits + (2 * warmupPeriodMicros) / (stableIntervalMicros + coldIntervalMicros);
  const slopeMicrosPerPermit =
    (coldIntervalMicros - stableIntervalMicros) / (maxPermits - thresholdPermits);
  const coolDownIntervalMicros = warmupPeriodMicros / maxPermits;

  return {
    stableIntervalMicros,
    coldIntervalMicros,
    thresholdPermits,
    maxPermits,
    slopeMicrosPerPermit,
    coolDownIntervalMicros,
  };
}
