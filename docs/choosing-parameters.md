# Choosing your parameters

You have installed the package and now have three numbers to pick:

```ts
new WarmupLimiter({
  permitsPerSecond: ?,   // the rate you settle at
  warmupPeriodMs: ?,     // how long it takes to get there
  coldFactor: ?,         // how slow you start, default 3
});
```

This page is about arriving at those numbers by measurement rather than by
feel, and about noticing when you got them wrong.

---

## `permitsPerSecond` — the rate you settle at

This is the throughput the **protected resource** can sustain, not the
throughput you hope for and not the traffic you receive.

Two ways to get it honestly:

**Measure the resource.** Load the thing you are protecting — the database,
the downstream service, the queue consumer — until its latency starts
climbing, and take the rate just below that knee. Not the rate at which it
falls over; the rate at which it stops being comfortable. If p99 latency is
flat at 80 requests per second and starts rising at 95, use 80.

**Read the quota.** If you are protecting a third-party API with a published
limit, use that number, minus a margin for anything else in your system that
calls the same API with the same credentials. A 1,000-requests-per-minute
quota shared by two services is not 1,000 for you.

What not to do is pick a round number because it looks reasonable. A limiter
set above what the resource can take doesn't protect it; one set far below
turns your own limiter into the bottleneck, and you will spend an afternoon
finding that out.

**Fractional rates are fine.** `permitsPerSecond: 0.5` is one permit every two
seconds, which is a legitimate setting for an expensive batch job.

---

## `warmupPeriodMs` — how long it takes to get there

This is the one people guess at, and it has a real answer: **how long your
service actually takes to reach full capacity after starting cold.**

That warm-up is usually some combination of:

- a connection pool filling, one connection per request until it reaches its
  minimum size
- a cache filling, so the early requests are all misses and hit the slow path
- the JIT settling, so the first few thousand executions of your hot path run
  interpreted
- a downstream service doing all of the above at the same time

### Measure it

Restart the service under a steady, modest load and watch latency:

1. Send a constant, low rate of real requests — well under capacity.
2. Watch p95 latency from the first request.
3. Note when it stops falling and goes flat.

That elapsed time is your warm-up period. It is often **2–10 seconds** for a
connection pool, and **30 seconds to several minutes** where a large cache has
to refill.

If you cannot run that experiment, a reasonable starting point is the time
your health check takes to go green after a restart, since that usually covers
pool setup and first queries. Then verify it with the symptoms below.

### Getting it exactly right matters less than being in range

The cost curve is smooth, so being 30% out changes the shape a little rather
than breaking anything. Being an **order of magnitude** out is what hurts: 300
milliseconds when the real answer is 30 seconds gives you almost no
protection, and 10 minutes when the real answer is 5 seconds means every quiet
period is followed by minutes of needless throttling.

---

## `coldFactor` — how slow you start

The default of `3` means a fully cold limiter admits at **one third** of
`permitsPerSecond`, then ramps to the full rate over the warm-up period.

| Value | Cold rate | When it fits |
|---|---|---|
| `2` | half | The system is only mildly slower cold — a small pool, a cheap cache |
| `3` (default) | one third | Most services. Guava's fixed value |
| `5`–`10` | a fifth to a tenth | Cold requests are dramatically more expensive: a large cache, an expensive JIT path, a downstream that itself warms up |

Raise it when your first requests are much slower than your steady-state ones.
If a cold request takes 2 seconds and a warm one takes 50 milliseconds, that
40× gap argues for a cold factor well above 3.

Lower it when the difference is small and you mostly want *some* gentleness
after idleness, not much.

Note what it does **not** change: the time to full rate is always
`warmupPeriodMs`, whatever the cold factor. A higher cold factor makes the
start slower, not the ramp longer.

---

## A worked example

**The service.** An HTTP API that reads from Postgres through a pool of 20
connections, with a Redis cache in front. It runs three replicas behind a load
balancer, and deploys roll one replica at a time.

**Step 1 — the rate.** Load testing a single replica, p99 latency is flat to
about 140 requests per second and starts climbing at 160. Postgres is the
limit, not the Node process. There are three replicas, but the database is
shared, so each replica gets a third of the safe total:

```
140 requests/second safe for the database
÷ 3 replicas
≈ 46 per replica → permitsPerSecond: 45
```

**Step 2 — the warm-up period.** Restart one replica under a trickle of
traffic and watch p95:

```
t=0.0s   p95 850 ms   (pool empty, every query opens a connection)
t=1.5s   p95 420 ms   (pool filling)
t=3.0s   p95 180 ms   (pool full, cache still cold)
t=6.0s   p95  95 ms   (cache warming)
t=8.0s   p95  60 ms   (flat from here)
t=12.0s  p95  60 ms
```

Latency goes flat at 8 seconds, so `warmupPeriodMs: 8000`. Note this is
dominated by the *cache*, not the pool — the pool was full at 3 seconds. Had
you reasoned only about connections you would have picked 3,000 and been
three times too aggressive.

**Step 3 — the cold factor.** The first requests are 850 ms against a
steady-state 60 ms, roughly 14× slower. That is a big gap, so the default 3 is
too gentle a start:

```ts
new WarmupLimiter({
  permitsPerSecond: 45,
  warmupPeriodMs: 8000,
  coldFactor: 5,
});
```

**What this does.** A freshly started replica admits 9 requests per second
(45 ÷ 5), ramping to 45 over 8 seconds. The database sees a gradual climb
rather than 45 cache-missing queries in the first second, three replicas at a
time.

**Step 4 — the bound.** Warm-up shapes the rate; it does not decide what
happens to the requests that do not fit. With a load balancer in front, a
caller that would wait more than a second is better refused, so the balancer
can try another replica:

```ts
const limiter = new QueuedLimiter(warm, { maxQueueDelayMs: 1000 });
```

---

## How to tell you got it wrong

### The warm-up period is too long

- Requests are throttled well after latency graphs show the service is
  healthy.
- After a brief idle period — a quiet minute at 3 a.m. — the next requests are
  slowed far more than the service needs.
- Your `storedPermitsAfter` (from the result of `acquire`) sits high while
  latency is already flat.

**Fix:** shorten it towards where latency actually goes flat. If you measured
8 seconds and set 60, the limiter is protecting a system that stopped needing
protection 52 seconds ago.

### The warm-up period is too short

- Latency spikes in the first seconds after a deploy or a scale-up, even
  though the limiter is in place.
- Errors cluster right after a restart: pool timeouts, downstream 503s.
- Removing the limiter changes nothing about the restart behaviour — which
  means it was never really slowing the cold phase.

**Fix:** measure again with a restart, and take the point where p95 stops
falling, not where the process reports ready.

### The cold factor is too high

- The first requests after any quiet period are refused or wait seconds, on a
  service that is not actually that slow when cold.
- Warm-up is visible in normal traffic rather than only after restarts.

**Fix:** lower it to 2 or 3, or shorten the warm-up period — a high cold
factor and a long period compound.

### The rate is wrong

- Throttling constantly, while the protected resource is bored → it is too
  low.
- The resource is struggling even though the limiter is admitting everything →
  it is too high, or something else is calling the resource without going
  through the limiter.

---

## When this is the wrong tool

Rate limiters are not interchangeable. Use something else when:

**You have a fixed external quota and no cold-start problem.** If a third
party allows 1,000 requests a minute and you only need to stay under it, a
token bucket or GCRA is simpler and gives you the full quota from the first
second. Warming up costs you throughput for no benefit.

**You need per-user or per-tenant limits.** This package limits one shared
resource. It does not manage a keyed set of limiters, evict idle keys, or
carry any notion of a caller identity. Building that on top means holding a
limiter per key and expiring them yourself, and `rate-limiter-flexible` or
`express-rate-limit` already do it.

**You run more than one instance.** State is in-process. Ten instances
configured for 100 permits per second each admit 100 permits per second each,
so the shared resource sees 1,000. Either divide the rate by your instance
count — and accept that it is wrong while instances are starting or
stopping — or use a limiter with a shared backend.

**You are on serverless.** If the process is torn down between invocations,
the limiter starts cold every time and never reaches its warm rate; if
instances scale out, you get one limiter per instance with no coordination.
Neither is what you want. Limit at the gateway, or use a backend-shared
limiter.

**Your first request costs the same as your thousandth.** Then there is
nothing to warm up. That is the whole premise of this algorithm, and without
it you are just making your service slower after every quiet period.

---

## Seeing the shape

The cost curve — how the acquisition interval changes with stored permits —
is drawn from measured values in
[`bench/results/cost-function.svg`](../bench/results/cost-function.svg), and
the derivation behind it is in [`verification/`](../verification/README.md).
