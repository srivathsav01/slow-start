// Summary statistics over recorded samples.
//
// These percentiles are computed from every recorded interval, not from a
// bucketed counter window. That distinction matters: §10.1 rules out
// percentiles over counter windows, because the data needed to compute them
// is not kept. Here the samples are all in memory, so they are exact.

/** Nearest-rank percentile of an unsorted sample array. */
export function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function summarize(values) {
  const count = values.length;
  if (count === 0) return { count, mean: Number.NaN, min: Number.NaN, max: Number.NaN };
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  return {
    count,
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
}

/** Gaps between successive grant times, in microseconds. */
export function intervals(records) {
  const grants = records.map((record) => record.grantMicros).sort((a, b) => a - b);
  return grants.slice(1).map((grant, index) => grant - grants[index]);
}

/**
 * Instantaneous throughput, as permits per second, in fixed-width buckets.
 * The series plotted as the warm-up curve.
 */
export function throughputSeries(records, bucketMicros) {
  const buckets = new Map();
  for (const record of records) {
    const bucket = Math.floor(record.grantMicros / bucketMicros);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + record.permits);
  }

  const last = Math.max(...buckets.keys());
  const series = [];
  for (let bucket = 0; bucket <= last; bucket += 1) {
    series.push({
      tMicros: bucket * bucketMicros,
      permitsPerSecond: ((buckets.get(bucket) ?? 0) * 1_000_000) / bucketMicros,
    });
  }
  return series;
}
