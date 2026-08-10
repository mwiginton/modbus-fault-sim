import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeRamp, type RampParams } from '../../src/signals/behaviors.js';

/**
 * Validates: Requirements 12.1, 12.2, 12.3
 *
 * Property-based tests for ramp behavior covering the linear formula
 * with Math.trunc, and clamping to end value after duration.
 */

/** Arbitrary for valid RampParams. durationMs must be > 0. */
function arbRampParams(): fc.Arbitrary<RampParams> {
  return fc.record({
    start: fc.integer({ min: -32768, max: 65535 }),
    end: fc.integer({ min: -32768, max: 65535 }),
    durationMs: fc.integer({ min: 1, max: 1_000_000 }),
  });
}

/** Arbitrary for elapsed time within ramp duration. */
function arbElapsedInRange(durationMs: number): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max: durationMs });
}

/** Arbitrary for elapsed time strictly greater than duration. */
function arbElapsedBeyond(durationMs: number): fc.Arbitrary<number> {
  return fc.integer({ min: durationMs + 1, max: durationMs + 1_000_000 });
}

describe('Ramp Behavior Property Tests', () => {
  // Feature: modbus-fault-sim, Property 25: Ramp Behavior Formula
  it('Property 25: computed value equals Math.trunc(start + (end - start) * (T / durationMs)) for 0 <= T <= durationMs', () => {
    fc.assert(
      fc.property(arbRampParams(), (params) => {
        return fc.assert(
          fc.property(arbElapsedInRange(params.durationMs), (elapsedMs) => {
            const result = computeRamp(params, elapsedMs);
            const expected = Math.trunc(
              params.start + (params.end - params.start) * (elapsedMs / params.durationMs)
            );
            expect(result).toBe(expected);
          }),
          { numRuns: 10 }
        );
      }),
      { numRuns: 100 }
    );
  });

  // Feature: modbus-fault-sim, Property 26: Ramp Behavior Clamping
  it('Property 26: computed value equals Math.trunc(end) for any T > durationMs', () => {
    fc.assert(
      fc.property(arbRampParams(), (params) => {
        return fc.assert(
          fc.property(arbElapsedBeyond(params.durationMs), (elapsedMs) => {
            const result = computeRamp(params, elapsedMs);
            // Once elapsed exceeds duration, the ramp clamps at end value
            expect(result).toBe(Math.trunc(params.end));
          }),
          { numRuns: 10 }
        );
      }),
      { numRuns: 100 }
    );
  });
});
