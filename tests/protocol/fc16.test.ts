/**
 * Tests for FC 16 (Write Multiple Registers) handler.
 */

import { describe, it, expect } from 'vitest';
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
