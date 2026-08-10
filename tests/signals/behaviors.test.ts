import { describe, it, expect } from 'vitest';
import {
  computeSine,
  computeRamp,
  computeBehaviorValue,
  type SineParams,
  type RampParams,
  type BehaviorConfig,
} from '../../src/signals/behaviors.js';

describe('computeSine', () => {
  const params: SineParams = { min: 0, max: 100, periodMs: 1000 };

  it('returns midpoint at T=0', () => {
    expect(computeSine(params, 0)).toBeCloseTo(50, 10);
  });

  it('returns max at T=period/4', () => {
    expect(computeSine(params, 250)).toBeCloseTo(100, 10);
  });

  it('returns midpoint at T=period/2', () => {
    expect(computeSine(params, 500)).toBeCloseTo(50, 10);
  });

  it('returns min at T=3*period/4', () => {
    expect(computeSine(params, 750)).toBeCloseTo(0, 10);
  });

  it('is periodic: value at T equals value at T + period', () => {
    const t = 137;
    expect(computeSine(params, t)).toBeCloseTo(computeSine(params, t + 1000), 10);
  });

  it('handles negative min/max ranges', () => {
    const p: SineParams = { min: -50, max: 50, periodMs: 2000 };
    expect(computeSine(p, 0)).toBeCloseTo(0, 10);
    expect(computeSine(p, 500)).toBeCloseTo(50, 10);
  });
});

describe('computeRamp', () => {
  const params: RampParams = { start: 0, end: 100, durationMs: 1000 };

  it('returns start (truncated) at T=0', () => {
    expect(computeRamp(params, 0)).toBe(0);
  });

  it('returns truncated midpoint at T=duration/2', () => {
    expect(computeRamp(params, 500)).toBe(50);
  });

  it('returns end value at T=duration', () => {
    expect(computeRamp(params, 1000)).toBe(100);
  });

  it('clamps at end value when T > duration', () => {
    expect(computeRamp(params, 2000)).toBe(100);
    expect(computeRamp(params, 99999)).toBe(100);
  });

  it('truncates toward zero for positive fractional values', () => {
    // start=0, end=10, durationMs=3 => at T=1, value = 10*(1/3) = 3.333... => trunc => 3
    const p: RampParams = { start: 0, end: 10, durationMs: 3 };
    expect(computeRamp(p, 1)).toBe(3);
  });

  it('truncates toward zero for negative fractional values', () => {
    // start=0, end=-10, durationMs=3 => at T=1, value = -10*(1/3) = -3.333... => trunc => -3
    const p: RampParams = { start: 0, end: -10, durationMs: 3 };
    expect(computeRamp(p, 1)).toBe(-3);
  });

  it('ramps downward when start > end', () => {
    const p: RampParams = { start: 100, end: 0, durationMs: 1000 };
    expect(computeRamp(p, 0)).toBe(100);
    expect(computeRamp(p, 500)).toBe(50);
    expect(computeRamp(p, 1000)).toBe(0);
  });
});

describe('computeBehaviorValue', () => {
  it('dispatches to sine', () => {
    const config: BehaviorConfig = {
      type: 'sine',
      params: { min: 0, max: 100, periodMs: 1000 },
    };
    expect(computeBehaviorValue(config, 0)).toBeCloseTo(50, 10);
  });

  it('dispatches to ramp', () => {
    const config: BehaviorConfig = {
      type: 'ramp',
      params: { start: 10, end: 20, durationMs: 100 },
    };
    expect(computeBehaviorValue(config, 50)).toBe(15);
  });

  it('dispatches to constant', () => {
    const config: BehaviorConfig = {
      type: 'constant',
      params: { value: 42 },
    };
    expect(computeBehaviorValue(config, 0)).toBe(42);
    expect(computeBehaviorValue(config, 99999)).toBe(42);
  });
});
