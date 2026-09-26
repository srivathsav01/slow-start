// The `slow-start/adapters` entry point. Kept separate from the main one so
// the core import never carries framework-shaped types.
//
// Express only, on purpose. Fastify, Koa and others are documented snippets
// over `attempt()`; see the README.

export { expressRateLimit } from './express.js';
export type {
  ExpressRateLimitOptions,
  RateLimitNext,
  RateLimitResponse,
} from './express.js';
