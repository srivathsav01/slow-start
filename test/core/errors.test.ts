import { describe, expect, it } from 'vitest';
import { RateLimitRejectedError } from '../../src/core/errors.js';

describe('RateLimitRejectedError', () => {
  describe('tooLong', () => {
    const error = RateLimitRejectedError.tooLong(1500, 1000, 3);

    it('is catchable as both its own type and a plain Error', () => {
      expect(error).toBeInstanceOf(RateLimitRejectedError);
      expect(error).toBeInstanceOf(Error);
    });

    it('identifies itself by name', () => {
      // Without an explicit name, an uncaught error prints as `Error`.
      expect(error.name).toBe('RateLimitRejectedError');
      expect(String(error)).toBe(
        'RateLimitRejectedError: would wait 1500ms, which exceeds maxQueueDelayMs of 1000ms',
      );
    });

    it('carries the delay reason and both numbers', () => {
      expect(error.reason).toBe('delay');
      expect(error.waitMs).toBe(1500);
      expect(error.queueDepth).toBe(3);
    });

    it('names the limit it exceeded, not only the wait', () => {
      expect(error.message).toContain('1500ms');
      expect(error.message).toContain('maxQueueDelayMs of 1000ms');
    });
  });

  describe('queueFull', () => {
    const error = RateLimitRejectedError.queueFull(250, 1000);

    it('carries the depth reason and the wait that was refused', () => {
      expect(error.reason).toBe('depth');
      expect(error.waitMs).toBe(250);
      expect(error.queueDepth).toBe(1000);
    });

    it('says the queue is full and how full', () => {
      expect(error.message).toBe('queue is full: 1000 callers already waiting');
    });
  });

  it('lets a caller branch on the reason', () => {
    const errors = [
      RateLimitRejectedError.tooLong(1500, 1000, 3),
      RateLimitRejectedError.queueFull(250, 1000),
    ];
    expect(errors.map((error) => error.reason)).toEqual(['delay', 'depth']);
  });

  it('always has a message', () => {
    // An error with an empty message is useless in a log.
    for (const error of [
      RateLimitRejectedError.tooLong(0, 0, 0),
      RateLimitRejectedError.queueFull(0, 0),
      new RateLimitRejectedError('delay', 1, 1, 'built directly'),
    ]) {
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it('survives being thrown and caught', () => {
    try {
      throw RateLimitRejectedError.tooLong(42, 10, 1);
    } catch (caught) {
      expect(caught).toBeInstanceOf(RateLimitRejectedError);
      expect((caught as RateLimitRejectedError).reason).toBe('delay');
      expect((caught as Error).stack).toContain('RateLimitRejectedError');
    }
  });
});
