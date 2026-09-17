import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/clock/clock.js';
import { SystemClock } from '../../src/clock/system-clock.js';

describe('SystemClock', () => {
  it('satisfies the Clock interface', () => {
    const clock: Clock = new SystemClock();
    expect(typeof clock.now()).toBe('bigint');
  });

  it('never goes backwards across successive readings', () => {
    const clock = new SystemClock();
    let previous = clock.now();
    for (let i = 0; i < 1_000; i++) {
      const current = clock.now();
      // Greater than or equal: two readings can legitimately be identical.
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
