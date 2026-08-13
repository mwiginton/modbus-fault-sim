/**
 * Tests for FC 06 (Write Single Register) handler.
 */

import { describe, it, expect } from 'vitest';
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
