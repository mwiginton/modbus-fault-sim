/**
 * FC 16 — Write Multiple Registers handler.
 *
 * Parses a Write Multiple Registers request, validates quantity (1–123),
 * byte count consistency (must equal 2 × quantity), and address range,
 * writes values to the register store, and returns a response PDU
 * echoing start address and quantity.
 */

import type { ModbusRequest } from '../frame-parser.js';
import { RegisterStore, ErrorCode } from '../../signals/register-store.js';
import type { RouteResult } from './fc03.js';

/** FC 16 function code constant. */
const FC_WRITE_MULTIPLE_REGISTERS = 0x10;

/** Maximum quantity of registers allowed per FC 16 request. */
const MAX_QUANTITY = 123;

/**
 * Handle a Write Multiple Registers (FC 16) request.
 *
 * @param request - Parsed Modbus request with function code 0x10
 * @param store - The register store for the addressed device
 * @returns A RouteResult with response PDU on success or exception PDU on error
 */
export function handleWriteMultipleRegisters(
  request: ModbusRequest,
  store: RegisterStore,
): RouteResult {
  // Parse fields from request data
  const startAddress = request.data.readUInt16BE(0);
  const quantity = request.data.readUInt16BE(2);
  const byteCount = request.data.readUInt8(4);

  // Validate quantity is in [1, 123]
  if (quantity < 1 || quantity > MAX_QUANTITY) {
    return buildException(ErrorCode.ILLEGAL_DATA_VALUE);
  }

  // Validate byte count equals 2 × quantity
  if (byteCount !== quantity * 2) {
    return buildException(ErrorCode.ILLEGAL_DATA_VALUE);
  }

  // Extract register values from the data buffer
  const values: number[] = [];
  for (let i = 0; i < quantity; i++) {
    values.push(request.data.readUInt16BE(5 + i * 2));
  }

  // Write to the store (address range validation is delegated to the store)
  const error = store.writeMultiple(startAddress, values);

  if (error !== undefined) {
    return buildException(error);
  }

  // Build success response PDU: 0x10 + startAddress (2) + quantity (2)
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC_WRITE_MULTIPLE_REGISTERS, 0);
  pdu.writeUInt16BE(startAddress, 1);
  pdu.writeUInt16BE(quantity, 3);

  return { type: 'response', pdu };
}

/**
 * Build an exception RouteResult for FC 16.
 * PDU is 2 bytes: [0x90, exceptionCode].
 */
function buildException(exceptionCode: number): RouteResult {
  const pdu = Buffer.alloc(2);
  pdu.writeUInt8(FC_WRITE_MULTIPLE_REGISTERS | 0x80, 0);
  pdu.writeUInt8(exceptionCode, 1);
  return { type: 'exception', pdu };
}
