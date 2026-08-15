/**
 * Connection handler for Modbus TCP connections.
 *
 * Manages a single TCP connection: feeds incoming data to FrameParser,
 * routes parsed frames to the appropriate device handler, applies faults
 * via the FaultEngine, and sends responses back via frame-builder.
 */

import type net from 'node:net';
import { FrameParser } from '../protocol/frame-parser.js';
import { buildResponse } from '../protocol/frame-builder.js';
import { route } from '../protocol/router.js';
import type { Device, RouteResult } from '../protocol/router.js';

/**
 * Interface for the fault engine that intercepts responses.
 *
 * The FaultEngine sits between the handler result and the response frame.
 * It may delay, modify, or suppress responses depending on active faults.
 */
export interface FaultEngine {
  /** Activate a fault. */
  activate(fault: ActiveFault): void;

  /** Deactivate expired faults based on current time. */
  tick(nowMs: number): void;

  /**
   * Apply faults to a pending response.
   *
   * The engine decides what to do with the result:
   * - Call `send(buf)` to send a response frame
   * - Call `close()` to destroy the connection
   * - Do neither (suppress the response entirely)
   */
  applyFaults(
    deviceUnitId: number,
    result: RouteResult,
    send: (buf: Buffer) => void,
    close: () => void,
  ): Promise<void>;

  /** Check if a register is frozen. */
  isFrozen(deviceUnitId: number, registerName: string): boolean;
}

/** Fault type identifiers. */
export type FaultType = 'freeze_register' | 'slow_response' | 'connection_drop';

/** Descriptor for an active fault instance. */
export interface ActiveFault {
  type: FaultType;
  target: string;
  activatedAt: number;
  duration?: number;
  params: Record<string, unknown>;
}

/**
 * Handle a single TCP connection for the Modbus fault simulator.
 *
 * This function wires together the frame parser, router, fault engine,
 * and frame builder into a processing pipeline for one client connection.
 *
 * Data flow:
 * 1. Raw TCP bytes arrive via socket 'data' events
 * 2. FrameParser accumulates bytes into complete ModbusRequest objects
 * 3. Router dispatches each request to the correct device/handler
 * 4. For 'discard' results: no response is sent
 * 5. For 'close' results: the socket is destroyed
 * 6. For 'response' or 'exception' results: faults are applied, then
 *    the response frame is built and sent
 *
 * Error handling:
 * - Socket errors (ECONNRESET, etc.) are logged and the connection is cleaned up
 * - Frame parser close conditions destroy the socket
 */
export function handleConnection(
  socket: net.Socket,
  devices: Map<number, Device>,
  faultEngine: FaultEngine,
): void {
  const parser = new FrameParser();

  socket.on('data', (chunk: Buffer) => {
    const requests = parser.feed(chunk);

    // If the parser flagged a close condition, destroy the socket
    if (parser.shouldClose) {
      socket.destroy();
      return;
    }

    for (const request of requests) {
      const result = route(request, devices);

      switch (result.type) {
        case 'discard':
          // No response; silently ignore
          break;

        case 'close':
          socket.destroy();
          return;

        case 'response':
        case 'exception': {
          const { transactionId, unitId } = request.header;

          const send = (pdu: Buffer): void => {
            const frame = buildResponse({ transactionId, unitId }, pdu);
            socket.write(frame);
          };

          const close = (): void => {
            socket.destroy();
          };

          // Apply faults asynchronously — the engine decides whether to
          // send, delay, or drop the response.
          faultEngine.applyFaults(unitId, result, send, close);
          break;
        }
      }
    }
  });

  socket.on('error', (_err: Error) => {
    // Log and clean up — the socket will emit 'close' next,
    // which is handled by TcpServer's connection tracking.
    parser.reset();
  });

  socket.on('close', () => {
    parser.reset();
  });
}
