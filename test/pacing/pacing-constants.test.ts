import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_QUEUE_DELAY_MS,
  DEFAULT_MAX_QUEUE_DEPTH,
  derivePacingConstants,
  type PacerOptions,
} from '../../src/pacing/pacing-constants.js';

describe('derivePacingConstants', () => {
  it('converts the rate into an interval in microseconds', () => {
    expect(derivePacingConstants({ permitsPerSecond: 100 }).intervalMicros).toBe(10_000);
    expect(derivePacingConstants({ permitsPerSecond: 1 }).intervalMicros).toBe(1_000_000);
    expect(derivePacingConstants({ permitsPerSecond: 1_000_000 }).intervalMicros).toBe(1);
  });

  it('applies the documented defaults', () => {
    expect(DEFAULT_MAX_QUEUE_DELAY_MS).toBe(1000);
    expect(DEFAULT_MAX_QUEUE_DEPTH).toBe(1000);
    expect(derivePacingConstants({ permitsPerSecond: 100 })).toEqual({
      intervalMicros: 10_000,
      maxQueueDelayMicros: 1_000_000,
      maxQueueDepth: 1000,
    });
  });

  it('converts the delay bound once, into microseconds', () => {
    const constants = derivePacingConstants({
      permitsPerSecond: 100,
      maxQueueDelayMs: 250,
      maxQueueDepth: 50,
    });
    expect(constants).toEqual({
      intervalMicros: 10_000,
      maxQueueDelayMicros: 250_000,
      maxQueueDepth: 50,
    });
  });

  it('does not modify the options it is given', () => {
    const options: PacerOptions = Object.freeze({ permitsPerSecond: 100 });
    expect(() => derivePacingConstants(options)).not.toThrow();
    expect(options).toEqual({ permitsPerSecond: 100 });
  });

  describe('rejects invalid options', () => {
    const valid: PacerOptions = { permitsPerSecond: 100, maxQueueDelayMs: 500, maxQueueDepth: 10 };

    it.each([
      { option: 'permitsPerSecond', value: 0 },
      { option: 'permitsPerSecond', value: -1 },
      { option: 'permitsPerSecond', value: NaN },
      { option: 'permitsPerSecond', value: Infinity },
      { option: 'maxQueueDelayMs', value: 0 },
      { option: 'maxQueueDelayMs', value: -1 },
      { option: 'maxQueueDelayMs', value: NaN },
      // Unbounded waiting is refused on purpose: the depth bound alone does
      // not help if every queued caller waits an hour (spec §9.3).
      { option: 'maxQueueDelayMs', value: Infinity },
      { option: 'maxQueueDepth', value: 0 },
      { option: 'maxQueueDepth', value: -1 },
      { option: 'maxQueueDepth', value: 2.5 },
      { option: 'maxQueueDepth', value: NaN },
      { option: 'maxQueueDepth', value: Infinity },
      { option: 'maxQueueDepth', value: 2 ** 53 },
    ] as const)('$option = $value', ({ option, value }) => {
      expect(() => derivePacingConstants({ ...valid, [option]: value })).toThrow(RangeError);
      expect(() => derivePacingConstants({ ...valid, [option]: value })).toThrow(`${option} must`);
    });
  });
});
