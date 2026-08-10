/**
 * Value generators that produce time-varying register values.
 */

export interface SineParams {
  min: number;
  max: number;
  periodMs: number;
}

export interface RampParams {
  start: number;
  end: number;
  durationMs: number;
}

export interface ConstantParams {
  value: number;
}

export interface BehaviorConfig {
  type: 'sine' | 'ramp' | 'constant';
  params: SineParams | RampParams | ConstantParams;
}

/**
 * Sine: midpoint + amplitude * sin(2π * elapsedMs / periodMs)
 *
 * Returns the raw continuous value. Rounding for uint16 registers
 * is handled by the register store.
 */
export function computeSine(params: SineParams, elapsedMs: number): number {
  const midpoint = (params.min + params.max) / 2;
  const amplitude = (params.max - params.min) / 2;
  return midpoint + amplitude * Math.sin((2 * Math.PI * elapsedMs) / params.periodMs);
}

/**
 * Ramp: start + (end - start) * min(elapsed / duration, 1), truncated toward zero.
 *
 * Per Requirement 12.1, the value is truncated to the nearest integer toward zero.
 * Per Requirement 12.2, once elapsed exceeds duration the value clamps at end.
 */
export function computeRamp(params: RampParams, elapsedMs: number): number {
  const progress = Math.min(elapsedMs / params.durationMs, 1.0);
  const value = params.start + (params.end - params.start) * progress;
  // When clamped at end (progress === 1), return exact end value truncated
  return Math.trunc(value);
}

/**
 * Dispatcher: compute the current value for a behavior given elapsed time in ms.
 */
export function computeBehaviorValue(config: BehaviorConfig, elapsedMs: number): number {
  switch (config.type) {
    case 'sine':
      return computeSine(config.params as SineParams, elapsedMs);
    case 'ramp':
      return computeRamp(config.params as RampParams, elapsedMs);
    case 'constant':
      return (config.params as ConstantParams).value;
  }
}
