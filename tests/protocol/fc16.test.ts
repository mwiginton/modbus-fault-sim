/**
 * Tests for FC 16 (Write Multiple Registers) handler.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { handleWriteMultipleRegisters } from '../../src/protocol/handlers/fc16.js';
import { RegisterStore, type RegisterDescriptor } from '../../src/signals/register-store.js';
import type { ModbusRequest, MbapHeader } from '../../src/protocol/frame-parser.js';

/** Helper to create an FC 16 request with given start address, quantity, byte count, and values. */
function makeRequest(
  startAddress: number,
  quantity: number,
  byteCount: number,
  values: number[],
): ModbusRequest {
  // PDU data: start address (2) + quantity (2) + byte count (1) + values (2 × N)
  const data = Buffer.alloc(5 + values.length * 2);
  data.writeUInt16BE(startAddress, 0);
  data.writeUInt16BE(quantity, 2);
  data.writeUInt8(byteCount, 4);
  for (let i = 0; i < values.length; i++) {
    data.writeUInt16BE(values[i], 5 + i * 2);
  }

  const header: MbapHeader = {
    transactionId: 1,
    protocolId: 0,
    length: 6 + 5 + values.length * 2, // unit ID + FC + data
    unitId: 1,
  };

  return { header, functionCode: 0x10, data };
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

describe('handleWriteMultipleRegisters', () => {
  describe('successful writes', () => {
    it('writes values and returns response with echoed address and quantity', () => {
      const store = makeStore(0, 5);
      const request = makeRequest(0, 3, 6, [10, 20, 30]);

      const result = handleWriteMultipleRegisters(request, store);

      expect(result.type).toBe('response');
      // Response PDU: 0x10 + startAddress (2) + quantity (2) = 5 bytes
      expect(result.pdu).toEqual(Buffer.from([0x10, 0x00, 0x00, 0x00, 0x03]));
    });

    it('persists written values in the store', () => {
      const store = makeStore(10, 4);
      const request = makeRequest(10, 4, 8, [100, 200, 300, 400]);

      handleWriteMultipleRegisters(request, store);

      const readResult = store.readRegisters(10, 4);
      expect(readResult).toEqual([100, 200, 300, 400]);
    });

    it('handles single register write (quantity = 1)', () => {
      const store = makeStore(50, 3);
      const request = makeRequest(51, 1, 2, [999]);

      const result = handleWriteMultipleRegisters(request, store);

      expect(result.type).toBe('response');
      expect(result.pdu).toEqual(Buffer.from([0x10, 0x00, 0x33, 0x00, 0x01]));
    });

    it('handles maximum valid quantity (123 registers)', () => {
      const store = makeStore(0, 123);
      const values = Array.from({ length: 123 }, (_, i) => i);
      const request = makeRequest(0, 123, 246, values);

      const result = handleWriteMultipleRegisters(request, store);

      expect(result.type).toBe('response');
      expect(result.pdu![0]).toBe(0x10);
      expect(result.pdu!.readUInt16BE(1)).toBe(0);
      expect(result.pdu!.readUInt16BE(3)).toBe(123);
    });
  });

  describe('quantity validation', () => {
    it('returns exception 0x03 when quantity is 0', () => {
      const store = makeStore(0, 5);
      const request = makeRequest(0, 0, 0, []);

      const result = handleWriteMultipleRegisters(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x90, 0x03]));
    });

    it('returns exception 0x03 when quantity exceeds 123', () => {
      const store = makeStore(0, 200);
      const values = Array.from({ length: 124 }, (_, i) => i);
      const request = makeRequest(0, 124, 248, values);

      const result = handleWriteMultipleRegisters(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x90, 0x03]));
    });
  });

  describe('byte count validation', () => {
    it('returns exception 0x03 when byte count does not equal 2 × quantity', () => {
      const store = makeStore(0, 5);
      // quantity = 3 but byte count = 4 (should be 6)
      const request = makeRequest(0, 3, 4, [10, 20, 30]);

      const result = handleWriteMultipleRegisters(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x90, 0x03]));
    });

    it('returns exception 0x03 when byte count is too large', () => {
      const store = makeStore(0, 5);
      // quantity = 2 but byte count = 6 (should be 4)
      const request = makeRequest(0, 2, 6, [10, 20]);

      const result = handleWriteMultipleRegisters(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x90, 0x03]));
    });
  });

  describe('address range validation', () => {
    it('returns exception 0x02 when start address is out of range', () => {
      const store = makeStore(0, 5);
      const request = makeRequest(10, 2, 4, [1, 2]);

      const result = handleWriteMultipleRegisters(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x90, 0x02]));
    });

    it('returns exception 0x02 when range extends beyond register map', () => {
      const store = makeStore(0, 5);
      // Start at 3, quantity 3 → addresses 3, 4, 5 but store only has 0-4
      const request = makeRequest(3, 3, 6, [1, 2, 3]);

      const result = handleWriteMultipleRegisters(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x90, 0x02]));
    });
  });
});


// Feature: modbus-fault-sim, Property 9: FC 16 Response Structure
// **Validates: Requirements 3.1**
describe('FC 16 property tests', () => {
  describe('Property 9: FC 16 Response Structure', () => {
    it('valid FC 16 request returns PDU with FC 0x10, echoed start address, and echoed quantity', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 65535 }),           // startAddress
          fc.integer({ min: 1, max: 123 }),             // quantity in [1, 123]
          fc.array(fc.integer({ min: 0, max: 65535 }), { minLength: 123, maxLength: 123 }),
          (startAddress, quantity, rawValues) => {
            const values = rawValues.slice(0, quantity);
            const byteCount = quantity * 2;

            // Create a store with uint16 registers covering the requested range
            const descriptors: RegisterDescriptor[] = [];
            for (let i = 0; i < quantity; i++) {
              descriptors.push({
                name: `reg${i}`,
                address: startAddress + i,
                type: 'uint16',
                initialValue: 0,
              });
            }
            const store = new RegisterStore(descriptors, () => 0);

            // Build FC 16 request
            const data = Buffer.alloc(5 + quantity * 2);
            data.writeUInt16BE(startAddress, 0);
            data.writeUInt16BE(quantity, 2);
            data.writeUInt8(byteCount, 4);
            for (let i = 0; i < quantity; i++) {
              data.writeUInt16BE(values[i], 5 + i * 2);
            }
            const header: MbapHeader = { transactionId: 1, protocolId: 0, length: 6 + data.length, unitId: 1 };
            const request: ModbusRequest = { header, functionCode: 0x10, data };

            const result = handleWriteMultipleRegisters(request, store);

            // Must be a response, not an exception
            expect(result.type).toBe('response');
            expect(result.pdu).toBeDefined();

            const pdu = result.pdu!;

            // PDU is exactly 5 bytes: FC (1) + startAddress (2) + quantity (2)
            expect(pdu.length).toBe(5);

            // First byte is function code 0x10
            expect(pdu[0]).toBe(0x10);

            // Bytes 1-2 echo the start address in big-endian
            expect(pdu.readUInt16BE(1)).toBe(startAddress);

            // Bytes 3-4 echo the quantity in big-endian
            expect(pdu.readUInt16BE(3)).toBe(quantity);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: modbus-fault-sim, Property 10: FC 16 Quantity Validation
  // **Validates: Requirements 3.2**
  describe('Property 10: FC 16 Quantity Validation', () => {
    it('quantity outside [1, 123] returns exception with FC 0x90 and code 0x03', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(0),                           // quantity = 0
            fc.integer({ min: 124, max: 65535 })      // quantity > 123
          ),
          fc.integer({ min: 0, max: 100 }),           // startAddress (irrelevant for this check)
          (invalidQuantity, startAddress) => {
            // Create a store large enough that address validation is not the issue
            const descriptors: RegisterDescriptor[] = [];
            for (let i = 0; i < 200; i++) {
              descriptors.push({
                name: `reg${i}`,
                address: startAddress + i,
                type: 'uint16',
                initialValue: 0,
              });
            }
            const store = new RegisterStore(descriptors, () => 0);

            // Build FC 16 request with invalid quantity but consistent byte count
            const byteCount = invalidQuantity * 2;
            // Cap byteCount to uint8 range for the buffer (won't affect validation since quantity check is first)
            const writtenByteCount = byteCount > 255 ? 0 : byteCount;
            const valuesCount = invalidQuantity > 123 ? 0 : invalidQuantity;

            const data = Buffer.alloc(5 + valuesCount * 2);
            data.writeUInt16BE(startAddress, 0);
            data.writeUInt16BE(invalidQuantity, 2);
            data.writeUInt8(writtenByteCount, 4);
            const header: MbapHeader = { transactionId: 1, protocolId: 0, length: 6 + data.length, unitId: 1 };
            const request: ModbusRequest = { header, functionCode: 0x10, data };

            const result = handleWriteMultipleRegisters(request, store);

            // Must be an exception
            expect(result.type).toBe('exception');
            expect(result.pdu).toBeDefined();
            expect(result.pdu!.length).toBe(2);

            // Exception: function code 0x90 (0x10 | 0x80)
            expect(result.pdu![0]).toBe(0x90);

            // Exception code 0x03 (Illegal Data Value)
            expect(result.pdu![1]).toBe(0x03);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: modbus-fault-sim, Property 11: FC 16 Byte Count Consistency
  // **Validates: Requirements 3.3**
  describe('Property 11: FC 16 Byte Count Consistency', () => {
    it('byte count != 2 × quantity returns exception with FC 0x90 and code 0x03', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 123 }),             // valid quantity
          fc.integer({ min: 0, max: 255 }),             // byteCount (will filter to inconsistent)
          fc.integer({ min: 0, max: 100 }),             // startAddress
          (quantity, byteCount, startAddress) => {
            // Pre-condition: byteCount must NOT equal 2 × quantity
            if (byteCount === quantity * 2) {
              return; // Skip: this is a consistent byte count
            }

            // Create a store large enough that address validation is not the issue
            const descriptors: RegisterDescriptor[] = [];
            for (let i = 0; i < 200; i++) {
              descriptors.push({
                name: `reg${i}`,
                address: startAddress + i,
                type: 'uint16',
                initialValue: 0,
              });
            }
            const store = new RegisterStore(descriptors, () => 0);

            // Build FC 16 request with inconsistent byte count
            // Provide enough value bytes to avoid buffer underread
            const valuesInBuffer = quantity;
            const data = Buffer.alloc(5 + valuesInBuffer * 2);
            data.writeUInt16BE(startAddress, 0);
            data.writeUInt16BE(quantity, 2);
            data.writeUInt8(byteCount, 4);
            for (let i = 0; i < valuesInBuffer; i++) {
              data.writeUInt16BE(i, 5 + i * 2);
            }
            const header: MbapHeader = { transactionId: 1, protocolId: 0, length: 6 + data.length, unitId: 1 };
            const request: ModbusRequest = { header, functionCode: 0x10, data };

            const result = handleWriteMultipleRegisters(request, store);

            // Must be an exception
            expect(result.type).toBe('exception');
            expect(result.pdu).toBeDefined();
            expect(result.pdu!.length).toBe(2);

            // Exception: function code 0x90 (0x10 | 0x80)
            expect(result.pdu![0]).toBe(0x90);

            // Exception code 0x03 (Illegal Data Value)
            expect(result.pdu![1]).toBe(0x03);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
