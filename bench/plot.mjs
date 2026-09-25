// Draws the §13.3 graphs as SVG, from the CSVs in bench/results/.
//
// Hand-rolled rather than charted with a library: no dependency, no build
// step, and the output is text, so a graph changing shows up as a readable
// diff in review. Colours are chosen to read on both light and dark
// backgrounds, since GitHub renders READMEs in either.

import console from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const resultsDir = fileURLToPath(new URL('results/', import.meta.url));

const WIDTH = 760;
const HEIGHT = 380;
const MARGIN = { top: 42, right: 24, bottom: 52, left: 68 };
const PLOT = {
  width: WIDTH - MARGIN.left - MARGIN.right,
  height: HEIGHT - MARGIN.top - MARGIN.bottom,
};

const COLOURS = ['#2f81f7', '#d29922', '#bc4c00', '#8250df'];
const AXIS = '#8b949e';

function readCsv(name) {
  const [header, ...lines] = readFileSync(join(resultsDir, `${name}.csv`), 'utf8')
    .trim()
    .split('\n');
  return {
    columns: header.split(','),
    rows: lines.map((line) => line.split(',').map(Number)),
  };
}

function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const rough = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough);
  const first = Math.ceil(min / step) * step;
  const ticks = [];
  for (let value = first; value <= max + step / 1000; value += step) ticks.push(value);
  return ticks;
}

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * @param {{ title: string, xLabel: string, yLabel: string,
 *   series: { label: string, points: [number, number][], dashed?: boolean }[],
 *   markers?: { y: number, label: string }[], format?: (value: number) => string }} spec
 */
function lineChart(spec) {
  const points = spec.series.flatMap((series) => series.points);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = 0;
  const yMax = Math.max(...ys, ...(spec.markers ?? []).map((marker) => marker.y)) * 1.08;

  const toX = (x) => MARGIN.left + ((x - xMin) / (xMax - xMin || 1)) * PLOT.width;
  const toY = (y) => MARGIN.top + PLOT.height - ((y - yMin) / (yMax - yMin || 1)) * PLOT.height;
  const format = spec.format ?? ((value) => String(Math.round(value * 100) / 100));

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" font-family="system-ui, sans-serif">`,
    `<text x="${MARGIN.left}" y="24" font-size="15" font-weight="600" fill="${AXIS}">${escape(spec.title)}</text>`,
  ];

  for (const tick of niceTicks(yMin, yMax)) {
    const y = toY(tick);
    parts.push(
      `<line x1="${MARGIN.left}" y1="${y}" x2="${MARGIN.left + PLOT.width}" y2="${y}" stroke="${AXIS}" stroke-opacity="0.18"/>`,
      `<text x="${MARGIN.left - 8}" y="${y + 4}" font-size="11" fill="${AXIS}" text-anchor="end">${escape(format(tick))}</text>`,
    );
  }

  for (const tick of niceTicks(xMin, xMax)) {
    const x = toX(tick);
    parts.push(
      `<text x="${x}" y="${MARGIN.top + PLOT.height + 18}" font-size="11" fill="${AXIS}" text-anchor="middle">${escape(format(tick))}</text>`,
    );
  }

  parts.push(
    `<line x1="${MARGIN.left}" y1="${MARGIN.top + PLOT.height}" x2="${MARGIN.left + PLOT.width}" y2="${MARGIN.top + PLOT.height}" stroke="${AXIS}" stroke-opacity="0.5"/>`,
    `<text x="${MARGIN.left + PLOT.width / 2}" y="${HEIGHT - 12}" font-size="12" fill="${AXIS}" text-anchor="middle">${escape(spec.xLabel)}</text>`,
    `<text x="16" y="${MARGIN.top + PLOT.height / 2}" font-size="12" fill="${AXIS}" text-anchor="middle" transform="rotate(-90 16 ${MARGIN.top + PLOT.height / 2})">${escape(spec.yLabel)}</text>`,
  );

  for (const marker of spec.markers ?? []) {
    const y = toY(marker.y);
    parts.push(
      `<line x1="${MARGIN.left}" y1="${y}" x2="${MARGIN.left + PLOT.width}" y2="${y}" stroke="${AXIS}" stroke-dasharray="4 4" stroke-opacity="0.65"/>`,
      `<text x="${MARGIN.left + PLOT.width - 4}" y="${y - 6}" font-size="11" fill="${AXIS}" text-anchor="end">${escape(marker.label)}</text>`,
    );
  }

  spec.series.forEach((series, index) => {
    const colour = COLOURS[index % COLOURS.length];
    const path = series.points
      .map(([x, y], pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${toX(x).toFixed(1)} ${toY(y).toFixed(1)}`)
      .join(' ');
    parts.push(
      `<path d="${path}" fill="none" stroke="${colour}" stroke-width="2"${series.dashed ? ' stroke-dasharray="5 4"' : ''}/>`,
    );

    if (spec.series.length > 1) {
      const legendX = MARGIN.left + 12 + index * 165;
      parts.push(
        `<line x1="${legendX}" y1="${MARGIN.top - 12}" x2="${legendX + 18}" y2="${MARGIN.top - 12}" stroke="${colour}" stroke-width="2"/>`,
        `<text x="${legendX + 24}" y="${MARGIN.top - 8}" font-size="11" fill="${AXIS}">${escape(series.label)}</text>`,
      );
    }
  });

  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

function write(name, svg) {
  writeFileSync(join(resultsDir, `${name}.svg`), svg);
  console.log(`bench/results/${name}.svg`);
}

// 1. The warm-up curve — the one that goes at the top of the README.
{
  const { rows } = readCsv('cold-start-burst');
  write(
    'warmup-curve',
    lineChart({
      title: 'Warm-up: throughput ramps from stableRate / coldFactor to stableRate',
      xLabel: 'time (seconds)',
      yLabel: 'permits per second',
      markers: [
        { y: 100, label: 'stableRate = 100/s' },
        { y: 100 / 3, label: 'cold = 33.3/s' },
      ],
      series: [
        {
          label: 'warm-up limiter',
          points: rows.map(([tMicros, pps]) => [tMicros / 1_000_000, pps]),
        },
      ],
    }),
  );
}

// 2. The cost function — measured, not drawn by hand.
{
  const { rows } = readCsv('cost-function');
  write(
    'cost-function',
    lineChart({
      title: 'Cost function: flat below the threshold, sloping to cold above it',
      xLabel: 'stored permits',
      yLabel: 'interval per permit (µs)',
      markers: [
        { y: 30_000, label: 'coldInterval' },
        { y: 10_000, label: 'stableInterval' },
      ],
      series: [
        {
          label: 'measured interval',
          points: [...rows].sort((a, b) => a[0] - b[0]),
        },
      ],
    }),
  );
}

// 4. Composition — the same ramp, but bounded.
{
  const { rows } = readCsv('warmup-with-pacing');
  write(
    'warmup-with-pacing',
    lineChart({
      title: 'Overload for 6 s: same admitted rate, but no backlog afterwards',
      xLabel: 'time (seconds)',
      yLabel: 'permits admitted per second',
      series: [
        {
          label: 'warm-up alone (unbounded)',
          points: rows.map((row) => [row[0] / 1_000_000, row[2]]),
        },
        {
          // Dashed and drawn second: it sits exactly on the other line until
          // traffic stops, and would otherwise be invisible beneath it.
          label: 'warm-up + 500 ms bound',
          points: rows.map((row) => [row[0] / 1_000_000, row[1]]),
          dashed: true,
        },
      ],
    }),
  );
}

// 3. Cold-start comparison — the behavioural difference, overlaid.
{
  const { rows } = readCsv('algorithm-comparison');
  const series = ['warm-up', 'token bucket', 'fixed window', 'fixed rate'].map((label, index) => ({
    label,
    points: rows.map((row) => [row[0] / 1_000_000, row[index + 1]]),
  }));

  write(
    'cold-start-comparison',
    lineChart({
      title: '300 requests at once: warm-up ramps, the others admit the burst',
      xLabel: 'time (seconds)',
      yLabel: 'permits per second',
      series,
    }),
  );
}
