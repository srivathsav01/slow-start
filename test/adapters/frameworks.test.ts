import type { AddressInfo } from 'node:net';
import express from 'express';
import Fastify from 'fastify';
import Koa from 'koa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attempt, type Limiter } from '../../src/adapters/guard.js';
import { ManualClock } from '../../src/clock/manual-clock.js';
import { QueuedLimiter } from '../../src/pacing/queued-limiter.js';
import { WarmupLimiter } from '../../src/warmup/warmup-limiter.js';

// The middleware in the README, run against real servers. If a snippet in the
// documentation stops working, this fails — which is the point of having the
// frameworks as test-only dependencies rather than shipping adapters.
//
// The limiter runs on a ManualClock that never advances, so the first request
// is admitted and every later one is refused. No timing, no flakes.

function buildLimiter(): Limiter {
  const clock = new ManualClock();
  const warm = new WarmupLimiter({ permitsPerSecond: 100, warmupPeriodMs: 3000 }, clock);
  return new QueuedLimiter(warm, { maxQueueDelayMs: 10 }, clock);
}

// A module-level name, so each snippet reads exactly as it would in an
// application where the limiter is a module constant. Rebuilt per test.
let rateLimiter: Limiter = buildLimiter();

beforeEach(() => {
  rateLimiter = buildLimiter();
});

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Two requests: the first should be admitted, the second refused. */
async function twoRequests(url: string): Promise<Response[]> {
  return [await fetch(url), await fetch(url)];
}

describe('framework snippets', () => {
  it('works as Express middleware', async () => {
    const app = express();

    // --- README snippet ---
    app.use(async (req, res, next) => {
      const result = await attempt(rateLimiter);
      if (result.ok) {
        next();
        return;
      }
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      res.status(429).json({ error: 'rate limited' });
    });
    // --- end snippet ---

    app.get('/', (req, res) => {
      res.json({ ok: true });
    });

    const server = app.listen(0);
    closers.push(() => new Promise((resolve) => server.close(() => { resolve(); })));
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    const [first, second] = await twoRequests(`http://127.0.0.1:${String(port)}/`);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(429);
    expect(second?.headers.get('retry-after')).toBe('1');
  });

  it('works as a Fastify onRequest hook', async () => {
    const app = Fastify();

    // --- README snippet ---
    app.addHook('onRequest', async (request, reply) => {
      const result = await attempt(rateLimiter);
      if (result.ok) return;
      reply.header('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      await reply.code(429).send({ error: 'rate limited' });
    });
    // --- end snippet ---

    app.get('/', () => ({ ok: true }));

    await app.listen({ port: 0, host: '127.0.0.1' });
    closers.push(() => app.close());
    const { port } = app.server.address() as AddressInfo;

    const [first, second] = await twoRequests(`http://127.0.0.1:${String(port)}/`);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(429);
    expect(second?.headers.get('retry-after')).toBe('1');
  });

  it('works as Koa middleware', async () => {
    const app = new Koa();

    // --- README snippet ---
    app.use(async (ctx, next) => {
      const result = await attempt(rateLimiter);
      if (result.ok) {
        await next();
        return;
      }
      ctx.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      ctx.status = 429;
      ctx.body = { error: 'rate limited' };
    });
    // --- end snippet ---

    app.use((ctx) => {
      ctx.body = { ok: true };
    });

    const server = app.listen(0);
    closers.push(() => new Promise((resolve) => server.close(() => { resolve(); })));
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    const [first, second] = await twoRequests(`http://127.0.0.1:${String(port)}/`);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(429);
    expect(second?.headers.get('retry-after')).toBe('1');
  });
});
