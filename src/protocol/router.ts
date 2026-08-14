/**
 * Modbus request router.
 *
 * Routes incoming ModbusRequest objects to the appropriate function-code
 * handler based on the destination unit ID and function code. Applies
 * validation rules for protocol ID, PDU length, and supported function codes.
 */

import type { ModbusRequest } from './frame-parser.js';
import type { RouteResult } from './handlers/fc03.js';
import { RegisterStore } from '../signals/register-store.js';
import { handleReadHoldingRegisters } from './handlers/fc03.js';
import { handleWriteSingleRegister } from './handlers/fc06.js';
import { handleWriteMultipleRegisters } from './handlers/fc16.js';

export type { RouteResult } from './handlers/fc03.js';

/** A simulated Modbus device with a unit ID and register store. */
export interface Device {
  unitId: number;
  store: RegisterStore;
}

/** Supported function codes mapped to their handlers. */
const HANDLERS: Map<number, (request: ModbusRequest, store: RegisterStore) => RouteResult> = new Map([
  [0x03, handleReadHoldingRegisters],
  [0x06, handleWriteSingleRegister],
  [0x10, handleWriteMultipleRegisters],
]);

/**
 * Route a parsed Modbus request to the appropriate handler.
 *
 * Routing rules (applied in order):
 * 1. Protocol ID ≠ 0x0000 → discard (Req 4.5)
 * 2. PDU < 1 byte (header.length < 2) → close (Req 5.2)
 * 3. Unit ID not in device map → discard (Req 1.3)
 * 4. Unsupported function code → exception 01 (Req 5.1)
 * 5. Otherwise → dispatch to handler
 *
 * @param request - Parsed Modbus request from the frame parser
 * @param devices - Map of unit ID to Device instances
 * @returns A RouteResult indicating how to respond
 */
export function route(
  request: ModbusRequest,
  devices: Map<number, Device>,
): RouteResult {
  // Rule 1: Protocol ID must be 0x0000 for Modbus TCP
  if (request.header.protocolId !== 0x0000) {
    return { type: 'discard' };
  }

  // Rule 2: PDU must be at least 1 byte (length field = unitId + PDU, so length < 2 means no PDU)
  if (request.header.length < 2) {
    return { type: 'close' };
  }

  // Rule 3: Unit ID must exist in the device map
  const device = devices.get(request.header.unitId);
  if (device === undefined) {
    return { type: 'discard' };
  }

  // Rule 4: Function code must be supported
  const handler = HANDLERS.get(request.functionCode);
  if (handler === undefined) {
    const pdu = Buffer.alloc(2);
    pdu.writeUInt8(request.functionCode | 0x80, 0);
    pdu.writeUInt8(0x01, 1); // Exception code 01: Illegal Function
    return { type: 'exception', pdu };
  }

  // Rule 5: Dispatch to handler
  return handler(request, device.store);
}
