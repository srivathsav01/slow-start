import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/clock/clock.js';
import { ManualClock } from '../../src/clock/manual-clock.js';

describe('ManualClock', () => {
  it('satisfies the Clock interface', () => {
    // Checked by the type checker: this line stops compiling if
    // ManualClock no longer matches Clock.
    const clock: Clock = new ManualClock();
    expect(clock.now()).toBe(0n);
  });

  it('starts at zero', () => {
    expect(new ManualClock().now()).toBe(0n);
  });

  it('advances by exactly the amount given', () => {
    const clock = new ManualClock();
    clock.advance(1_500n);
    expect(clock.now()).toBe(1_500n);
  });

  it('accumulates successive advances', () => {
    const clock = new ManualClock();
    clock.advance(100n);
    clock.advance(250n);
    clock.advance(1_000_000_000n);
    expect(clock.now()).toBe(1_000_000_350n);
  });

  it('does not move on its own', () => {
    const clock = new ManualClock();
    clock.advance(42n);
    expect(clock.now()).toBe(clock.now());
    expect(clock.now()).toBe(42n);
  });

  it('allows advancing by zero', () => {
    const clock = new ManualClock();
    clock.advance(42n);
    clock.advance(0n);
    expect(clock.now()).toBe(42n);
  });

  it('rejects a negative advance and leaves time unchanged', () => {
    const clock = new ManualClock();
    clock.advance(42n);
    expect(() => {
      clock.advance(-1n);
    }).toThrow(RangeError);
    expect(clock.now()).toBe(42n);
  });
});
