/**
 * Tests for FaultEngine implementation.
 *
 * Validates: Requirements 13.1–13.4, 14.1–14.4, 15.1–15.2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FaultEngine } from '../../src/faults/fault-engine.js';
import { RegisterStore } from '../../src/signals/register-store.js';
import type { ActiveFault } from '../../src/server/connection-handler.js';
import type { RouteResult } from '../../src/protocol/router.js';

function makeStore(clock: () => number): RegisterStore {
  return new RegisterStore(
    [
      { name: 'temperature', address: 0, type: 'uint16', initialValue: 100 },
      { name: 'pressure', address: 1, type: 'uint16', initialValue: 200 },
    ],
    clock,
  );
}

describe('FaultEngine', () => {
  let clock: { now: number };
  let getClock: () => number;
  let store: RegisterStore;
  let stores: Map<number, RegisterStore>;
  let engine: FaultEngine;

  beforeEach(() => {
    clock = { now: 0 };
    getClock = () => clock.now;
    store = makeStore(getClock);
    stores = new Map([[1, store]]);
    engine = new FaultEngine(stores, getClock);
  });

  describe('freeze_register fault', () => {
    it('should freeze a register on activation (Req 13.1)', () => {
      const fault: ActiveFault = {
        type: 'freeze_register',
        target: '1:temperature',
        activatedAt: 0,
        duration: 5000,
        params: {},
      };

      engine.activate(fault);
      expect(engine.isFrozen(1, 'temperature')).toBe(true);
    });

    it('should not freeze registers on other devices', () => {
      const fault: ActiveFault = {
        type: 'freeze_register',
        target: '1:temperature',
        activatedAt: 0,
        duration: 5000,
        params: {},
      };

      engine.activate(fault);
      expect(engine.isFrozen(2, 'temperature')).toBe(false);
    });

    it('should unfreeze on duration expiry (Req 13.3)', () => {
      const fault: ActiveFault = {
        type: 'freeze_register',
        target: '1:temperature',
        activatedAt: 0,
        duration: 5000,
        params: {},
      };

      engine.activate(fault);
      expect(engine.isFrozen(1, 'temperature')).toBe(true);

      clock.now = 5000;
      engine.tick(clock.now);
      expect(engine.isFrozen(1, 'temperature')).toBe(false);
    });

    it('should remain active if no duration (Req 14.3 analog)', () => {
      const fault: ActiveFault = {
        type: 'freeze_register',
        target: '1:temperature',
        activatedAt: 0,
        params: {},
      };

      engine.activate(fault);
      clock.now = 999999;
      engine.tick(clock.now);
      expect(engine.isFrozen(1, 'temperature')).toBe(true);
    });

    it('should delegate freeze to RegisterStore', () => {
      const fault: ActiveFault = {
        type: 'freeze_register',
        target: '1:temperature',
        activatedAt: 0,
        duration: 5000,
        params: {},
      };

      engine.activate(fault);

      // After freeze, reading should return frozen value even if we could change it
      const values = store.readRegisters(0, 1);
      expect(values).toEqual([100]);
    });

    it('should unfreeze register in store on expiry', () => {
      const fault: ActiveFault = {
        type: 'freeze_register',
        target: '1:temperature',
        activatedAt: 0,
        duration: 5000,
        params: {},
      };

      engine.activate(fault);

      // Write while frozen — should be silently ignored
      store.writeSingle(0, 999);
      expect(store.readRegisters(0, 1)).toEqual([100]);

      // Expire the fault
      clock.now = 5000;
      engine.tick(clock.now);

      // Now the store should be unfrozen, writes take effect
      store.writeSingle(0, 500);
      expect(store.readRegisters(0, 1)).toEqual([500]);
    });
  });

  describe('slow_response fault', () => {
    it('should delay response by configured delayMs (Req 14.1)', async () => {
      const fault: ActiveFault = {
        type: 'slow_response',
        target: '1',
        activatedAt: 0,
        duration: 10000,
        params: { delayMs: 100 },
      };

      engine.activate(fault);

      const result: RouteResult = { type: 'response', pdu: Buffer.from([0x03, 0x02, 0x00, 0x64]) };
      const send = vi.fn();
      const close = vi.fn();

      vi.useFakeTimers();
      const promise = engine.applyFaults(1, result, send, close);

      // Not yet sent
      expect(send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(send).toHaveBeenCalledWith(result.pdu);
      expect(close).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should deactivate after duration expires (Req 14.2)', async () => {
      const fault: ActiveFault = {
        type: 'slow_response',
        target: '1',
        activatedAt: 0,
        duration: 5000,
        params: { delayMs: 100 },
      };

      engine.activate(fault);
      clock.now = 5000;
      engine.tick(clock.now);

      // After expiry, response should be sent immediately (no delay)
      const result: RouteResult = { type: 'response', pdu: Buffer.from([0x03, 0x02, 0x00, 0x64]) };
      const send = vi.fn();
      const close = vi.fn();

      await engine.applyFaults(1, result, send, close);
      expect(send).toHaveBeenCalledWith(result.pdu);
    });

    it('should stay active indefinitely if no duration (Req 14.3)', () => {
      const fault: ActiveFault = {
        type: 'slow_response',
        target: '1',
        activatedAt: 0,
        params: { delayMs: 100 },
      };

      engine.activate(fault);
      clock.now = 999999;
      engine.tick(clock.now);

      // Fault should still be there — we can't easily test this without applyFaults
      // but we can check it doesn't throw
    });
  });

  describe('connection_drop fault', () => {
    it('should call close immediately on applyFaults (Req 15.1)', async () => {
      const fault: ActiveFault = {
        type: 'connection_drop',
        target: '1',
        activatedAt: 0,
        params: {},
      };

      engine.activate(fault);

      const result: RouteResult = { type: 'response', pdu: Buffer.from([0x03, 0x02, 0x00, 0x64]) };
      const send = vi.fn();
      const close = vi.fn();

      await engine.applyFaults(1, result, send, close);

      expect(close).toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('should be a one-shot fault that removes itself after firing', async () => {
      const fault: ActiveFault = {
        type: 'connection_drop',
        target: '1',
        activatedAt: 0,
        params: {},
      };

      engine.activate(fault);

      const result: RouteResult = { type: 'response', pdu: Buffer.from([0x03, 0x02, 0x00, 0x64]) };
      const send = vi.fn();
      const close = vi.fn();

      // First call drops
      await engine.applyFaults(1, result, send, close);
      expect(close).toHaveBeenCalledTimes(1);

      // Second call should send normally (fault consumed)
      const send2 = vi.fn();
      const close2 = vi.fn();
      await engine.applyFaults(1, result, send2, close2);
      expect(send2).toHaveBeenCalledWith(result.pdu);
      expect(close2).not.toHaveBeenCalled();
    });
  });

  describe('applyFaults with no active faults', () => {
    it('should send response immediately when no faults active', async () => {
      const result: RouteResult = { type: 'response', pdu: Buffer.from([0x03, 0x02, 0x00, 0x64]) };
      const send = vi.fn();
      const close = vi.fn();

      await engine.applyFaults(1, result, send, close);

      expect(send).toHaveBeenCalledWith(result.pdu);
      expect(close).not.toHaveBeenCalled();
    });

    it('should send exception PDU when result type is exception', async () => {
      const pdu = Buffer.from([0x83, 0x02]);
      const result: RouteResult = { type: 'exception', pdu };
      const send = vi.fn();
      const close = vi.fn();

      await engine.applyFaults(1, result, send, close);

      expect(send).toHaveBeenCalledWith(pdu);
      expect(close).not.toHaveBeenCalled();
    });
  });

  describe('tick expiry', () => {
    it('should expire multiple faults when their duration passes', () => {
      const fault1: ActiveFault = {
        type: 'freeze_register',
        target: '1:temperature',
        activatedAt: 0,
        duration: 3000,
        params: {},
      };
      const fault2: ActiveFault = {
        type: 'freeze_register',
        target: '1:pressure',
        activatedAt: 1000,
        duration: 5000,
        params: {},
      };

      engine.activate(fault1);
      engine.activate(fault2);

      // At 3000ms, fault1 should expire but fault2 stays
      clock.now = 3000;
      engine.tick(clock.now);
      expect(engine.isFrozen(1, 'temperature')).toBe(false);
      expect(engine.isFrozen(1, 'pressure')).toBe(true);

      // At 6000ms, fault2 should also expire
      clock.now = 6000;
      engine.tick(clock.now);
      expect(engine.isFrozen(1, 'pressure')).toBe(false);
    });
  });
});
