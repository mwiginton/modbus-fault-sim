import { describe, it, expect } from 'vitest';
import { route, type Device } from '../../src/protocol/router.js';
import { RegisterStore } from '../../src/signals/register-store.js';
import type { ModbusRequest } from '../../src/protocol/frame-parser.js';

/** Helper to create a minimal ModbusRequest. */
function makeRequest(overrides: {
  header?: Partial<ModbusRequest['header']>;
  functionCode?: number;
  data?: Buffer;
} = {}): ModbusRequest {
  const header = {
    transactionId: 1,
    protocolId: 0x0000,
    length: 6, // unit ID (1) + FC (1) + data (4)
    unitId: 1,
    ...overrides.header,
  };
  return {
    header,
    functionCode: overrides.functionCode ?? 0x03,
    data: overrides.data ?? Buffer.from([0x00, 0x00, 0x00, 0x01]), // read 1 register at address 0
  };
}

/** Helper to create a device map with a single device. */
function makeDevices(unitId = 1): Map<number, Device> {
  const store = new RegisterStore([
    { name: 'reg0', address: 0, type: 'uint16', initialValue: 42 },
    { name: 'reg1', address: 1, type: 'uint16', initialValue: 100 },
  ]);
  const devices = new Map<number, Device>();
  devices.set(unitId, { unitId, store });
  return devices;
}

describe('router', () => {
  describe('protocol ID check (Req 4.5)', () => {
    it('discards request when protocol ID is not 0x0000', () => {
      const request = makeRequest({ header: { protocolId: 0x0001 } });
      const devices = makeDevices();
      const result = route(request, devices);
      expect(result.type).toBe('discard');
      expect(result.pdu).toBeUndefined();
    });
  });

  describe('PDU length check (Req 5.2)', () => {
    it('returns close when header.length < 2 (no PDU)', () => {
      const request = makeRequest({ header: { length: 1 } });
      const devices = makeDevices();
      const result = route(request, devices);
      expect(result.type).toBe('close');
    });

    it('returns close when header.length is 0', () => {
      const request = makeRequest({ header: { length: 0 } });
      const devices = makeDevices();
      const result = route(request, devices);
      expect(result.type).toBe('close');
    });
  });

  describe('unit ID check (Req 1.3)', () => {
    it('discards request when unit ID is not in device map', () => {
      const request = makeRequest({ header: { unitId: 99 } });
      const devices = makeDevices(1);
      const result = route(request, devices);
      expect(result.type).toBe('discard');
      expect(result.pdu).toBeUndefined();
    });

    it('discards request when device map is empty', () => {
      const request = makeRequest();
      const devices = new Map<number, Device>();
      const result = route(request, devices);
      expect(result.type).toBe('discard');
    });
  });

  describe('unsupported function code (Req 5.1)', () => {
    it('returns exception 01 for unsupported FC', () => {
      const request = makeRequest({ functionCode: 0x08 });
      const devices = makeDevices();
      const result = route(request, devices);
      expect(result.type).toBe('exception');
      expect(result.pdu).toBeDefined();
      expect(result.pdu![0]).toBe(0x08 | 0x80); // FC with high bit set
      expect(result.pdu![1]).toBe(0x01);         // Illegal Function
    });

    it('returns exception 01 for FC 01 (Read Coils, not supported)', () => {
      const request = makeRequest({ functionCode: 0x01 });
      const devices = makeDevices();
      const result = route(request, devices);
      expect(result.type).toBe('exception');
      expect(result.pdu![0]).toBe(0x81);
      expect(result.pdu![1]).toBe(0x01);
    });
  });

  describe('valid dispatch', () => {
    it('dispatches FC 03 to Read Holding Registers handler', () => {
      const request = makeRequest({
        functionCode: 0x03,
        data: Buffer.from([0x00, 0x00, 0x00, 0x01]), // address 0, quantity 1
      });
      const devices = makeDevices();
      const result = route(request, devices);
      expect(result.type).toBe('response');
      expect(result.pdu).toBeDefined();
      expect(result.pdu![0]).toBe(0x03); // FC 03 response
    });

    it('dispatches FC 06 to Write Single Register handler', () => {
      const request = makeRequest({
        functionCode: 0x06,
        data: Buffer.from([0x00, 0x00, 0x00, 0x07]), // address 0, value 7
      });
      const devices = makeDevices();
      const result = route(request, devices);
      expect(result.type).toBe('response');
      expect(result.pdu).toBeDefined();
      expect(result.pdu![0]).toBe(0x06); // FC 06 response
    });

    it('dispatches FC 16 to Write Multiple Registers handler', () => {
      const request = makeRequest({
        functionCode: 0x10,
        data: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x02, 0x00, 0x0A]), // address 0, qty 1, byteCount 2, value 10
      });
      const devices = makeDevices();
      const result = route(request, devices);
      expect(result.type).toBe('response');
      expect(result.pdu).toBeDefined();
      expect(result.pdu![0]).toBe(0x10); // FC 16 response
    });
  });

  describe('rule priority', () => {
    it('checks protocol ID before unit ID', () => {
      // Unit ID is valid but protocol ID is wrong
      const request = makeRequest({ header: { protocolId: 0x0001, unitId: 1 } });
      const devices = makeDevices();
      const result = route(request, devices);
      expect(result.type).toBe('discard');
    });

    it('checks PDU length before unit ID lookup', () => {
      // Unit ID doesn't exist but PDU length is invalid — should close, not discard
      const request = makeRequest({ header: { length: 1, unitId: 99 } });
      const devices = makeDevices();
      const result = route(request, devices);
      expect(result.type).toBe('close');
    });
  });
});
