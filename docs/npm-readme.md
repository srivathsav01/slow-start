# slow-start — warm-up rate limiter for Node.js

[![npm](https://img.shields.io/npm/v/slow-start)](https://www.npmjs.com/package/slow-start)
[![CI](https://github.com/srivathsav01/slow-start/actions/workflows/ci.yml/badge.svg)](https://github.com/srivathsav01/slow-start/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/slow-start)](https://github.com/srivathsav01/slow-start/blob/main/LICENSE)

**A TypeScript rate limiter that warms up.** It admits traffic slowly when
your service has been idle or has just restarted, then ramps to the full
configured rate — so a cold cache, an empty connection pool or a cold JIT
never meets peak load head-on.

An independent implementation of Google Guava's `SmoothWarmingUp` algorithm,
verified against it. Zero dependencies. ESM and CommonJS. Node 22+.

![Warm-up curve: throughput ramping from 33 to 100 requests per second over three seconds](https://raw.githubusercontent.com/srivathsav01/slow-start/main/bench/results/warmup-curve.svg)

```bash
npm install slow-start
```

## Quick start

```ts
import { WarmupLimiter } from 'slow-start';

const limiter = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 });

app.get('/search', async (req, res) => {
  await limiter.acquire();
  res.json(await db.search(req.query.q));
});
```

Cold, this admits about 33 requests per second. After three seconds of
sustained demand it reaches 100. Idle for three seconds and it goes cold
again — because a process that quiet has lost its warm caches.

## Why a warm-up rate limiter

A token bucket configured for 100 requests per second will happily admit 100
requests in the first second after a deploy, every one of them a cache miss
hitting a cold database. The service falls over, restarts, and meets the same
wall again. That's the restart-under-load death spiral, and it's what this
package exists to prevent.

Reach for it when **the first requests after quiet cost more than the rest**:

- a service behind a cache that empties on restart or scale-up
- a worker whose database or broker pool fills lazily
- a client calling an upstream that needs to warm up itself
- anything that has fallen over in the first seconds after a deploy

If your cost per request is flat, use a plain token bucket instead — a warm-up
period would only make you slower. The same goes for per-user limits (this
limits one shared resource, not a keyed set), multi-instance deployments
(state is in-process, so ten instances admit ten times the rate) and
serverless (the process dies before it ever warms up).

**[How to choose your three numbers →](https://github.com/srivathsav01/slow-start/blob/main/docs/choosing-parameters.md)**

## How it compares

| Package / algorithm | Burst behaviour | Warm-up ramp |
|---|---|---|
| Token bucket (`limiter`) | Admits a full bucket at once | No |
| Fixed window (`express-rate-limit`) | Admits the quota at once | No |
| GCRA / leaky bucket | Spaces callers evenly | No |
| Multi-strategy (`rate-limiter-flexible`) | Configurable | No |
| **slow-start** | Spaces callers, starting slow | **Yes** |

Those packages are mature and do things this one does not — distributed
state, per-IP HTTP middleware, job scheduling. This implements one model they
don't: a rate that starts low after idleness and ramps.

## Features

- **Warm-up admission control** — Guava `SmoothWarmingUp`, verified against
  twelve hand-derived golden vectors
- **Two ways to ask, on every limiter** — `acquire` waits and throws if it is
  refused; `tryAcquire` returns `false` instead
- **Queue bounds** — refuse callers who would wait too long, or when too many
  already are, instead of queueing without limit
- **Pacing** — even spacing of bursts, composable with warm-up
- **Cancellation** — `AbortSignal` support throughout
- **Rolling metrics** — pass / block / error counters over a fixed-memory ring
- **Express adapter** — one line, on the `slow-start/adapters` subpath;
  Fastify and Koa are documented, tested snippets
- **Deterministic testing** — inject a `ManualClock` and test time-dependent
  code without sleeping
- **Zero runtime dependencies**, TypeScript types included, ESM and CJS

## Rate limiting an Express route

```ts
import { WarmupLimiter } from 'slow-start';
import { expressRateLimit } from 'slow-start/adapters';

const limiter = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 });

app.use(expressRateLimit(limiter));
```

A refused request gets `429` and a `Retry-After` header. Express is not a
dependency of this package, and the adapter lives on a subpath so the main
import stays free of framework types.

Fastify and Koa need a few lines over `attempt()`; those snippets are in the
full documentation and are executed by the test suite against real servers.

## Testing your own code

Time is injectable, so a three-second warm-up costs no real time and never
flakes:

```ts
import { ManualClock, WarmupLimiter } from 'slow-start';

const clock = new ManualClock();
const limiter = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);

await limiter.acquire();            // resolves immediately
const second = limiter.acquire();   // owes ~30 ms
clock.advance(30_000_000n);         // nanoseconds
await second;
```

## Good to know

- **Single process.** State lives in memory; four instances mean four
  limiters. Distributed coordination is out of scope.
- **Node only.** Time comes from `process.hrtime.bigint()`.
- **The first caller after idleness waits zero** — the cost lands on the next
  caller. That's Guava's debt model, and it's deliberate.
- **Cancelling stops you waiting; it does not return the permit.**
- **`acquire` throws on refusal, `tryAcquire` returns a value.** Every limiter
  follows that rule, so a refusal never forces a `try`/`catch` on you unless
  you want the reason.

## Full documentation

**[Read the full guide on GitHub →](https://github.com/srivathsav01/slow-start#readme)**

The algorithm and its geometry, the verification record, benchmark results and
graphs, the concurrency model, and every deviation from the reference
implementation with its reasoning.

## Licence

Apache-2.0. The algorithm is Google Guava's `SmoothWarmingUp` (Apache-2.0),
with the configurable cold factor from Alibaba Sentinel's `WarmUpController`;
this is an independent implementation, not a port.
