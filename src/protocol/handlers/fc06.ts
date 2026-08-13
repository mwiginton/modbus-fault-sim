/**
 * FC 06 — Write Single Register handler.
 *
 * Parses a Write Single Register request, validates the target address
 * exists and is not float32, writes the value to the register store,
 * and returns a response PDU that echoes the request.
 */

import type { ModbusRequest } from '../frame-parser.js';
import { RegisterStore, ErrorCode } from '../../signals/register-store.js';
import type { RouteResult } from './fc03.js';

/** FC 06 function code constant. */
const FC_WRITE_SINGLE_REGISTER = 0x06;

/**
 * Handle a Write Single Register (FC 06) request.
 *
 * @param request - Parsed Modbus request with function code 0x06
 * @param store - The register store for the addressed device
 * @returns A RouteResult with response PDU on success or exception PDU on error
 */
export function handleWriteSingleRegister(
  request: ModbusRequest,
  store: RegisterStore,
): RouteResult {
  // Parse register address and value from request data (both uint16 BE)
  const address = request.data.readUInt16BE(0);
  const value = request.data.readUInt16BE(2);

  // Attempt to write the value to the store
  const error = store.writeSingle(address, value);

  // If the store returned an ErrorCode, build an exception response
  if (error !== undefined) {
    return buildException(error);
  }

  // Build success response: echo the request PDU (FC + address + value)
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC_WRITE_SINGLE_REGISTER, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(value, 3);

  return { type: 'response', pdu };
}

/**
 * Build an exception RouteResult for FC 06.
 * PDU is 2 bytes: [0x86, exceptionCode].
 */
function buildException(exceptionCode: number): RouteResult {
  const pdu = Buffer.alloc(2);
  pdu.writeUInt8(FC_WRITE_SINGLE_REGISTER | 0x80, 0);
  pdu.writeUInt8(exceptionCode, 1);
  return { type: 'exception', pdu };
}
