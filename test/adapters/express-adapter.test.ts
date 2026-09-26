import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expressRateLimit } from '../../src/adapters/express.js';
import type { Limiter } from '../../src/adapters/guard.js';
import { ManualClock } from '../../src/clock/manual-clock.js';
import { QueuedLimiter } from '../../src/pacing/queued-limiter.js';
import { WarmupLimiter } from '../../src/warmup/warmup-limiter.js';

// The shipped adapter, against a real Express server. The limiter runs on a
// ManualClock that never advances, so the first request is admitted and every
// later one is refused: no timing, no flakes.

function buildLimiter(): Limiter {
  const clock = new ManualClock();
  const warm = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);
  return new QueuedLimiter(warm, { maxQueueDelayMs: 10 }, clock);
}

let limiter: Limiter = buildLimiter();
beforeEach(() => {
  limiter = buildLimiter();
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0);
  closers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}/`;
}

describe('expressRateLimit', () => {
  it('admits a request the limiter allows', async () => {
    const app = express();
    app.use(expressRateLimit(limiter));
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });

    const response = await fetch(await serve(app));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers 429 with Retry-After when refused', async () => {
    const app = express();
    app.use(expressRateLimit(limiter));
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    const url = await serve(app);

    expect((await fetch(url)).status).toBe(200);
    const refused = await fetch(url);

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(await refused.json()).toEqual({ error: 'rate limited' });
  });

  it('never runs the route when refused', async () => {
    let handled = 0;
    const app = express();
    app.use(expressRateLimit(limiter));
    app.get('/', (_req, res) => {
      handled += 1;
      res.json({ ok: true });
    });
    const url = await serve(app);

    await fetch(url);
    await fetch(url);
    expect(handled).toBe(1);
  });

  it('takes a custom status and body', async () => {
    const app = express();
    app.use(
      expressRateLimit(limiter, {
        statusCode: 503,
        body: (refusal) => ({ busy: true, reason: refusal.reason }),
      }),
    );
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    const url = await serve(app);

    await fetch(url);
    const refused = await fetch(url);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ busy: true, reason: 'delay' });
  });

  it('takes more than one permit per request', async () => {
    const app = express();
    app.use(expressRateLimit(limiter, { permits: 250 }));
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    const url = await serve(app);

    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url)).status).toBe(429);
  });

  // Anything that is not a refusal belongs to Express's error handling, not
  // to the client as backpressure.
  it('forwards a programming error to next() rather than answering 429', async () => {
    const app = express();
    app.use(expressRateLimit(limiter, { permits: 0 })); // invalid: RangeError
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    // Express identifies an error handler by its four parameters, so the
    // unused `next` has to stay in the signature.
    const onError: express.ErrorRequestHandler = (error, _req, res, next) => {
      // Express identifies an error handler by its arity, so `next` has to be
      // declared even though this handler answers instead of forwarding.
      expect(typeof next).toBe('function');
      res.status(500).json({ handled: error instanceof RangeError });
    };
    app.use(onError);

    const response = await fetch(await serve(app));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ handled: true });
  });

  it('works with any limiter in the package', async () => {
    const clock = new ManualClock();
    const warm = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);

    const app = express();
    app.use(expressRateLimit(warm));
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });

    expect((await fetch(await serve(app))).status).toBe(200);
  });
});
