// Runs the behavioural scenarios and writes their data to bench/results/.
//
// Run via `npm run bench`, which builds first: the benchmarks import the
// package by name, so they measure the built artifact users install rather
// than the sources.

import console from 'node:console';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { CONFIG, scenarios } from './scenarios.mjs';

const resultsDir = fileURLToPath(new URL('results/', import.meta.url));
mkdirSync(resultsDir, { recursive: true });

function writeCsv(name, columns, rows) {
  const lines = [columns.join(','), ...rows.map((row) => row.join(','))];
  writeFileSync(join(resultsDir, `${name}.csv`), `${lines.join('\n')}\n`);
}

const started = Date.now();
const summaries = {};

for (const scenario of scenarios) {
  const result = await scenario();
  writeCsv(result.name, result.columns, result.rows);
  summaries[result.name] = { title: result.title, ...result.summary };

  console.log(`\n${result.title}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

const methodology = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  config: CONFIG,
  clock: 'ManualClock — simulated time, identical on every machine',
  grantResolutionMicros: {
    default: 250,
    costFunction: 100,
    note: 'Grant times are sampled by stepping the clock, so they are accurate to the step, rounded up. Figures needing more precision are asked of the limiter directly and labelled "exact".',
  },
  note: 'Behavioural results only. Timing and memory costs are measured separately by bench/perf.mjs on a real clock.',
};

writeFileSync(
  join(resultsDir, 'summary.json'),
  `${JSON.stringify({ methodology, scenarios: summaries }, null, 2)}\n`,
);

console.log(`\nWrote ${Object.keys(summaries).length} scenarios to bench/results/`);
console.log(`Took ${String(Date.now() - started)} ms of real time.`);
