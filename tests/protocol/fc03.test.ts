/**
 * Tests for FC 03 (Read Holding Registers) handler.
 */

import { describe, it, expect } from 'vitest';
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
