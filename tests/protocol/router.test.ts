import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { route, type Device } from '../../src/protocol/router.js';
import { RegisterStore } from '../../src/signals/register-store.js';
import type { ModbusRequest, MbapHeader } from '../../src/protocol/frame-parser.js';
import { buildException } from '../../src/protocol/frame-builder.js';

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


// Feature: modbus-fault-sim, Property 3: Unknown Unit ID Discards
// **Validates: Requirements 1.3**
describe('Router property tests', () => {
  describe('Property 3: Unknown Unit ID Discards', () => {
    it('any request with a unit ID not in the device map returns discard with no PDU', () => {
      fc.assert(
        fc.property(
          // Generate a set of known unit IDs for the device map (1–5 devices)
          fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 5 }),
          // Generate a unit ID for the request
          fc.integer({ min: 0, max: 255 }),
          // Generate a valid function code (doesn't matter — unit ID check happens first)
          fc.integer({ min: 0, max: 255 }),
          // Generate arbitrary transaction ID
          fc.integer({ min: 0, max: 65535 }),
          (knownUnitIds, requestUnitId, functionCode, transactionId) => {
            // Pre-condition: the request unit ID must NOT be in the device map
            const unitIdSet = new Set(knownUnitIds);
            fc.pre(!unitIdSet.has(requestUnitId));

            // Build the device map with known unit IDs
            const devices = new Map<number, Device>();
            for (const uid of knownUnitIds) {
              const store = new RegisterStore(
                [{ name: 'reg0', address: 0, type: 'uint16', initialValue: 0 }],
                () => 0,
              );
              devices.set(uid, { unitId: uid, store });
            }

            // Build a valid request with the unknown unit ID
            const header: MbapHeader = {
              transactionId,
              protocolId: 0x0000, // valid protocol ID
              length: 6,         // valid PDU length (unit ID + FC + 4 data bytes)
              unitId: requestUnitId,
            };
            const request: ModbusRequest = {
              header,
              functionCode,
              data: Buffer.from([0x00, 0x00, 0x00, 0x01]),
            };

            const result = route(request, devices);

            // Must be a discard with no response bytes
            expect(result.type).toBe('discard');
            expect(result.pdu).toBeUndefined();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('example: unit ID 99 not in map with single device at unit ID 1', () => {
      const devices = new Map<number, Device>();
      const store = new RegisterStore(
        [{ name: 'reg0', address: 0, type: 'uint16', initialValue: 42 }],
        () => 0,
      );
      devices.set(1, { unitId: 1, store });

      const header: MbapHeader = {
        transactionId: 100,
        protocolId: 0x0000,
        length: 6,
        unitId: 99,
      };
      const request: ModbusRequest = {
        header,
        functionCode: 0x03,
        data: Buffer.from([0x00, 0x00, 0x00, 0x01]),
      };

      const result = route(request, devices);
      expect(result.type).toBe('discard');
      expect(result.pdu).toBeUndefined();
    });

    it('example: empty device map always discards', () => {
      const devices = new Map<number, Device>();

      const header: MbapHeader = {
        transactionId: 1,
        protocolId: 0x0000,
        length: 6,
        unitId: 1,
      };
      const request: ModbusRequest = {
        header,
        functionCode: 0x03,
        data: Buffer.from([0x00, 0x00, 0x00, 0x01]),
      };

      const result = route(request, devices);
      expect(result.type).toBe('discard');
      expect(result.pdu).toBeUndefined();
    });
  });

  // Feature: modbus-fault-sim, Property 12: Unsupported Function Code Exception
  // **Validates: Requirements 5.1**
  describe('Property 12: Unsupported Function Code Exception', () => {
    it('any request with FC not in {0x03, 0x06, 0x10} returns exception with FC|0x80 and code 0x01', () => {
      const supportedFCs = new Set([0x03, 0x06, 0x10]);

      fc.assert(
        fc.property(
          // Generate an unsupported function code (uint8, excluding 0x03, 0x06, 0x10)
          fc.integer({ min: 0, max: 255 }),
          // Generate a valid unit ID that will be in the device map
          fc.integer({ min: 0, max: 255 }),
          // Generate arbitrary transaction ID
          fc.integer({ min: 0, max: 65535 }),
          (functionCode, unitId, transactionId) => {
            // Pre-condition: function code must be unsupported
            fc.pre(!supportedFCs.has(functionCode));

            // Build a device map containing the target unit ID
            const devices = new Map<number, Device>();
            const store = new RegisterStore(
              [{ name: 'reg0', address: 0, type: 'uint16', initialValue: 0 }],
              () => 0,
            );
            devices.set(unitId, { unitId, store });

            // Build request with valid protocol ID, valid length, known unit ID, unsupported FC
            const header: MbapHeader = {
              transactionId,
              protocolId: 0x0000,
              length: 6,
              unitId,
            };
            const request: ModbusRequest = {
              header,
              functionCode,
              data: Buffer.from([0x00, 0x00, 0x00, 0x01]),
            };

            const result = route(request, devices);

            // Must be an exception
            expect(result.type).toBe('exception');
            expect(result.pdu).toBeDefined();
            expect(result.pdu!.length).toBe(2);

            // PDU byte 0: function code OR'd with 0x80
            expect(result.pdu![0]).toBe((functionCode | 0x80) & 0xFF);

            // PDU byte 1: exception code 0x01 (Illegal Function)
            expect(result.pdu![1]).toBe(0x01);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('full 9-byte exception frame is produced when buildException wraps the router result', () => {
      const supportedFCs = new Set([0x03, 0x06, 0x10]);

      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 255 }),   // unsupported FC
          fc.integer({ min: 0, max: 255 }),   // unit ID
          fc.integer({ min: 0, max: 65535 }), // transaction ID
          (functionCode, unitId, transactionId) => {
            fc.pre(!supportedFCs.has(functionCode));

            const devices = new Map<number, Device>();
            const store = new RegisterStore(
              [{ name: 'reg0', address: 0, type: 'uint16', initialValue: 0 }],
              () => 0,
            );
            devices.set(unitId, { unitId, store });

            const header: MbapHeader = {
              transactionId,
              protocolId: 0x0000,
              length: 6,
              unitId,
            };
            const request: ModbusRequest = {
              header,
              functionCode,
              data: Buffer.from([0x00, 0x00, 0x00, 0x01]),
            };

            const result = route(request, devices);

            // Verify router returns exception type
            expect(result.type).toBe('exception');

            // Build the full exception frame using buildException
            const frame = buildException(
              { transactionId, unitId },
              functionCode,
              0x01,
            );

            // Full frame must be exactly 9 bytes
            expect(frame.length).toBe(9);

            // Verify MBAP header fields
            expect(frame.readUInt16BE(0)).toBe(transactionId); // Transaction ID
            expect(frame.readUInt16BE(2)).toBe(0x0000);        // Protocol ID
            expect(frame.readUInt16BE(4)).toBe(3);             // Length: unitId(1) + errorFC(1) + exCode(1)
            expect(frame.readUInt8(6)).toBe(unitId);           // Unit ID

            // Verify exception PDU in the frame
            expect(frame.readUInt8(7)).toBe((functionCode | 0x80) & 0xFF);
            expect(frame.readUInt8(8)).toBe(0x01);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('example: FC 0x01 on valid unit ID returns exception', () => {
      const devices = new Map<number, Device>();
      const store = new RegisterStore(
        [{ name: 'reg0', address: 0, type: 'uint16', initialValue: 0 }],
        () => 0,
      );
      devices.set(1, { unitId: 1, store });

      const header: MbapHeader = {
        transactionId: 1,
        protocolId: 0x0000,
        length: 6,
        unitId: 1,
      };
      const request: ModbusRequest = {
        header,
        functionCode: 0x01,
        data: Buffer.from([0x00, 0x00, 0x00, 0x01]),
      };

      const result = route(request, devices);
      expect(result.type).toBe('exception');
      expect(result.pdu![0]).toBe(0x81); // 0x01 | 0x80
      expect(result.pdu![1]).toBe(0x01);
    });

    it('example: FC 0xFF returns exception with high byte 0xFF (already has high bit set)', () => {
      const devices = new Map<number, Device>();
      const store = new RegisterStore(
        [{ name: 'reg0', address: 0, type: 'uint16', initialValue: 0 }],
        () => 0,
      );
      devices.set(5, { unitId: 5, store });

      const header: MbapHeader = {
        transactionId: 42,
        protocolId: 0x0000,
        length: 6,
        unitId: 5,
      };
      const request: ModbusRequest = {
        header,
        functionCode: 0xFF,
        data: Buffer.alloc(4),
      };

      const result = route(request, devices);
      expect(result.type).toBe('exception');
      expect(result.pdu![0]).toBe(0xFF); // 0xFF | 0x80 = 0xFF
      expect(result.pdu![1]).toBe(0x01);
    });
  });
});
