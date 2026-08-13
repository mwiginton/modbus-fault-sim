/**
 * Tests for FC 06 (Write Single Register) handler.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { handleWriteSingleRegister } from '../../src/protocol/handlers/fc06.js';
import { RegisterStore, type RegisterDescriptor } from '../../src/signals/register-store.js';
import type { ModbusRequest, MbapHeader } from '../../src/protocol/frame-parser.js';

/** Helper to create a ModbusRequest for FC 06 with given address and value. */
function makeRequest(address: number, value: number): ModbusRequest {
  const data = Buffer.alloc(4);
  data.writeUInt16BE(address, 0);
  data.writeUInt16BE(value, 2);

  const header: MbapHeader = {
    transactionId: 1,
    protocolId: 0,
    length: 6,
    unitId: 1,
  };

  return { header, functionCode: 0x06, data };
}

/** Helper to create a RegisterStore with sequential uint16 registers. */
function makeStore(startAddress: number, count: number, values?: number[]): RegisterStore {
  const descriptors: RegisterDescriptor[] = [];
  for (let i = 0; i < count; i++) {
    descriptors.push({
      name: `reg${i}`,
      address: startAddress + i,
      type: 'uint16',
      initialValue: values ? values[i] : 0,
    });
  }
  return new RegisterStore(descriptors, () => 0);
}

/** Helper to create a RegisterStore with a float32 register. */
function makeFloat32Store(address: number): RegisterStore {
  const descriptors: RegisterDescriptor[] = [
    {
      name: 'floatReg',
      address,
      type: 'float32',
      initialValue: 1.5,
    },
  ];
  return new RegisterStore(descriptors, () => 0);
}

describe('handleWriteSingleRegister', () => {
  describe('successful writes', () => {
    it('writes a value and echoes request PDU', () => {
      const store = makeStore(0, 5);
      const request = makeRequest(2, 1234);

      const result = handleWriteSingleRegister(request, store);

      expect(result.type).toBe('response');
      // Response PDU: FC 06 + address (2 bytes) + value (2 bytes)
      expect(result.pdu).toEqual(Buffer.from([0x06, 0x00, 0x02, 0x04, 0xD2]));
    });

    it('echoes the exact request PDU bytes', () => {
      const store = makeStore(100, 1, [0]);
      const request = makeRequest(100, 0xABCD);

      const result = handleWriteSingleRegister(request, store);

      expect(result.type).toBe('response');
      expect(result.pdu).toEqual(Buffer.from([0x06, 0x00, 0x64, 0xAB, 0xCD]));
    });

    it('persists the written value (readable via store)', () => {
      const store = makeStore(0, 3, [0, 0, 0]);
      const request = makeRequest(1, 999);

      handleWriteSingleRegister(request, store);

      // Verify value persisted by reading from store
      const readResult = store.readRegisters(1, 1);
      expect(readResult).toEqual([999]);
    });
  });

  describe('address validation', () => {
    it('returns exception 0x02 when address does not exist', () => {
      const store = makeStore(0, 5);
      const request = makeRequest(10, 42);

      const result = handleWriteSingleRegister(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x86, 0x02]));
    });

    it('returns exception 0x02 when targeting a float32 base address', () => {
      const store = makeFloat32Store(10);
      const request = makeRequest(10, 42);

      const result = handleWriteSingleRegister(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x86, 0x02]));
    });

    it('returns exception 0x02 when targeting a float32 second word', () => {
      const store = makeFloat32Store(10);
      const request = makeRequest(11, 42);

      const result = handleWriteSingleRegister(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x86, 0x02]));
    });
  });
});


// Feature: modbus-fault-sim, Property 6: FC 06 Echo Response
// **Validates: Requirements 2.1**
describe('FC 06 property tests', () => {
  describe('Property 6: FC 06 Echo Response', () => {
    it('valid FC 06 request targeting a uint16 register echoes request PDU byte-for-byte', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 65535 }),   // address
          fc.integer({ min: 0, max: 65535 }),   // value
          (address, value) => {
            // Create a store with a uint16 register at the target address
            const descriptors: RegisterDescriptor[] = [{
              name: 'target',
              address,
              type: 'uint16',
              initialValue: 0,
            }];
            const store = new RegisterStore(descriptors, () => 0);

            // Build FC 06 request
            const data = Buffer.alloc(4);
            data.writeUInt16BE(address, 0);
            data.writeUInt16BE(value, 2);
            const header: MbapHeader = { transactionId: 1, protocolId: 0, length: 6, unitId: 1 };
            const request: ModbusRequest = { header, functionCode: 0x06, data };

            const result = handleWriteSingleRegister(request, store);

            // Must be a response, not an exception
            expect(result.type).toBe('response');
            expect(result.pdu).toBeDefined();

            const pdu = result.pdu!;

            // PDU is exactly 5 bytes: FC (1) + address (2) + value (2)
            expect(pdu.length).toBe(5);

            // First byte is function code 0x06
            expect(pdu[0]).toBe(0x06);

            // Bytes 1-2 echo the address in big-endian
            expect(pdu.readUInt16BE(1)).toBe(address);

            // Bytes 3-4 echo the value in big-endian
            expect(pdu.readUInt16BE(3)).toBe(value);

            // The response PDU should be a byte-for-byte echo of the request PDU
            const expectedPdu = Buffer.alloc(5);
            expectedPdu.writeUInt8(0x06, 0);
            expectedPdu.writeUInt16BE(address, 1);
            expectedPdu.writeUInt16BE(value, 3);
            expect(pdu).toEqual(expectedPdu);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: modbus-fault-sim, Property 8: FC 06 Float32 Rejection
  // **Validates: Requirements 2.3, 10.4**
  describe('Property 8: FC 06 Float32 Rejection', () => {
    it('FC 06 targeting base address of a float32 register returns exception code 0x02', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 65534 }),   // base address (max 65534 so +1 fits in uint16)
          fc.integer({ min: 0, max: 65535 }),   // value (irrelevant, but varied)
          (baseAddress, value) => {
            // Create a store with a float32 register at baseAddress
            const descriptors: RegisterDescriptor[] = [{
              name: 'floatReg',
              address: baseAddress,
              type: 'float32',
              initialValue: 3.14,
            }];
            const store = new RegisterStore(descriptors, () => 0);

            // FC 06 targeting the base address
            const data = Buffer.alloc(4);
            data.writeUInt16BE(baseAddress, 0);
            data.writeUInt16BE(value, 2);
            const header: MbapHeader = { transactionId: 1, protocolId: 0, length: 6, unitId: 1 };
            const request: ModbusRequest = { header, functionCode: 0x06, data };

            const result = handleWriteSingleRegister(request, store);

            // Must be an exception
            expect(result.type).toBe('exception');
            expect(result.pdu).toBeDefined();
            expect(result.pdu!.length).toBe(2);

            // Exception: function code 0x86 (0x06 | 0x80)
            expect(result.pdu![0]).toBe(0x86);

            // Exception code 0x02 (Illegal Data Address)
            expect(result.pdu![1]).toBe(0x02);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('FC 06 targeting second word (base+1) of a float32 register returns exception code 0x02', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 65534 }),   // base address
          fc.integer({ min: 0, max: 65535 }),   // value (irrelevant)
          (baseAddress, value) => {
            // Create a store with a float32 register at baseAddress
            const descriptors: RegisterDescriptor[] = [{
              name: 'floatReg',
              address: baseAddress,
              type: 'float32',
              initialValue: 2.5,
            }];
            const store = new RegisterStore(descriptors, () => 0);

            // FC 06 targeting baseAddress + 1 (the second word of the float32)
            const secondWord = baseAddress + 1;
            const data = Buffer.alloc(4);
            data.writeUInt16BE(secondWord, 0);
            data.writeUInt16BE(value, 2);
            const header: MbapHeader = { transactionId: 1, protocolId: 0, length: 6, unitId: 1 };
            const request: ModbusRequest = { header, functionCode: 0x06, data };

            const result = handleWriteSingleRegister(request, store);

            // Must be an exception
            expect(result.type).toBe('exception');
            expect(result.pdu).toBeDefined();
            expect(result.pdu!.length).toBe(2);

            // Exception: function code 0x86 (0x06 | 0x80)
            expect(result.pdu![0]).toBe(0x86);

            // Exception code 0x02 (Illegal Data Address)
            expect(result.pdu![1]).toBe(0x02);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: modbus-fault-sim, Property 13: Invalid Address Exception
  // **Validates: Requirements 6.3**
  describe('Property 13: Invalid Address Exception', () => {
    it('FC 06 targeting a non-existent address returns exception with FC|0x80 and code 0x02', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),     // store start address
          fc.integer({ min: 1, max: 50 }),      // store register count
          fc.integer({ min: 0, max: 65535 }),   // target address (will filter to invalid)
          fc.integer({ min: 0, max: 65535 }),   // value (irrelevant)
          (storeStart, storeCount, targetAddress, value) => {
            // Pre-condition: target address must NOT be in the store range
            if (targetAddress >= storeStart && targetAddress < storeStart + storeCount) {
              return; // Skip: address is valid, not what we want to test
            }

            // Create a store with uint16 registers in [storeStart, storeStart + storeCount - 1]
            const descriptors: RegisterDescriptor[] = [];
            for (let i = 0; i < storeCount; i++) {
              descriptors.push({
                name: `reg${i}`,
                address: storeStart + i,
                type: 'uint16',
                initialValue: i * 10,
              });
            }
            const store = new RegisterStore(descriptors, () => 0);

            // Build FC 06 request targeting the non-existent address
            const data = Buffer.alloc(4);
            data.writeUInt16BE(targetAddress, 0);
            data.writeUInt16BE(value, 2);
            const header: MbapHeader = { transactionId: 1, protocolId: 0, length: 6, unitId: 1 };
            const request: ModbusRequest = { header, functionCode: 0x06, data };

            const result = handleWriteSingleRegister(request, store);

            // Must be an exception
            expect(result.type).toBe('exception');
            expect(result.pdu).toBeDefined();
            expect(result.pdu!.length).toBe(2);

            // Exception: function code OR'd with 0x80 → 0x06 | 0x80 = 0x86
            expect(result.pdu![0]).toBe(0x86);

            // Exception code 0x02 (Illegal Data Address)
            expect(result.pdu![1]).toBe(0x02);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
