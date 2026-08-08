import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildResponse, buildException } from '../../src/protocol/frame-builder.js';

describe('frame-builder', () => {
  describe('buildResponse', () => {
    it('produces frame with correct MBAP header for a simple PDU', () => {
      const opts = { transactionId: 0x0001, unitId: 0x03 };
      const pdu = Buffer.from([0x03, 0x02, 0x00, 0x64]); // FC03 response: 2 bytes, value 100

      const frame = buildResponse(opts, pdu);

      // Total frame: 7 (header) + 4 (pdu) = 11 bytes
      expect(frame.length).toBe(11);
      // Transaction ID echoed
      expect(frame.readUInt16BE(0)).toBe(0x0001);
      // Protocol ID = 0x0000
      expect(frame.readUInt16BE(2)).toBe(0x0000);
      // Length = unitId(1) + pdu(4) = 5
      expect(frame.readUInt16BE(4)).toBe(5);
      // Unit ID echoed
      expect(frame.readUInt8(6)).toBe(0x03);
      // PDU copied correctly
      expect(frame.subarray(7)).toEqual(pdu);
    });

    it('echoes transaction ID exactly', () => {
      const opts = { transactionId: 0xABCD, unitId: 0x01 };
      const pdu = Buffer.from([0x03, 0x00]);

      const frame = buildResponse(opts, pdu);

      expect(frame.readUInt16BE(0)).toBe(0xABCD);
    });

    it('echoes unit ID exactly', () => {
      const opts = { transactionId: 0x0000, unitId: 0xFF };
      const pdu = Buffer.from([0x06, 0x00, 0x01, 0x00, 0x0A]);

      const frame = buildResponse(opts, pdu);

      expect(frame.readUInt8(6)).toBe(0xFF);
    });

    it('computes length field correctly for empty PDU', () => {
      const opts = { transactionId: 0x0001, unitId: 0x01 };
      const pdu = Buffer.alloc(0);

      const frame = buildResponse(opts, pdu);

      // Length = unitId(1) + pdu(0) = 1
      expect(frame.readUInt16BE(4)).toBe(1);
      expect(frame.length).toBe(7);
    });

    it('computes length field correctly for large PDU', () => {
      const opts = { transactionId: 0x0001, unitId: 0x01 };
      const pdu = Buffer.alloc(253); // max reasonable PDU

      const frame = buildResponse(opts, pdu);

      // Length = unitId(1) + pdu(253) = 254
      expect(frame.readUInt16BE(4)).toBe(254);
      expect(frame.length).toBe(7 + 253);
    });
  });

  describe('buildException', () => {
    it('produces a 9-byte exception frame', () => {
      const opts = { transactionId: 0x0005, unitId: 0x01 };

      const frame = buildException(opts, 0x03, 0x02);

      expect(frame.length).toBe(9);
    });

    it('sets correct MBAP header in exception frame', () => {
      const opts = { transactionId: 0x1234, unitId: 0x0A };

      const frame = buildException(opts, 0x03, 0x01);

      // Transaction ID
      expect(frame.readUInt16BE(0)).toBe(0x1234);
      // Protocol ID
      expect(frame.readUInt16BE(2)).toBe(0x0000);
      // Length = unitId(1) + errorFC(1) + exceptionCode(1) = 3
      expect(frame.readUInt16BE(4)).toBe(3);
      // Unit ID
      expect(frame.readUInt8(6)).toBe(0x0A);
    });

    it('ORs function code with 0x80', () => {
      const opts = { transactionId: 0x0001, unitId: 0x01 };

      const frame = buildException(opts, 0x03, 0x01);

      expect(frame.readUInt8(7)).toBe(0x83); // 0x03 | 0x80
    });

    it('sets exception code correctly', () => {
      const opts = { transactionId: 0x0001, unitId: 0x01 };

      const frame = buildException(opts, 0x06, 0x02);

      expect(frame.readUInt8(7)).toBe(0x86); // 0x06 | 0x80
      expect(frame.readUInt8(8)).toBe(0x02); // Illegal Data Address
    });

    it('handles FC 16 (0x10) exception correctly', () => {
      const opts = { transactionId: 0x0001, unitId: 0x01 };

      const frame = buildException(opts, 0x10, 0x03);

      expect(frame.readUInt8(7)).toBe(0x90); // 0x10 | 0x80
      expect(frame.readUInt8(8)).toBe(0x03); // Illegal Data Value
    });

    it('handles unsupported function code exception (code 01)', () => {
      const opts = { transactionId: 0x0001, unitId: 0x01 };

      const frame = buildException(opts, 0x05, 0x01);

      expect(frame.readUInt8(7)).toBe(0x85); // 0x05 | 0x80
      expect(frame.readUInt8(8)).toBe(0x01); // Illegal Function
    });
  });
});


// Feature: modbus-fault-sim, Property 1: MBAP Header Invariants
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
describe('frame-builder property tests', () => {
  describe('Property 1: MBAP Header Invariants', () => {
    it('buildResponse echoes transaction ID, sets protocol ID 0x0000, correct length, and echoes unit ID', () => {
      fc.assert(
        fc.property(
          fc.nat(65535),        // transactionId: 0–65535
          fc.nat(255),          // unitId: 0–255
          fc.uint8Array({ minLength: 0, maxLength: 252 }), // PDU payload
          (transactionId, unitId, pduArray) => {
            const pdu = Buffer.from(pduArray);
            const frame = buildResponse({ transactionId, unitId }, pdu);

            // Req 4.2: Transaction ID echoed from request
            expect(frame.readUInt16BE(0)).toBe(transactionId);

            // Req 4.3: Protocol ID set to 0x0000
            expect(frame.readUInt16BE(2)).toBe(0x0000);

            // Req 4.1: Length field = unit ID byte (1) + PDU length, big-endian uint16
            expect(frame.readUInt16BE(4)).toBe(1 + pdu.length);

            // Req 4.4: Unit ID echoed from request
            expect(frame.readUInt8(6)).toBe(unitId);

            // Total frame size: 7-byte MBAP header + PDU
            expect(frame.length).toBe(7 + pdu.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('buildException echoes transaction ID, sets protocol ID 0x0000, length 3, and echoes unit ID', () => {
      fc.assert(
        fc.property(
          fc.nat(65535),        // transactionId: 0–65535
          fc.nat(255),          // unitId: 0–255
          fc.nat(127),          // functionCode: 0–127 (before OR with 0x80)
          fc.nat(255),          // exceptionCode: 0–255
          (transactionId, unitId, functionCode, exceptionCode) => {
            const frame = buildException({ transactionId, unitId }, functionCode, exceptionCode);

            // Req 4.2: Transaction ID echoed from request
            expect(frame.readUInt16BE(0)).toBe(transactionId);

            // Req 4.3: Protocol ID set to 0x0000
            expect(frame.readUInt16BE(2)).toBe(0x0000);

            // Req 4.1: Length field = unit ID (1) + errorFC (1) + exceptionCode (1) = 3
            expect(frame.readUInt16BE(4)).toBe(3);

            // Req 4.4: Unit ID echoed from request
            expect(frame.readUInt8(6)).toBe(unitId);

            // Total frame is always 9 bytes for exceptions
            expect(frame.length).toBe(9);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
