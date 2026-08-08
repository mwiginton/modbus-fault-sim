/**
 * Modbus TCP frame builder.
 *
 * Constructs response and exception frames with correct MBAP headers.
 */

export interface FrameBuilderOptions {
  transactionId: number;
  unitId: number;
}

/**
 * Build a Modbus TCP response frame with correct MBAP header.
 *
 * MBAP Header (7 bytes):
 *   bytes[0..1]: Transaction ID (uint16 BE) — echoed from request
 *   bytes[2..3]: Protocol ID (uint16 BE) — always 0x0000
 *   bytes[4..5]: Length (uint16 BE) — unit ID byte + PDU length
 *   byte[6]:    Unit ID (uint8) — echoed from request
 *
 * Followed by the PDU payload.
 */
export function buildResponse(opts: FrameBuilderOptions, pdu: Buffer): Buffer {
  const length = 1 + pdu.length; // unit ID (1) + PDU
  const frame = Buffer.alloc(7 + pdu.length);

  frame.writeUInt16BE(opts.transactionId, 0); // Transaction ID
  frame.writeUInt16BE(0x0000, 2);             // Protocol ID
  frame.writeUInt16BE(length, 4);             // Length
  frame.writeUInt8(opts.unitId, 6);           // Unit ID
  pdu.copy(frame, 7);                         // PDU

  return frame;
}

/**
 * Build a 9-byte Modbus TCP exception response frame.
 *
 * Frame layout:
 *   MBAP Header (7 bytes) + function code OR'd with 0x80 (1 byte) + exception code (1 byte)
 */
export function buildException(
  opts: FrameBuilderOptions,
  functionCode: number,
  exceptionCode: number
): Buffer {
  const frame = Buffer.alloc(9);

  frame.writeUInt16BE(opts.transactionId, 0); // Transaction ID
  frame.writeUInt16BE(0x0000, 2);             // Protocol ID
  frame.writeUInt16BE(3, 4);                  // Length: unit ID (1) + error FC (1) + exception code (1)
  frame.writeUInt8(opts.unitId, 6);           // Unit ID
  frame.writeUInt8((functionCode | 0x80) & 0xFF, 7); // Function code OR'd with 0x80
  frame.writeUInt8(exceptionCode, 8);         // Exception code

  return frame;
}
