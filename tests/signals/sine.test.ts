import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeSine, type SineParams } from '../../src/signals/behaviors.js';

/**
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4
 *
 * Property-based tests for sine behavior covering formula correctness,
 * periodicity, initial conditions, and integer rounding for uint16.
 */

/** Arbitrary for valid SineParams within uint16 range. */
function arbSineParams(): fc.Arbitrary<SineParams> {
  return fc
    .tuple(fc.nat(65534), fc.nat(65534))
    .filter(([a, b]) => a !== b)
    .chain(([a, b]) => {
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      return fc.nat(99999).map((p) => ({
        min,
        max,
        periodMs: p + 1, // periodMs must be > 0
      }));
    });
}

/** Arbitrary for elapsed time (non-negative). */
function arbElapsedMs(): fc.Arbitrary<number> {
  return fc.nat(1_000_000);
}

describe('Sine Behavior Property Tests', () => {
  // Feature: modbus-fault-sim, Property 21: Sine Behavior Formula
  it('Property 21: computed value equals midpoint + amplitude * sin(2π * T / periodMs)', () => {
    fc.assert(
      fc.property(arbSineParams(), arbElapsedMs(), (params, elapsedMs) => {
        const result = computeSine(params, elapsedMs);

        const midpoint = (params.min + params.max) / 2;
        const amplitude = (params.max - params.min) / 2;
        const expected = midpoint + amplitude * Math.sin((2 * Math.PI * elapsedMs) / params.periodMs);

        expect(result).toBeCloseTo(expected, 10);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: modbus-fault-sim, Property 22: Sine Behavior Periodicity
  it('Property 22: value at T equals value at T + periodMs', () => {
    fc.assert(
      fc.property(arbSineParams(), arbElapsedMs(), (params, elapsedMs) => {
        const valueAtT = computeSine(params, elapsedMs);
        const valueAtTPlusPeriod = computeSine(params, elapsedMs + params.periodMs);

        // Use tolerance proportional to the amplitude to account for
        // floating-point errors with large elapsedMs / small periodMs ratios.
        const amplitude = (params.max - params.min) / 2;
        const tolerance = amplitude * 1e-7;
        expect(Math.abs(valueAtT - valueAtTPlusPeriod)).toBeLessThanOrEqual(tolerance);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: modbus-fault-sim, Property 23: Sine Behavior Initial Conditions
  it('Property 23: value at T=0 equals midpoint and value at T=periodMs/4 equals max', () => {
    fc.assert(
      fc.property(arbSineParams(), (params) => {
        const midpoint = (params.min + params.max) / 2;

        // At T=0, sin(0) = 0, so value = midpoint
        const valueAtZero = computeSine(params, 0);
        expect(valueAtZero).toBeCloseTo(midpoint, 10);

        // At T=periodMs/4, sin(π/2) = 1, so value = midpoint + amplitude = max
        const valueAtQuarter = computeSine(params, params.periodMs / 4);
        expect(valueAtQuarter).toBeCloseTo(params.max, 8);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: modbus-fault-sim, Property 24: Sine Integer Rounding
  it('Property 24: Math.round of computeSine produces correct uint16 integer value', () => {
    fc.assert(
      fc.property(arbSineParams(), arbElapsedMs(), (params, elapsedMs) => {
        const continuousValue = computeSine(params, elapsedMs);
        const rounded = Math.round(continuousValue);

        // The rounded value should be the nearest integer (half-up rounding)
        const midpoint = (params.min + params.max) / 2;
        const amplitude = (params.max - params.min) / 2;
        const expected = midpoint + amplitude * Math.sin((2 * Math.PI * elapsedMs) / params.periodMs);
        expect(rounded).toBe(Math.round(expected));

        // The rounded value should be within uint16 range [0, 65535]
        // since min and max are both within [0, 65535]
        expect(rounded).toBeGreaterThanOrEqual(Math.round(params.min));
        expect(rounded).toBeLessThanOrEqual(Math.round(params.max));
      }),
      { numRuns: 100 }
    );
  });
});
