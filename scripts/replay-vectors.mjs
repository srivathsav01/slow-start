// Replays the golden vectors through the INSTALLED package, using only its
// public API. Copied into the smoke test's throwaway consumer project and run
// there, so what it exercises is the packed tarball rather than src/.
//
// The unit tests prove src/ reproduces the vectors; this proves the artifact
// users download does. Usage:
//
//   node replay-vectors.mjs <config.json> <golden-vectors.csv>

import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { ManualClock, WarmupLimiter } from 'slow-start';

const [configPath, vectorsPath] = process.argv.slice(2);
if (!configPath || !vectorsPath) {
  throw new Error('usage: replay-vectors.mjs <config.json> <golden-vectors.csv>');
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const rows = readFileSync(vectorsPath, 'utf8')
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const f = line.split(',');
    return { step: +f[0], now: +f[1], permits: +f[2], grant: +f[3], stored: +f[4] };
  });

const flush = () => new Promise((resolve) => setImmediate(resolve));

// The limiter rounds each sleep up to a whole nanosecond, so a grant of
// 29933.3333 us is due at ceil(29933333.33) = 29933334 ns, never before.
const dueNs = (micros) => BigInt(Math.ceil(micros * 1000));

const clock = new ManualClock();
const limiter = new WarmupLimiter(
  {
    permitsPerSecond: config.input.stableRatePermitsPerSecond,
    warmupPeriodMs: config.input.warmupPeriodMicros / 1000,
    coldFactor: config.input.coldFactor,
  },
  clock,
);

const advanceTo = async (target) => {
  if (target > clock.now()) clock.advance(target - clock.now());
  await flush();
};

const pending = [];
const failures = [];

async function settle(untilNs) {
  pending.sort((a, b) => (a.dueNs < b.dueNs ? -1 : 1));
  while (pending.length > 0 && pending[0].dueNs <= untilNs) {
    const caller = pending.shift();

    if (caller.dueNs > clock.now()) {
      await advanceTo(caller.dueNs - 1n); // one nanosecond early...
      if (caller.state.done) failures.push(`step ${caller.step}: released EARLY`);
    }
    await advanceTo(caller.dueNs); // ...and exactly on time
    if (!caller.state.done) {
      failures.push(`step ${caller.step}: not released at its grant time`);
      continue;
    }

    const grant = caller.issued + caller.state.result.waitedMs * 1000;
    if (Math.abs(grant - caller.grant) > config.tolerance.timeMicros) {
      failures.push(`step ${caller.step}: grant ${grant} vs ${caller.grant}`);
    }
    const stored = caller.state.result.storedPermitsAfter;
    if (Math.abs(stored - caller.stored) > config.tolerance.permits) {
      failures.push(`step ${caller.step}: stored ${stored} vs ${caller.stored}`);
    }
  }
}

for (const row of rows) {
  await settle(dueNs(row.now));
  await advanceTo(dueNs(row.now));

  const state = { done: false, result: undefined };
  const issued = Number(clock.now()) / 1000;
  void limiter.acquire(row.permits).then((result) => {
    state.done = true;
    state.result = result;
  });

  pending.push({ ...row, dueNs: dueNs(row.grant), state, issued });
  await flush();
}
await settle(dueNs(1e12));

console.log(JSON.stringify({ replayed: rows.length, failures }));
