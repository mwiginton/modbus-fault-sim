/**
 * Modbus TCP frame parser.
 *
 * Accumulates TCP data into complete Modbus TCP frames using the MBAP length
 * field. Handles stream fragmentation (partial frames) and frame coalescence
 * (multiple frames in one TCP segment).
 */

export interface MbapHeader {
  transactionId: number;   // uint16
  protocolId: number;      // uint16, must be 0x0000
  length: number;          // uint16, bytes after this field (unit ID + PDU)
  unitId: number;          // uint8
}

export interface ModbusRequest {
  header: MbapHeader;
  functionCode: number;    // uint8
  data: Buffer;            // PDU payload after function code
}

/** Result from attempting to extract a frame from the buffer. */
type ExtractResult =
  | { status: 'incomplete' }
  | { status: 'discard'; bytesConsumed: number }
  | { status: 'close'; bytesConsumed: number }
  | { status: 'ok'; request: ModbusRequest; bytesConsumed: number };

/** MBAP header length in bytes. */
const MBAP_HEADER_LENGTH = 7;

/** Minimum PDU length (at least the function code byte). */
const MIN_PDU_LENGTH = 1;

/**
 * Stateful parser that buffers incomplete frames from a TCP stream.
 *
 * Usage:
 *   const parser = new FrameParser();
 *   socket.on('data', (chunk) => {
 *     const requests = parser.feed(chunk);
 *     for (const req of requests) { ... }
 *   });
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;

  /**
   * Feed raw bytes from the TCP stream. Returns zero or more complete,
   * validated Modbus requests extracted from the accumulated buffer.
   *
   * Frames with protocol ID != 0x0000 are silently discarded.
   * Frames with PDU length < 1 byte signal a close condition (returned
   * as an empty array, but the `shouldClose` flag is set).
   */
  feed(data: Buffer): ModbusRequest[] {
    if (this.closed) {
      return [];
    }

    this.buffer = Buffer.concat([this.buffer, data]);

    const requests: ModbusRequest[] = [];

    while (true) {
      const result = this.tryExtractFrame();

      if (result.status === 'incomplete') {
        break;
      }

      if (result.status === 'discard') {
        this.consume(result.bytesConsumed);
        continue;
      }

      if (result.status === 'close') {
        this.consume(result.bytesConsumed);
        this.closed = true;
        break;
      }

      // status === 'ok'
      requests.push(result.request);
      this.consume(result.bytesConsumed);
    }

    return requests;
  }

  /** Whether the parser encountered a close condition (PDU < 1 byte). */
  get shouldClose(): boolean {
    return this.closed;
  }

  /** Reset internal buffer state (call on connection close/cleanup). */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.closed = false;
  }

  /**
   * Attempt to extract one complete frame from the front of the buffer.
   */
  private tryExtractFrame(): ExtractResult {
    // Need at least the MBAP header to determine frame length
    if (this.buffer.length < MBAP_HEADER_LENGTH) {
      return { status: 'incomplete' };
    }

    // Parse MBAP header fields
    const transactionId = this.buffer.readUInt16BE(0);
    const protocolId = this.buffer.readUInt16BE(2);
    const length = this.buffer.readUInt16BE(4);
    const unitId = this.buffer.readUInt8(6);

    // Total frame size = MBAP header (6 bytes before length field) + length
    // The length field counts bytes after itself: unit ID (1) + PDU
    const totalFrameLength = 6 + length;

    // Wait for the complete frame to arrive
    if (this.buffer.length < totalFrameLength) {
      return { status: 'incomplete' };
    }

    // Validate protocol ID — must be 0x0000 for Modbus TCP
    if (protocolId !== 0x0000) {
      return { status: 'discard', bytesConsumed: totalFrameLength };
    }

    // PDU length = length field - 1 (unit ID byte)
    const pduLength = length - 1;

    // PDU must contain at least the function code byte
    if (pduLength < MIN_PDU_LENGTH) {
      return { status: 'close', bytesConsumed: totalFrameLength };
    }

    // Extract function code and remaining PDU data
    const functionCode = this.buffer.readUInt8(MBAP_HEADER_LENGTH);
    const data = Buffer.alloc(pduLength - 1);
    this.buffer.copy(data, 0, MBAP_HEADER_LENGTH + 1, MBAP_HEADER_LENGTH + pduLength);

    const header: MbapHeader = {
      transactionId,
      protocolId,
      length,
      unitId,
    };

    const request: ModbusRequest = {
      header,
      functionCode,
      data,
    };

    return { status: 'ok', request, bytesConsumed: totalFrameLength };
  }

  /** Remove the first N bytes from the internal buffer. */
  private consume(bytes: number): void {
    this.buffer = this.buffer.subarray(bytes);
  }
}
