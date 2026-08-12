/**
 * FC 03 — Read Holding Registers handler.
 *
 * Parses a Read Holding Registers request, validates the quantity and address
 * range, reads values from the register store, and returns a response PDU
 * or an exception PDU.
 */

import type { ModbusRequest } from '../frame-parser.js';
import { RegisterStore, ErrorCode } from '../../signals/register-store.js';

/** Result from a function-code handler. */
export interface RouteResult {
  type: 'response' | 'exception' | 'discard' | 'close';
  pdu?: Buffer;
}

/** FC 03 function code constant. */
const FC_READ_HOLDING_REGISTERS = 0x03;

/** Maximum quantity of registers allowed per FC 03 request. */
const MAX_QUANTITY = 125;

/**
 * Handle a Read Holding Registers (FC 03) request.
 *
 * @param request - Parsed Modbus request with function code 0x03
 * @param store - The register store for the addressed device
 * @returns A RouteResult with response PDU on success or exception PDU on error
 */
export function handleReadHoldingRegisters(
  request: ModbusRequest,
  store: RegisterStore,
): RouteResult {
  // Parse start address and quantity from request data (both uint16 BE)
  const startAddress = request.data.readUInt16BE(0);
  const quantity = request.data.readUInt16BE(2);

  // Validate quantity is in [1, 125]
  if (quantity < 1 || quantity > MAX_QUANTITY) {
    return buildException(ErrorCode.ILLEGAL_DATA_VALUE);
  }

  // Read registers from the store
  const values = store.readRegisters(startAddress, quantity);

  // If the store returned an ErrorCode, map it to an exception response
  if (typeof values === 'number') {
    return buildException(values);
  }

  // Build success response PDU: 0x03 | byteCount | values...
  const byteCount = quantity * 2;
  const pdu = Buffer.alloc(2 + byteCount);
  pdu.writeUInt8(FC_READ_HOLDING_REGISTERS, 0);
  pdu.writeUInt8(byteCount, 1);

  for (let i = 0; i < values.length; i++) {
    pdu.writeUInt16BE(values[i] & 0xFFFF, 2 + i * 2);
  }

  return { type: 'response', pdu };
}

/**
 * Build an exception RouteResult for FC 03.
 * PDU is 2 bytes: [0x83, exceptionCode].
 */
function buildException(exceptionCode: number): RouteResult {
  const pdu = Buffer.alloc(2);
  pdu.writeUInt8(FC_READ_HOLDING_REGISTERS | 0x80, 0);
  pdu.writeUInt8(exceptionCode, 1);
  return { type: 'exception', pdu };
}
