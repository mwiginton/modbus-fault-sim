import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { float32ToWords, wordsToFloat32 } from '../../src/protocol/float32.js';

describe('float32', () => {
  describe('float32ToWords', () => {
    it('encodes 1.0 as [0x3F80, 0x0000]', () => {
      const [high, low] = float32ToWords(1.0);
      expect(high).toBe(0x3F80);
      expect(low).toBe(0x0000);
    });

    it('encodes -1.0 as [0xBF80, 0x0000]', () => {
      const [high, low] = float32ToWords(-1.0);
      expect(high).toBe(0xBF80);
      expect(low).toBe(0x0000);
    });

    it('encodes 0.0 as [0x0000, 0x0000]', () => {
      const [high, low] = float32ToWords(0.0);
      expect(high).toBe(0x0000);
      expect(low).toBe(0x0000);
    });

    it('encodes 100.0 as [0x42C8, 0x0000]', () => {
      const [high, low] = float32ToWords(100.0);
      expect(high).toBe(0x42C8);
      expect(low).toBe(0x0000);
    });

    it('returns words in the range 0x0000–0xFFFF', () => {
      const [high, low] = float32ToWords(3.14);
      expect(high).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(0xFFFF);
      expect(low).toBeGreaterThanOrEqual(0);
      expect(low).toBeLessThanOrEqual(0xFFFF);
    });
  });

  describe('wordsToFloat32', () => {
    it('decodes [0x3F80, 0x0000] as 1.0', () => {
      expect(wordsToFloat32(0x3F80, 0x0000)).toBe(1.0);
    });

    it('decodes [0xBF80, 0x0000] as -1.0', () => {
      expect(wordsToFloat32(0xBF80, 0x0000)).toBe(-1.0);
    });

    it('decodes [0x0000, 0x0000] as 0.0', () => {
      expect(wordsToFloat32(0x0000, 0x0000)).toBe(0.0);
    });

    it('decodes [0x42C8, 0x0000] as 100.0', () => {
      expect(wordsToFloat32(0x42C8, 0x0000)).toBe(100.0);
    });
  });

  describe('round-trip', () => {
    it('wordsToFloat32(float32ToWords(v)) === v for finite floats', () => {
      const values = [0.0, 1.0, -1.0, 3.14, -273.15, 100.0, 0.001];
      for (const v of values) {
        const [high, low] = float32ToWords(v);
        const result = wordsToFloat32(high, low);
        // Compare with float32 precision (round-trip through single-precision)
        expect(result).toBeCloseTo(v, 2);
      }
    });
  });
});

// **Validates: Requirements 10.1, 10.3**
describe('float32 property tests', () => {
  it('round-trip: wordsToFloat32(float32ToWords(v)) recovers the original float32 value', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const [high, low] = float32ToWords(value);

          // Both words must be valid 16-bit unsigned integers
          expect(high).toBeGreaterThanOrEqual(0);
          expect(high).toBeLessThanOrEqual(0xFFFF);
          expect(low).toBeGreaterThanOrEqual(0);
          expect(low).toBeLessThanOrEqual(0xFFFF);

          // Round-trip must recover the original value
          const recovered = wordsToFloat32(high, low);
          expect(recovered).toBe(value);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('round-trip: float32ToWords(wordsToFloat32(h, l)) recovers the original words', () => {
    fc.assert(
      fc.property(
        fc.nat(0xFFFF), // high word
        fc.nat(0xFFFF), // low word
        (high, low) => {
          const value = wordsToFloat32(high, low);

          // Skip NaN values since NaN !== NaN
          if (Number.isNaN(value)) return;

          const [recoveredHigh, recoveredLow] = float32ToWords(value);
          expect(recoveredHigh).toBe(high);
          expect(recoveredLow).toBe(low);
        }
      ),
      { numRuns: 200 }
    );
  });
});
