/**
 * Tests for src/server/connection-handler.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { handleConnection } from '../../src/server/connection-handler.js';
import { RegisterStore } from '../../src/signals/register-store.js';
import type { Device } from '../../src/protocol/router.js';
import type { RouteResult } from '../../src/protocol/handlers/fc03.js';
import type { FaultEngine } from '../../src/server/connection-handler.js';

/** Creates a fake net.Socket that emits events and captures writes. */
function createFakeSocket(): net.Socket & { written: Buffer[]; destroyed: boolean } {
  const emitter = new EventEmitter() as any;
  emitter.written = [] as Buffer[];
  emitter.destroyed = false;
  emitter.write = (data: Buffer) => {
    emitter.written.push(Buffer.from(data));
    return true;
  };
  emitter.destroy = () => {
    emitter.destroyed = true;
    emitter.emit('close');
  };
  emitter.remoteAddress = '127.0.0.1';
  emitter.remotePort = 12345;
  return emitter as net.Socket & { written: Buffer[]; destroyed: boolean };
}

/** Build a valid FC 03 request frame (read 1 register at address 0, unit ID 1). */
function buildFc03Request(transactionId: number, unitId: number, startAddr: number, quantity: number): Buffer {
  const frame = Buffer.alloc(12);
  frame.writeUInt16BE(transactionId, 0);  // Transaction ID
  frame.writeUInt16BE(0x0000, 2);         // Protocol ID
  frame.writeUInt16BE(6, 4);              // Length: unitId(1) + FC(1) + addr(2) + qty(2)
  frame.writeUInt8(unitId, 6);            // Unit ID
  frame.writeUInt8(0x03, 7);              // Function Code 03
  frame.writeUInt16BE(startAddr, 8);      // Start address
  frame.writeUInt16BE(quantity, 10);      // Quantity
  return frame;
}

/** Build a valid FC 06 request frame (write single register). */
function buildFc06Request(transactionId: number, unitId: number, addr: number, value: number): Buffer {
  const frame = Buffer.alloc(12);
  frame.writeUInt16BE(transactionId, 0);
  frame.writeUInt16BE(0x0000, 2);
  frame.writeUInt16BE(6, 4);
  frame.writeUInt8(unitId, 6);
  frame.writeUInt8(0x06, 7);
  frame.writeUInt16BE(addr, 8);
  frame.writeUInt16BE(value, 10);
  return frame;
}

/** Creates a no-op FaultEngine that just sends the response directly. */
function createPassthroughFaultEngine(): FaultEngine {
  return {
    activate: vi.fn(),
    tick: vi.fn(),
    applyFaults: vi.fn(async (
      _deviceUnitId: number,
      result: RouteResult,
      send: (buf: Buffer) => void,
      _close: () => void,
    ) => {
      if (result.pdu) {
        send(result.pdu);
      }
    }),
    isFrozen: vi.fn().mockReturnValue(false),
  };
}

/** Creates a FaultEngine that calls close() instead of sending. */
function createDropFaultEngine(): FaultEngine {
  return {
    activate: vi.fn(),
    tick: vi.fn(),
    applyFaults: vi.fn(async (
      _deviceUnitId: number,
      _result: RouteResult,
      _send: (buf: Buffer) => void,
      close: () => void,
    ) => {
      close();
    }),
    isFrozen: vi.fn().mockReturnValue(false),
  };
}

function createDevices(): Map<number, Device> {
  const store = new RegisterStore(
    [{ name: 'reg0', address: 0, type: 'uint16', initialValue: 42 }],
    () => 0,
  );
  const device: Device = { unitId: 1, store };
  return new Map([[1, device]]);
}

describe('handleConnection', () => {
  let socket: ReturnType<typeof createFakeSocket>;
  let devices: Map<number, Device>;
  let faultEngine: FaultEngine;

  beforeEach(() => {
    socket = createFakeSocket();
    devices = createDevices();
    faultEngine = createPassthroughFaultEngine();
  });

  it('should respond to a valid FC 03 request with the correct MBAP header', () => {
    handleConnection(socket, devices, faultEngine);

    const request = buildFc03Request(0x0001, 1, 0, 1);
    socket.emit('data', request);

    expect(socket.written.length).toBe(1);
    const resp = socket.written[0];

    // Transaction ID echoed
    expect(resp.readUInt16BE(0)).toBe(0x0001);
    // Protocol ID
    expect(resp.readUInt16BE(2)).toBe(0x0000);
    // Unit ID echoed
    expect(resp.readUInt8(6)).toBe(1);
    // FC 03 in PDU
    expect(resp.readUInt8(7)).toBe(0x03);
    // Byte count = 2 (1 register * 2)
    expect(resp.readUInt8(8)).toBe(2);
    // Value = 42
    expect(resp.readUInt16BE(9)).toBe(42);
  });

  it('should echo an FC 06 write correctly', () => {
    handleConnection(socket, devices, faultEngine);

    const request = buildFc06Request(0x0002, 1, 0, 100);
    socket.emit('data', request);

    expect(socket.written.length).toBe(1);
    const resp = socket.written[0];

    // Transaction ID
    expect(resp.readUInt16BE(0)).toBe(0x0002);
    // Unit ID
    expect(resp.readUInt8(6)).toBe(1);
    // FC 06 echo: addr=0, value=100
    expect(resp.readUInt8(7)).toBe(0x06);
    expect(resp.readUInt16BE(8)).toBe(0);
    expect(resp.readUInt16BE(10)).toBe(100);
  });

  it('should discard requests for unknown unit IDs (no response)', () => {
    handleConnection(socket, devices, faultEngine);

    const request = buildFc03Request(0x0003, 99, 0, 1);
    socket.emit('data', request);

    expect(socket.written.length).toBe(0);
  });

  it('should produce an exception for unsupported function codes', () => {
    handleConnection(socket, devices, faultEngine);

    // FC 0x07 is not supported
    const frame = Buffer.alloc(12);
    frame.writeUInt16BE(0x0004, 0);
    frame.writeUInt16BE(0x0000, 2);
    frame.writeUInt16BE(6, 4);
    frame.writeUInt8(1, 6);
    frame.writeUInt8(0x07, 7);
    frame.writeUInt16BE(0, 8);
    frame.writeUInt16BE(1, 10);
    socket.emit('data', frame);

    expect(socket.written.length).toBe(1);
    const resp = socket.written[0];
    // Exception FC: 0x07 | 0x80 = 0x87
    expect(resp.readUInt8(7)).toBe(0x87);
    // Exception code 01 (illegal function)
    expect(resp.readUInt8(8)).toBe(0x01);
  });

  it('should discard frames with non-zero protocol ID (no response)', () => {
    handleConnection(socket, devices, faultEngine);

    const frame = Buffer.alloc(12);
    frame.writeUInt16BE(0x0005, 0);
    frame.writeUInt16BE(0x0001, 2); // Non-zero protocol ID
    frame.writeUInt16BE(6, 4);
    frame.writeUInt8(1, 6);
    frame.writeUInt8(0x03, 7);
    frame.writeUInt16BE(0, 8);
    frame.writeUInt16BE(1, 10);
    socket.emit('data', frame);

    expect(socket.written.length).toBe(0);
  });

  it('should pass result through FaultEngine.applyFaults', () => {
    handleConnection(socket, devices, faultEngine);

    const request = buildFc03Request(0x0006, 1, 0, 1);
    socket.emit('data', request);

    expect(faultEngine.applyFaults).toHaveBeenCalledTimes(1);
    const [unitId, result] = (faultEngine.applyFaults as any).mock.calls[0];
    expect(unitId).toBe(1);
    expect(result.type).toBe('response');
  });

  it('should destroy socket when FaultEngine calls close', () => {
    faultEngine = createDropFaultEngine();
    handleConnection(socket, devices, faultEngine);

    const request = buildFc03Request(0x0007, 1, 0, 1);
    socket.emit('data', request);

    expect(socket.destroyed).toBe(true);
  });

  it('should destroy socket when frame parser encounters a close condition', () => {
    handleConnection(socket, devices, faultEngine);

    // A frame with length=1 (only unitId, no PDU) triggers close
    const frame = Buffer.alloc(7);
    frame.writeUInt16BE(0x0008, 0);
    frame.writeUInt16BE(0x0000, 2);
    frame.writeUInt16BE(1, 4); // length=1 means only unit ID, no PDU
    frame.writeUInt8(1, 6);
    socket.emit('data', frame);

    expect(socket.destroyed).toBe(true);
  });

  it('should handle socket error events gracefully without crashing', () => {
    handleConnection(socket, devices, faultEngine);

    // Emitting error should not throw
    expect(() => {
      socket.emit('error', new Error('ECONNRESET'));
    }).not.toThrow();
  });

  it('should handle multiple frames in a single TCP segment', () => {
    handleConnection(socket, devices, faultEngine);

    const req1 = buildFc03Request(0x000A, 1, 0, 1);
    const req2 = buildFc03Request(0x000B, 1, 0, 1);
    const combined = Buffer.concat([req1, req2]);
    socket.emit('data', combined);

    expect(socket.written.length).toBe(2);
    expect(socket.written[0].readUInt16BE(0)).toBe(0x000A);
    expect(socket.written[1].readUInt16BE(0)).toBe(0x000B);
  });

  it('should handle partial frames across multiple data events', () => {
    handleConnection(socket, devices, faultEngine);

    const request = buildFc03Request(0x000C, 1, 0, 1);
    // Split the frame in half
    const part1 = request.subarray(0, 6);
    const part2 = request.subarray(6);

    socket.emit('data', part1);
    expect(socket.written.length).toBe(0);

    socket.emit('data', part2);
    expect(socket.written.length).toBe(1);
    expect(socket.written[0].readUInt16BE(0)).toBe(0x000C);
  });
});
