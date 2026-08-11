import { describe, it, expect } from 'vitest';
import {
  RegisterStore,
  ErrorCode,
  type RegisterDescriptor,
} from '../../src/signals/register-store.js';
import { float32ToWords, wordsToFloat32 } from '../../src/protocol/float32.js';

function makeClock(ms: number = 0): () => number {
  return () => ms;
}

describe('RegisterStore', () => {
  describe('basic uint16 read/write', () => {
    it('reads initial value of a uint16 register', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'temp', address: 0, type: 'uint16', initialValue: 100 },
      ];
      const store = new RegisterStore(regs, makeClock());
      const result = store.readRegisters(0, 1);
      expect(result).toEqual([100]);
    });

    it('reads multiple consecutive uint16 registers', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'r0', address: 0, type: 'uint16', initialValue: 10 },
        { name: 'r1', address: 1, type: 'uint16', initialValue: 20 },
        { name: 'r2', address: 2, type: 'uint16', initialValue: 30 },
      ];
      const store = new RegisterStore(regs, makeClock());
      const result = store.readRegisters(0, 3);
      expect(result).toEqual([10, 20, 30]);
    });

    it('writeSingle updates value and subsequent read returns new value (Req 2.1, 2.2)', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'temp', address: 0, type: 'uint16', initialValue: 100 },
      ];
      const store = new RegisterStore(regs, makeClock());
      const err = store.writeSingle(0, 500);
      expect(err).toBeUndefined();
      expect(store.readRegisters(0, 1)).toEqual([500]);
    });

    it('writeMultiple updates multiple registers (Req 3.1)', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'r0', address: 0, type: 'uint16', initialValue: 0 },
        { name: 'r1', address: 1, type: 'uint16', initialValue: 0 },
        { name: 'r2', address: 2, type: 'uint16', initialValue: 0 },
      ];
      const store = new RegisterStore(regs, makeClock());
      const err = store.writeMultiple(0, [111, 222, 333]);
      expect(err).toBeUndefined();
      expect(store.readRegisters(0, 3)).toEqual([111, 222, 333]);
    });
  });

  describe('address validation', () => {
    it('readRegisters returns ILLEGAL_DATA_ADDRESS for invalid start address', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'r0', address: 0, type: 'uint16', initialValue: 10 },
      ];
      const store = new RegisterStore(regs, makeClock());
      expect(store.readRegisters(5, 1)).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
    });

    it('readRegisters returns ILLEGAL_DATA_ADDRESS when range extends past valid registers', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'r0', address: 0, type: 'uint16', initialValue: 10 },
        { name: 'r1', address: 1, type: 'uint16', initialValue: 20 },
      ];
      const store = new RegisterStore(regs, makeClock());
      expect(store.readRegisters(0, 5)).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
    });

    it('writeSingle returns ILLEGAL_DATA_ADDRESS for unknown address', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'r0', address: 0, type: 'uint16', initialValue: 10 },
      ];
      const store = new RegisterStore(regs, makeClock());
      expect(store.writeSingle(99, 42)).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
    });

    it('writeMultiple returns ILLEGAL_DATA_ADDRESS when range extends past valid registers', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'r0', address: 0, type: 'uint16', initialValue: 0 },
      ];
      const store = new RegisterStore(regs, makeClock());
      expect(store.writeMultiple(0, [1, 2, 3])).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
    });

    it('hasAddress returns true for existing address', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'r0', address: 5, type: 'uint16', initialValue: 0 },
      ];
      const store = new RegisterStore(regs, makeClock());
      expect(store.hasAddress(5)).toBe(true);
    });

    it('hasAddress returns false for non-existing address', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'r0', address: 5, type: 'uint16', initialValue: 0 },
      ];
      const store = new RegisterStore(regs, makeClock());
      expect(store.hasAddress(99)).toBe(false);
    });
  });

  describe('float32 handling', () => {
    it('float32 occupies two consecutive addresses (Req 10.1)', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'pressure', address: 10, type: 'float32', initialValue: 3.14 },
      ];
      const store = new RegisterStore(regs, makeClock());
      expect(store.hasAddress(10)).toBe(true);
      expect(store.hasAddress(11)).toBe(true);
    });

    it('reading float32 returns two uint16 words in big-endian order (Req 10.1, 10.2)', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'pressure', address: 10, type: 'float32', initialValue: 3.14 },
      ];
      const store = new RegisterStore(regs, makeClock());
      const result = store.readRegisters(10, 2);
      const [hi, lo] = float32ToWords(3.14);
      expect(result).toEqual([hi, lo]);
    });

    it('reading partial float32 (single word) returns individual word (Req 10.2)', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'pressure', address: 10, type: 'float32', initialValue: 3.14 },
      ];
      const store = new RegisterStore(regs, makeClock());
      const [hi, lo] = float32ToWords(3.14);
      expect(store.readRegisters(10, 1)).toEqual([hi]);
      expect(store.readRegisters(11, 1)).toEqual([lo]);
    });

    it('FC 16 writing 2 registers at float32 base address decodes as IEEE 754 (Req 10.3)', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'pressure', address: 10, type: 'float32', initialValue: 0 },
      ];
      const store = new RegisterStore(regs, makeClock());
      const [hi, lo] = float32ToWords(6.28);
      const err = store.writeMultiple(10, [hi, lo]);
      expect(err).toBeUndefined();
      // Read back and verify
      const result = store.readRegisters(10, 2) as number[];
      const decoded = wordsToFloat32(result[0], result[1]);
      expect(decoded).toBeCloseTo(6.28, 2);
    });

    it('FC 06 on float32 address returns ILLEGAL_DATA_ADDRESS (Req 10.4)', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'pressure', address: 10, type: 'float32', initialValue: 0 },
      ];
      const store = new RegisterStore(regs, makeClock());
      expect(store.writeSingle(10, 100)).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
      expect(store.writeSingle(11, 200)).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
    });

    it('mixed read spanning uint16 and float32 returns correct words (Req 10.2)', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'count', address: 0, type: 'uint16', initialValue: 42 },
        { name: 'pressure', address: 1, type: 'float32', initialValue: 1.5 },
      ];
      const store = new RegisterStore(regs, makeClock());
      const [hi, lo] = float32ToWords(1.5);
      const result = store.readRegisters(0, 3);
      expect(result).toEqual([42, hi, lo]);
    });
  });

  describe('freeze/unfreeze (Req 13.1–13.4)', () => {
    it('freeze captures current value and returns it for subsequent reads (Req 13.1)', () => {
      let time = 0;
      const regs: RegisterDescriptor[] = [
        {
          name: 'sensor',
          address: 0,
          type: 'uint16',
          initialValue: 0,
          behavior: { type: 'ramp', params: { start: 0, end: 100, durationMs: 1000 } },
        },
      ];
      const store = new RegisterStore(regs, () => time);

      time = 500;
      store.freeze('sensor');
      const frozenVal = store.readRegisters(0, 1);

      time = 900;
      const afterVal = store.readRegisters(0, 1);
      expect(afterVal).toEqual(frozenVal);
    });

    it('writes are ignored while frozen but respond as if succeeded (Req 13.2)', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'reg', address: 0, type: 'uint16', initialValue: 10 },
      ];
      const store = new RegisterStore(regs, makeClock());
      store.freeze('reg');
      const err = store.writeSingle(0, 999);
      expect(err).toBeUndefined(); // responds as if succeeded
      expect(store.readRegisters(0, 1)).toEqual([10]); // value unchanged
    });

    it('unfreeze restores live values (Req 13.3)', () => {
      let time = 0;
      const regs: RegisterDescriptor[] = [
        {
          name: 'sensor',
          address: 0,
          type: 'uint16',
          initialValue: 0,
          behavior: { type: 'ramp', params: { start: 0, end: 100, durationMs: 1000 } },
        },
      ];
      const store = new RegisterStore(regs, () => time);

      time = 200;
      store.freeze('sensor');

      time = 800;
      store.unfreeze('sensor');
      const result = store.readRegisters(0, 1) as number[];
      // At time=800, ramp value = trunc(0 + 100 * 0.8) = 80
      expect(result[0]).toBe(80);
    });

    it('multi-register read returns frozen value for frozen and live for non-frozen (Req 13.4)', () => {
      let time = 0;
      const regs: RegisterDescriptor[] = [
        {
          name: 'frozen_reg',
          address: 0,
          type: 'uint16',
          initialValue: 0,
          behavior: { type: 'ramp', params: { start: 0, end: 100, durationMs: 1000 } },
        },
        {
          name: 'live_reg',
          address: 1,
          type: 'uint16',
          initialValue: 0,
          behavior: { type: 'ramp', params: { start: 0, end: 200, durationMs: 1000 } },
        },
      ];
      const store = new RegisterStore(regs, () => time);

      time = 500;
      store.freeze('frozen_reg');
      // frozen_reg frozen at time=500 => trunc(50) = 50

      time = 800;
      const result = store.readRegisters(0, 2) as number[];
      // frozen_reg should still be 50
      expect(result[0]).toBe(50);
      // live_reg at time=800 => trunc(0 + 200 * 0.8) = 160
      expect(result[1]).toBe(160);
    });

    it('writeMultiple is ignored for frozen float32 register (Req 13.2)', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'pressure', address: 0, type: 'float32', initialValue: 1.0 },
      ];
      const store = new RegisterStore(regs, makeClock());
      store.freeze('pressure');
      const [hi, lo] = float32ToWords(9.99);
      const err = store.writeMultiple(0, [hi, lo]);
      expect(err).toBeUndefined();
      // Value should still be 1.0
      const [origHi, origLo] = float32ToWords(1.0);
      expect(store.readRegisters(0, 2)).toEqual([origHi, origLo]);
    });
  });

  describe('behavior computation', () => {
    it('applies behavior when reading uint16 register (rounds result)', () => {
      const regs: RegisterDescriptor[] = [
        {
          name: 'sensor',
          address: 0,
          type: 'uint16',
          initialValue: 0,
          behavior: { type: 'sine', params: { min: 0, max: 100, periodMs: 1000 } },
        },
      ];
      // At T=250, sine returns max=100
      const store = new RegisterStore(regs, makeClock(250));
      const result = store.readRegisters(0, 1) as number[];
      expect(result[0]).toBe(100);
    });

    it('applies behavior for float32 register without rounding', () => {
      const regs: RegisterDescriptor[] = [
        {
          name: 'measurement',
          address: 0,
          type: 'float32',
          initialValue: 0,
          behavior: { type: 'constant', params: { value: 2.718 } },
        },
      ];
      const store = new RegisterStore(regs, makeClock(0));
      const result = store.readRegisters(0, 2) as number[];
      const decoded = wordsToFloat32(result[0], result[1]);
      expect(decoded).toBeCloseTo(2.718, 2);
    });

    it('returns stored currentValue when no behavior is configured', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'reg', address: 0, type: 'uint16', initialValue: 42 },
      ];
      const store = new RegisterStore(regs, makeClock(9999));
      expect(store.readRegisters(0, 1)).toEqual([42]);
    });

    it('write overrides behavior for subsequent reads when no behavior', () => {
      const regs: RegisterDescriptor[] = [
        { name: 'reg', address: 0, type: 'uint16', initialValue: 0 },
      ];
      const store = new RegisterStore(regs, makeClock());
      store.writeSingle(0, 777);
      expect(store.readRegisters(0, 1)).toEqual([777]);
    });
  });
});


import fc from 'fast-check';
import { computeBehaviorValue, type BehaviorConfig } from '../../src/signals/behaviors.js';

/**
 * Validates: Requirements 2.2, 10.1, 10.2, 13.1, 13.2, 13.3, 13.4
 *
 * Property-based tests for register store covering write/read round trips,
 * float32 encoding consistency, and freeze/unfreeze behavior.
 */

describe('RegisterStore Property Tests', () => {
  // Feature: modbus-fault-sim, Property 7: FC 06 Write-Then-Read Round Trip
  it('Property 7: for any uint16 register and any uint16 value, writeSingle then readRegisters returns the written value', () => {
    fc.assert(
      fc.property(
        fc.nat(65535), // address (we'll use it as initial value too)
        fc.nat(65535), // value to write
        (initialValue, writeValue) => {
          const regs: RegisterDescriptor[] = [
            { name: 'reg', address: 0, type: 'uint16', initialValue },
          ];
          const store = new RegisterStore(regs, () => 0);

          const err = store.writeSingle(0, writeValue);
          expect(err).toBeUndefined();

          const result = store.readRegisters(0, 1);
          expect(result).toEqual([writeValue]);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: modbus-fault-sim, Property 20: Float32 Read Consistency
  it('Property 20: for any float32 register holding value V, reading two consecutive addresses returns words that decode to V', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const regs: RegisterDescriptor[] = [
            { name: 'sensor', address: 0, type: 'float32', initialValue: value },
          ];
          const store = new RegisterStore(regs, () => 0);

          const result = store.readRegisters(0, 2);
          expect(Array.isArray(result)).toBe(true);

          const words = result as number[];
          const decoded = wordsToFloat32(words[0], words[1]);

          // Float32 round-trip: the decoded value should be bitwise identical
          // to what float32ToWords would produce from the initial value
          const [expectedHi, expectedLo] = float32ToWords(value);
          expect(words[0]).toBe(expectedHi);
          expect(words[1]).toBe(expectedLo);
          expect(decoded).toBe(value);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: modbus-fault-sim, Property 27: Freeze Captures and Holds Value
  it('Property 27: when a register with behavior is frozen at T1, all reads at T2 > T1 return the value at T1', () => {
    fc.assert(
      fc.property(
        fc.nat(10000), // freeze time T1
        fc.nat(10000), // additional time after freeze
        (t1, additionalTime) => {
          const t2 = t1 + additionalTime + 1; // ensure T2 > T1
          let now = 0;
          const clock = () => now;

          const behavior: BehaviorConfig = {
            type: 'sine',
            params: { min: 0, max: 1000, periodMs: 5000 },
          };
          const regs: RegisterDescriptor[] = [
            { name: 'sensor', address: 0, type: 'uint16', initialValue: 0, behavior },
          ];
          const store = new RegisterStore(regs, clock);

          // Freeze at T1
          now = t1;
          store.freeze('sensor');
          const frozenResult = store.readRegisters(0, 1) as number[];

          // Read at T2 > T1
          now = t2;
          const laterResult = store.readRegisters(0, 1) as number[];

          expect(laterResult[0]).toBe(frozenResult[0]);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: modbus-fault-sim, Property 28: Freeze Ignores Writes
  it('Property 28: for any frozen register, a write produces success but subsequent read returns frozen value', () => {
    fc.assert(
      fc.property(
        fc.nat(65535), // initial value
        fc.nat(65535), // value to write while frozen
        (initialValue, writeValue) => {
          const regs: RegisterDescriptor[] = [
            { name: 'reg', address: 0, type: 'uint16', initialValue },
          ];
          const store = new RegisterStore(regs, () => 0);

          store.freeze('reg');
          const frozenResult = store.readRegisters(0, 1) as number[];

          // Write while frozen should succeed (return undefined)
          const err = store.writeSingle(0, writeValue);
          expect(err).toBeUndefined();

          // Read should still return the frozen value
          const afterWrite = store.readRegisters(0, 1) as number[];
          expect(afterWrite[0]).toBe(frozenResult[0]);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: modbus-fault-sim, Property 29: Freeze-Unfreeze Round Trip
  it('Property 29: freezing and unfreezing restores live behavior values at current time', () => {
    fc.assert(
      fc.property(
        fc.nat(5000),  // freeze time
        fc.nat(10000), // unfreeze time offset (added to freeze time)
        (freezeTime, unfreezeOffset) => {
          const unfreezeTime = freezeTime + unfreezeOffset + 1;
          let now = 0;
          const clock = () => now;

          const behavior: BehaviorConfig = {
            type: 'sine',
            params: { min: 100, max: 900, periodMs: 4000 },
          };
          const regs: RegisterDescriptor[] = [
            { name: 'sensor', address: 0, type: 'uint16', initialValue: 0, behavior },
          ];
          const store = new RegisterStore(regs, clock);

          // Freeze at some time
          now = freezeTime;
          store.freeze('sensor');

          // Unfreeze at a later time
          now = unfreezeTime;
          store.unfreeze('sensor');

          // After unfreeze, the read should return the live behavior value at current time
          const result = store.readRegisters(0, 1) as number[];
          const expectedLiveValue = Math.round(computeBehaviorValue(behavior, unfreezeTime));
          expect(result[0]).toBe(expectedLiveValue);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: modbus-fault-sim, Property 30: Partial Freeze in Multi-Register Read
  it('Property 30: multi-register read returns frozen value for frozen registers and live value for unfrozen', () => {
    fc.assert(
      fc.property(
        fc.nat(5000),  // freeze time
        fc.nat(10000), // read time offset (added to freeze time)
        (freezeTime, readOffset) => {
          const readTime = freezeTime + readOffset + 1;
          let now = 0;
          const clock = () => now;

          const frozenBehavior: BehaviorConfig = {
            type: 'ramp',
            params: { start: 0, end: 1000, durationMs: 10000 },
          };
          const liveBehavior: BehaviorConfig = {
            type: 'ramp',
            params: { start: 0, end: 2000, durationMs: 10000 },
          };

          const regs: RegisterDescriptor[] = [
            { name: 'frozen_reg', address: 0, type: 'uint16', initialValue: 0, behavior: frozenBehavior },
            { name: 'live_reg', address: 1, type: 'uint16', initialValue: 0, behavior: liveBehavior },
          ];
          const store = new RegisterStore(regs, clock);

          // Freeze first register at freezeTime
          now = freezeTime;
          store.freeze('frozen_reg');
          const frozenValue = store.readRegisters(0, 1) as number[];

          // Read both at a later time
          now = readTime;
          const result = store.readRegisters(0, 2) as number[];

          // Frozen register should hold frozen value
          expect(result[0]).toBe(frozenValue[0]);

          // Live register should reflect current time behavior
          const expectedLive = Math.round(computeBehaviorValue(liveBehavior, readTime));
          expect(result[1]).toBe(expectedLive);
        }
      ),
      { numRuns: 100 }
    );
  });
});
