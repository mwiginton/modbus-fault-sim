import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateConfig } from '../../src/config/validator.js';
import type { ValidationError } from '../../src/config/schema.js';

/**
 * Helper to build a minimal valid config object for testing address conversion.
 */
function buildConfig(opts: {
  address: number;
  addressBase?: 'documentation' | 'zero';
}) {
  return {
    listen: { host: '127.0.0.1', port: 502 },
    devices: [{
      name: 'device1',
      unitId: 1,
      ...(opts.addressBase !== undefined ? { addressBase: opts.addressBase } : {}),
      registers: [{
        name: 'reg1',
        address: opts.address,
        type: 'uint16',
        initialValue: 0,
      }],
    }],
    scenario: [],
  };
}

/**
 * Helper to build a config with multiple registers on one device for overlap testing.
 */
function buildOverlapConfig(registers: Array<{ name: string; address: number; type: 'uint16' | 'float32' }>) {
  return {
    listen: { host: '127.0.0.1', port: 502 },
    devices: [{
      name: 'device1',
      unitId: 1,
      registers: registers.map((r) => ({
        name: r.name,
        address: r.address,
        type: r.type,
        initialValue: 0,
      })),
    }],
    scenario: [],
  };
}

/**
 * Compute expected overlapping pairs for a set of registers.
 * Uses the same algorithm as the validator: each register claims
 * [address, address + wordCount - 1] where wordCount is 2 for float32, 1 for uint16.
 * Two registers overlap if their ranges intersect.
 */
function computeExpectedOverlaps(
  registers: Array<{ name: string; address: number; type: 'uint16' | 'float32' }>
): Array<{ a: string; b: string }> {
  const overlaps: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < registers.length; i++) {
    for (let j = i + 1; j < registers.length; j++) {
      const regA = registers[i];
      const regB = registers[j];
      const wordCountA = regA.type === 'float32' ? 2 : 1;
      const wordCountB = regB.type === 'float32' ? 2 : 1;
      const endA = regA.address + wordCountA - 1;
      const endB = regB.address + wordCountB - 1;
      // Ranges overlap if startA <= endB && startB <= endA
      if (regA.address <= endB && regB.address <= endA) {
        overlaps.push({ a: regA.name, b: regB.name });
      }
    }
  }
  return overlaps;
}

// Feature: modbus-fault-sim, Property 16: Address Base Conversion
// **Validates: Requirements 8.1, 8.2, 8.3**
describe('validator property tests', () => {
  describe('Property 16: Address Base Conversion', () => {
    it('documentation address >= 40001 produces wire address = A - 40001', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 40001, max: 105535 }), // 40001 + 65535 max wire address
          (address) => {
            const config = buildConfig({ address, addressBase: 'documentation' });
            const result = validateConfig(config);

            // Validation should succeed
            expect(Array.isArray(result)).toBe(false);
            if (!Array.isArray(result)) {
              // Wire address = declared address - 40001
              expect(result.devices[0].registers[0].address).toBe(address - 40001);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('zero-base address is used as-is (no conversion)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 65535 }),
          (address) => {
            const config = buildConfig({ address, addressBase: 'zero' });
            const result = validateConfig(config);

            // Validation should succeed
            expect(Array.isArray(result)).toBe(false);
            if (!Array.isArray(result)) {
              // Wire address = declared address (no conversion)
              expect(result.devices[0].registers[0].address).toBe(address);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('absent addressBase uses address as-is (no conversion)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 65535 }),
          (address) => {
            const config = buildConfig({ address }); // no addressBase field
            const result = validateConfig(config);

            // Validation should succeed
            expect(Array.isArray(result)).toBe(false);
            if (!Array.isArray(result)) {
              // Wire address = declared address (no conversion)
              expect(result.devices[0].registers[0].address).toBe(address);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: modbus-fault-sim, Property 17: Documentation Address Rejection
  // **Validates: Requirements 8.1, 8.2, 8.3**
  describe('Property 17: Documentation Address Rejection', () => {
    it('documentation address < 40001 is rejected with appropriate error', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 40000 }),
          (address) => {
            const config = buildConfig({ address, addressBase: 'documentation' });
            const result = validateConfig(config);

            // Validation should fail
            expect(Array.isArray(result)).toBe(true);
            if (Array.isArray(result)) {
              // Should contain an error mentioning the address rejection
              const hasAddressError = result.some(
                (err) => err.message.includes('documentation addresses must be at least 40001')
              );
              expect(hasAddressError).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: modbus-fault-sim, Property 18: Overlap Detection Completeness
  // **Validates: Requirements 9.1, 9.2, 9.3**
  describe('Property 18: Overlap Detection Completeness', () => {
    /**
     * Arbitrary generator for a set of registers with unique names and
     * varying types (uint16/float32) placed at various addresses.
     */
    const arbRegisters = fc
      .array(
        fc.record({
          address: fc.integer({ min: 0, max: 100 }),
          type: fc.constantFrom('uint16' as const, 'float32' as const),
        }),
        { minLength: 2, maxLength: 8 }
      )
      .map((regs) =>
        regs.map((r, i) => ({
          name: `reg${i}`,
          address: r.address,
          type: r.type,
        }))
      );

    it('reports exactly N overlap errors for N overlapping register pairs', () => {
      fc.assert(
        fc.property(arbRegisters, (registers) => {
          const expectedOverlaps = computeExpectedOverlaps(registers);
          const config = buildOverlapConfig(registers);
          const result = validateConfig(config);

          if (expectedOverlaps.length === 0) {
            // No overlaps: validation should succeed (return ConfigFile, not errors)
            expect(Array.isArray(result)).toBe(false);
          } else {
            // Overlaps present: validation returns errors
            expect(Array.isArray(result)).toBe(true);
            if (Array.isArray(result)) {
              const overlapErrors = (result as ValidationError[]).filter((err) =>
                err.message.includes('overlap at address(es)')
              );
              expect(overlapErrors.length).toBe(expectedOverlaps.length);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('each overlap error names both registers and their conflicting addresses', () => {
      fc.assert(
        fc.property(arbRegisters, (registers) => {
          const expectedOverlaps = computeExpectedOverlaps(registers);
          if (expectedOverlaps.length === 0) return; // skip non-overlapping cases

          const config = buildOverlapConfig(registers);
          const result = validateConfig(config);

          expect(Array.isArray(result)).toBe(true);
          if (Array.isArray(result)) {
            const overlapErrors = (result as ValidationError[]).filter((err) =>
              err.message.includes('overlap at address(es)')
            );

            for (const { a, b } of expectedOverlaps) {
              const matchingError = overlapErrors.find(
                (err) => err.message.includes(`"${a}"`) && err.message.includes(`"${b}"`)
              );
              expect(matchingError).toBeDefined();
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('float32 registers claiming 2 addresses overlap with adjacent registers', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 65530 }),
          (baseAddress) => {
            // Place a float32 at baseAddress (claims baseAddress and baseAddress+1)
            // Place a uint16 at baseAddress+1 (claims only baseAddress+1)
            // These must overlap
            const registers = [
              { name: 'float_reg', address: baseAddress, type: 'float32' as const },
              { name: 'adjacent_reg', address: baseAddress + 1, type: 'uint16' as const },
            ];
            const config = buildOverlapConfig(registers);
            const result = validateConfig(config);

            expect(Array.isArray(result)).toBe(true);
            if (Array.isArray(result)) {
              const overlapErrors = (result as ValidationError[]).filter((err) =>
                err.message.includes('overlap at address(es)')
              );
              expect(overlapErrors.length).toBe(1);
              expect(overlapErrors[0].message).toContain('"float_reg"');
              expect(overlapErrors[0].message).toContain('"adjacent_reg"');
              expect(overlapErrors[0].message).toContain(`${baseAddress + 1}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('reports all overlaps, not just the first', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 65530 }),
          (baseAddress) => {
            // Create 3 registers all at the same address => 3 overlapping pairs
            const registers = [
              { name: 'regA', address: baseAddress, type: 'uint16' as const },
              { name: 'regB', address: baseAddress, type: 'uint16' as const },
              { name: 'regC', address: baseAddress, type: 'uint16' as const },
            ];
            const config = buildOverlapConfig(registers);
            const result = validateConfig(config);

            expect(Array.isArray(result)).toBe(true);
            if (Array.isArray(result)) {
              const overlapErrors = (result as ValidationError[]).filter((err) =>
                err.message.includes('overlap at address(es)')
              );
              // 3 registers => C(3,2) = 3 overlapping pairs
              expect(overlapErrors.length).toBe(3);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: modbus-fault-sim, Property 34: Scenario Entry Validation
  // **Validates: Requirements 16.4**
  describe('Property 34: Scenario Entry Validation', () => {
    const VALID_FAULT_TYPES = ['freeze_register', 'slow_response', 'connection_drop'];

    /**
     * Helper to build a config with a specific scenario entry for testing.
     * Uses a known device "pump1" with register "flow" so valid targets are:
     * "pump1" and "pump1.flow"
     */
    function buildScenarioConfig(scenarioEntry: Record<string, unknown>) {
      return {
        listen: { host: '127.0.0.1', port: 502 },
        devices: [{
          name: 'pump1',
          unitId: 1,
          registers: [{
            name: 'flow',
            address: 0,
            type: 'uint16',
            initialValue: 0,
          }],
        }],
        scenario: [scenarioEntry],
      };
    }

    it('rejects scenario entries with invalid fault types', () => {
      // Generate random strings that are NOT valid fault types
      const arbInvalidFault = fc.string({ minLength: 1, maxLength: 30 })
        .filter((s) => !VALID_FAULT_TYPES.includes(s));

      fc.assert(
        fc.property(arbInvalidFault, (invalidFault) => {
          const config = buildScenarioConfig({
            offsetMs: 1000,
            fault: invalidFault,
            target: 'pump1', // valid target
          });
          const result = validateConfig(config);

          // Should be rejected (returns array of errors)
          expect(Array.isArray(result)).toBe(true);
          if (Array.isArray(result)) {
            const faultError = (result as ValidationError[]).find(
              (err) => err.path === 'scenario[0].fault'
            );
            expect(faultError).toBeDefined();
            expect(faultError!.message).toContain(`Invalid fault type "${invalidFault}"`);
            expect(faultError!.message).toContain('must be one of: freeze_register, slow_response, connection_drop');
          }
        }),
        { numRuns: 100 }
      );
    });

    it('rejects scenario entries with non-existent targets', () => {
      // Valid targets for the config are: "pump1" and "pump1.flow"
      const validTargets = ['pump1', 'pump1.flow'];

      // Generate random strings that do NOT match any valid target
      const arbInvalidTarget = fc.string({ minLength: 1, maxLength: 30 })
        .filter((s) => !validTargets.includes(s));

      fc.assert(
        fc.property(arbInvalidTarget, (invalidTarget) => {
          const config = buildScenarioConfig({
            offsetMs: 1000,
            fault: 'freeze_register', // valid fault type
            target: invalidTarget,
          });
          const result = validateConfig(config);

          // Should be rejected (returns array of errors)
          expect(Array.isArray(result)).toBe(true);
          if (Array.isArray(result)) {
            const targetError = (result as ValidationError[]).find(
              (err) => err.path === 'scenario[0].target'
            );
            expect(targetError).toBeDefined();
            expect(targetError!.message).toContain(`Target "${invalidTarget}" does not match any configured device or register`);
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
