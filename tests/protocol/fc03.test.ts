/**
 * Tests for FC 03 (Read Holding Registers) handler.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { handleReadHoldingRegisters, type RouteResult } from '../../src/protocol/handlers/fc03.js';
import { RegisterStore, type RegisterDescriptor } from '../../src/signals/register-store.js';
import type { ModbusRequest, MbapHeader } from '../../src/protocol/frame-parser.js';

/** Helper to create a ModbusRequest for FC 03 with given start address and quantity. */
function makeRequest(startAddress: number, quantity: number): ModbusRequest {
  const data = Buffer.alloc(4);
  data.writeUInt16BE(startAddress, 0);
  data.writeUInt16BE(quantity, 2);

  const header: MbapHeader = {
    transactionId: 1,
    protocolId: 0,
    length: 6,
    unitId: 1,
  };

  return { header, functionCode: 0x03, data };
}

/** Helper to create a RegisterStore with sequential uint16 registers. */
function makeStore(startAddress: number, count: number, values?: number[]): RegisterStore {
  const descriptors: RegisterDescriptor[] = [];
  for (let i = 0; i < count; i++) {
    descriptors.push({
      name: `reg${i}`,
      address: startAddress + i,
      type: 'uint16',
      initialValue: values ? values[i] : (i + 1) * 10,
    });
  }
  return new RegisterStore(descriptors, () => 0);
}

describe('handleReadHoldingRegisters', () => {
  describe('successful reads', () => {
    it('reads a single register', () => {
      const store = makeStore(0, 1, [42]);
      const request = makeRequest(0, 1);

      const result = handleReadHoldingRegisters(request, store);

      expect(result.type).toBe('response');
      // PDU: 0x03, byteCount=2, value=42 as uint16 BE
      expect(result.pdu).toEqual(Buffer.from([0x03, 0x02, 0x00, 0x2A]));
    });

    it('reads multiple registers', () => {
      const store = makeStore(100, 4, [10, 20, 30, 40]);
      const request = makeRequest(100, 4);

      const result = handleReadHoldingRegisters(request, store);

      expect(result.type).toBe('response');
      // PDU: 0x03, byteCount=8, values 10, 20, 30, 40
      expect(result.pdu).toEqual(Buffer.from([
        0x03, 0x08,
        0x00, 0x0A,
        0x00, 0x14,
        0x00, 0x1E,
        0x00, 0x28,
      ]));
    });

    it('reads the maximum quantity of 125 registers', () => {
      const store = makeStore(0, 125);
      const request = makeRequest(0, 125);

      const result = handleReadHoldingRegisters(request, store);

      expect(result.type).toBe('response');
      expect(result.pdu![0]).toBe(0x03);
      expect(result.pdu![1]).toBe(250); // byte count = 2 * 125
      expect(result.pdu!.length).toBe(2 + 250); // FC + byteCount + data
    });
  });

  describe('quantity validation', () => {
    it('returns exception 0x03 when quantity is 0', () => {
      const store = makeStore(0, 10);
      const request = makeRequest(0, 0);

      const result = handleReadHoldingRegisters(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x83, 0x03]));
    });

    it('returns exception 0x03 when quantity exceeds 125', () => {
      const store = makeStore(0, 200);
      const request = makeRequest(0, 126);

      const result = handleReadHoldingRegisters(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x83, 0x03]));
    });
  });

  describe('address validation', () => {
    it('returns exception 0x02 when start address is out of range', () => {
      const store = makeStore(0, 10);
      const request = makeRequest(100, 1);

      const result = handleReadHoldingRegisters(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x83, 0x02]));
    });

    it('returns exception 0x02 when address range extends beyond store', () => {
      const store = makeStore(0, 5);
      const request = makeRequest(3, 5); // addresses 3-7, but store only has 0-4

      const result = handleReadHoldingRegisters(request, store);

      expect(result.type).toBe('exception');
      expect(result.pdu).toEqual(Buffer.from([0x83, 0x02]));
    });
  });
});


// Feature: modbus-fault-sim, Property 4: FC 03 Response Structure
// **Validates: Requirements 1.1, 1.2**
describe('FC 03 property tests', () => {
  describe('Property 4: FC 03 Response Structure', () => {
    it('valid request returns PDU with FC 0x03, byte count = 2 × quantity, and correct register data', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 400 }),     // startAddress
          fc.integer({ min: 1, max: 125 }),     // quantity in [1, 125]
          fc.array(fc.integer({ min: 0, max: 65535 }), { minLength: 1, maxLength: 125 }),
          (startAddress, quantity, rawValues) => {
            // Ensure we have enough values for the requested quantity
            const count = Math.min(quantity, rawValues.length);
            const actualQuantity = count;
            const values = rawValues.slice(0, actualQuantity);

            // Create a store with exactly the registers needed
            const descriptors: RegisterDescriptor[] = values.map((v, i) => ({
              name: `reg${i}`,
              address: startAddress + i,
              type: 'uint16' as const,
              initialValue: v,
            }));
            const store = new RegisterStore(descriptors, () => 0);

            // Build the request
            const data = Buffer.alloc(4);
            data.writeUInt16BE(startAddress, 0);
            data.writeUInt16BE(actualQuantity, 2);
            const header: MbapHeader = { transactionId: 1, protocolId: 0, length: 6, unitId: 1 };
            const request: ModbusRequest = { header, functionCode: 0x03, data };

            const result = handleReadHoldingRegisters(request, store);

            // Must be a response
            expect(result.type).toBe('response');
            expect(result.pdu).toBeDefined();

            const pdu = result.pdu!;

            // First byte is function code 0x03
            expect(pdu[0]).toBe(0x03);

            // Second byte is byte count = 2 × quantity
            const expectedByteCount = actualQuantity * 2;
            expect(pdu[1]).toBe(expectedByteCount);

            // PDU length = 2 (FC + byteCount) + byteCount
            expect(pdu.length).toBe(2 + expectedByteCount);

            // Register data matches initial values in big-endian
            for (let i = 0; i < actualQuantity; i++) {
              const word = pdu.readUInt16BE(2 + i * 2);
              expect(word).toBe(values[i] & 0xFFFF);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: modbus-fault-sim, Property 5: FC 03 Quantity Validation
  // **Validates: Requirements 1.2**
  describe('Property 5: FC 03 Quantity Validation', () => {
    it('quantity outside [1, 125] returns exception with FC 0x83 and code 0x03', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(0),                           // quantity = 0
            fc.integer({ min: 126, max: 65535 })      // quantity > 125
          ),
          fc.integer({ min: 0, max: 100 }),           // startAddress (irrelevant, but valid store)
          (invalidQuantity, startAddress) => {
            // Create a store large enough that address validation is not the issue
            const descriptors: RegisterDescriptor[] = [];
            for (let i = 0; i < 200; i++) {
              descriptors.push({
                name: `reg${i}`,
                address: startAddress + i,
                type: 'uint16',
                initialValue: i,
              });
            }
            const store = new RegisterStore(descriptors, () => 0);

            // Build request with invalid quantity
            const data = Buffer.alloc(4);
            data.writeUInt16BE(startAddress, 0);
            data.writeUInt16BE(invalidQuantity, 2);
            const header: MbapHeader = { transactionId: 1, protocolId: 0, length: 6, unitId: 1 };
            const request: ModbusRequest = { header, functionCode: 0x03, data };

            const result = handleReadHoldingRegisters(request, store);

            // Must be an exception
            expect(result.type).toBe('exception');
            expect(result.pdu).toBeDefined();
            expect(result.pdu!.length).toBe(2);

            // Exception: function code 0x83 (0x03 | 0x80)
            expect(result.pdu![0]).toBe(0x83);

            // Exception code 0x03 (Illegal Data Value)
            expect(result.pdu![1]).toBe(0x03);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: modbus-fault-sim, Property 14: Multi-Register Range Validation
  // **Validates: Requirements 6.2**
  describe('Property 14: Multi-Register Range Validation', () => {
    it('request where any address in [startAddress, startAddress + quantity - 1] falls outside register map returns exception code 0x02', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 200 }),   // storeStart
          fc.integer({ min: 1, max: 50 }),    // storeCount (number of registers in store)
          fc.integer({ min: 1, max: 125 }),   // quantity
          fc.boolean(),                        // whether to overflow at end or start before
          (storeStart, storeCount, quantity, overflowEnd) => {
            // Create a contiguous store [storeStart, storeStart + storeCount - 1]
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

            let requestStart: number;
            if (overflowEnd) {
              // Request that extends beyond the end of the store
              // startAddress is within the store but startAddress + quantity - 1 exceeds store range
              // Ensure at least the start is in range but end is out
              const maxValidStart = storeStart + storeCount - 1;
              // We need startAddress + quantity - 1 > storeStart + storeCount - 1
              // i.e., startAddress > storeStart + storeCount - quantity
              const minStart = Math.max(storeStart, storeStart + storeCount - quantity + 1);
              if (minStart > maxValidStart) {
                // quantity > storeCount, just use storeStart (the entire range overflows)
                requestStart = storeStart;
              } else {
                requestStart = maxValidStart; // start at last valid address
              }
              // If the request fits entirely in the store, skip this case
              if (requestStart + quantity - 1 < storeStart + storeCount) {
                // Force overflow by requesting beyond store
                requestStart = storeStart + storeCount - quantity + 1;
                if (requestStart < 0) requestStart = 0;
                // Still check if it's in bounds
                if (requestStart + quantity - 1 < storeStart + storeCount) {
                  return; // Skip: can't create valid overflow scenario with these params
                }
              }
            } else {
              // Request starts before the store's range
              if (storeStart === 0) {
                // Can't go before address 0, use overflow-end strategy
                requestStart = storeStart + storeCount; // entirely outside
              } else {
                // Start before the store, e.g., storeStart - 1
                requestStart = Math.max(0, storeStart - 1);
                // Check quantity is valid [1, 125] and at least one address is out
                if (requestStart >= storeStart) {
                  return; // Skip: couldn't place it before store
                }
              }
            }

            // Ensure the quantity fits in uint16 and is valid for this test
            if (quantity < 1 || quantity > 125) return;
            if (requestStart > 65535) return;
            if (requestStart + quantity - 1 > 65535) return;

            // Verify at least one address in [requestStart, requestStart + quantity - 1] is outside store
            let hasOutOfRange = false;
            for (let i = 0; i < quantity; i++) {
              const addr = requestStart + i;
              if (addr < storeStart || addr >= storeStart + storeCount) {
                hasOutOfRange = true;
                break;
              }
            }
            if (!hasOutOfRange) return; // Pre-condition not met, skip

            // Build request
            const data = Buffer.alloc(4);
            data.writeUInt16BE(requestStart, 0);
            data.writeUInt16BE(quantity, 2);
            const header: MbapHeader = { transactionId: 1, protocolId: 0, length: 6, unitId: 1 };
            const request: ModbusRequest = { header, functionCode: 0x03, data };

            const result = handleReadHoldingRegisters(request, store);

            // Must be an exception with code 0x02 (Illegal Data Address)
            expect(result.type).toBe('exception');
            expect(result.pdu).toBeDefined();
            expect(result.pdu![0]).toBe(0x83);
            expect(result.pdu![1]).toBe(0x02);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
