/**
 * Tests for ScenarioScheduler implementation.
 *
 * Validates: Requirements 16.1, 16.2, 16.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScenarioScheduler, type ScenarioEntry } from '../../src/faults/scenario-scheduler.js';
import type { FaultEngine } from '../../src/faults/fault-engine.js';
import type { ActiveFault } from '../../src/server/connection-handler.js';

function makeMockFaultEngine(): FaultEngine & { activatedFaults: ActiveFault[]; tickCalls: number[] } {
  const activatedFaults: ActiveFault[] = [];
  const tickCalls: number[] = [];
  return {
    activatedFaults,
    tickCalls,
    activate(fault: ActiveFault) {
      activatedFaults.push(fault);
    },
    tick(nowMs: number) {
      tickCalls.push(nowMs);
    },
    applyFaults: vi.fn(),
    isFrozen: vi.fn().mockReturnValue(false),
  } as unknown as FaultEngine & { activatedFaults: ActiveFault[]; tickCalls: number[] };
}

describe('ScenarioScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should activate a fault at the configured offset (Req 16.1)', () => {
    const engine = makeMockFaultEngine();
    const logs: string[] = [];
    let clockMs = 0;
    const clock = () => clockMs;
    const log = (msg: string) => logs.push(msg);

    const entries: ScenarioEntry[] = [
      { offsetMs: 1000, faultType: 'freeze_register', target: '1:temperature', params: {} },
    ];

    const scheduler = new ScenarioScheduler(entries, engine, clock, log);
    scheduler.start();

    // Advance time
    clockMs = 1000;
    vi.advanceTimersByTime(1000);

    expect(engine.activatedFaults).toHaveLength(1);
    expect(engine.activatedFaults[0].type).toBe('freeze_register');
    expect(engine.activatedFaults[0].target).toBe('1:temperature');
  });

  it('should activate entries in chronological order by offset (Req 16.2)', () => {
    const engine = makeMockFaultEngine();
    const logs: string[] = [];
    let clockMs = 0;
    const clock = () => clockMs;
    const log = (msg: string) => logs.push(msg);

    const entries: ScenarioEntry[] = [
      { offsetMs: 2000, faultType: 'slow_response', target: '1', params: { delayMs: 500 } },
      { offsetMs: 1000, faultType: 'freeze_register', target: '1:temperature', params: {} },
    ];

    const scheduler = new ScenarioScheduler(entries, engine, clock, log);
    scheduler.start();

    // After 1000ms, only the freeze should have fired
    clockMs = 1000;
    vi.advanceTimersByTime(1000);
    expect(engine.activatedFaults).toHaveLength(1);
    expect(engine.activatedFaults[0].type).toBe('freeze_register');

    // After 2000ms, slow_response should also have fired
    clockMs = 2000;
    vi.advanceTimersByTime(1000);
    expect(engine.activatedFaults).toHaveLength(2);
    expect(engine.activatedFaults[1].type).toBe('slow_response');
  });

  it('should preserve declaration order for entries with equal offsets (Req 16.2)', () => {
    const engine = makeMockFaultEngine();
    const logs: string[] = [];
    let clockMs = 0;
    const clock = () => clockMs;
    const log = (msg: string) => logs.push(msg);

    const entries: ScenarioEntry[] = [
      { offsetMs: 1000, faultType: 'freeze_register', target: '1:temperature', params: {} },
      { offsetMs: 1000, faultType: 'slow_response', target: '1', params: { delayMs: 200 } },
      { offsetMs: 1000, faultType: 'connection_drop', target: '2', params: {} },
    ];

    const scheduler = new ScenarioScheduler(entries, engine, clock, log);
    scheduler.start();

    clockMs = 1000;
    vi.advanceTimersByTime(1000);

    expect(engine.activatedFaults).toHaveLength(3);
    expect(engine.activatedFaults[0].type).toBe('freeze_register');
    expect(engine.activatedFaults[1].type).toBe('slow_response');
    expect(engine.activatedFaults[2].type).toBe('connection_drop');
  });

  it('should emit a log line with elapsed time, fault type, and target (Req 16.3)', () => {
    const engine = makeMockFaultEngine();
    const logs: string[] = [];
    let clockMs = 0;
    const clock = () => clockMs;
    const log = (msg: string) => logs.push(msg);

    const entries: ScenarioEntry[] = [
      { offsetMs: 500, faultType: 'freeze_register', target: '1:temperature', params: {} },
    ];

    const scheduler = new ScenarioScheduler(entries, engine, clock, log);
    scheduler.start();

    clockMs = 500;
    vi.advanceTimersByTime(500);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe('[500ms] freeze_register activated on 1:temperature');
  });

  it('should schedule deactivation if duration is specified', () => {
    const engine = makeMockFaultEngine();
    const logs: string[] = [];
    let clockMs = 0;
    const clock = () => clockMs;
    const log = (msg: string) => logs.push(msg);

    const entries: ScenarioEntry[] = [
      { offsetMs: 1000, faultType: 'freeze_register', target: '1:temperature', params: {}, duration: 2000 },
    ];

    const scheduler = new ScenarioScheduler(entries, engine, clock, log);
    scheduler.start();

    // Activate at 1000ms
    clockMs = 1000;
    vi.advanceTimersByTime(1000);
    expect(engine.activatedFaults).toHaveLength(1);

    // Deactivation should happen at 1000 + 2000 = 3000ms
    clockMs = 3000;
    vi.advanceTimersByTime(2000);
    expect(engine.tickCalls).toContain(3000);
  });

  it('should cancel all pending timers on stop()', () => {
    const engine = makeMockFaultEngine();
    const logs: string[] = [];
    let clockMs = 0;
    const clock = () => clockMs;
    const log = (msg: string) => logs.push(msg);

    const entries: ScenarioEntry[] = [
      { offsetMs: 1000, faultType: 'freeze_register', target: '1:temperature', params: {} },
      { offsetMs: 2000, faultType: 'slow_response', target: '1', params: { delayMs: 300 } },
    ];

    const scheduler = new ScenarioScheduler(entries, engine, clock, log);
    scheduler.start();

    // Stop before any timers fire
    scheduler.stop();

    clockMs = 2000;
    vi.advanceTimersByTime(2000);

    expect(engine.activatedFaults).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('should set activatedAt on the fault to the clock time at activation', () => {
    const engine = makeMockFaultEngine();
    const logs: string[] = [];
    let clockMs = 0;
    const clock = () => clockMs;
    const log = (msg: string) => logs.push(msg);

    const entries: ScenarioEntry[] = [
      { offsetMs: 750, faultType: 'connection_drop', target: '2', params: {} },
    ];

    const scheduler = new ScenarioScheduler(entries, engine, clock, log);
    scheduler.start();

    clockMs = 750;
    vi.advanceTimersByTime(750);

    expect(engine.activatedFaults[0].activatedAt).toBe(750);
  });

  it('should pass duration to the activated fault', () => {
    const engine = makeMockFaultEngine();
    const logs: string[] = [];
    let clockMs = 0;
    const clock = () => clockMs;
    const log = (msg: string) => logs.push(msg);

    const entries: ScenarioEntry[] = [
      { offsetMs: 100, faultType: 'slow_response', target: '1', params: { delayMs: 500 }, duration: 3000 },
    ];

    const scheduler = new ScenarioScheduler(entries, engine, clock, log);
    scheduler.start();

    clockMs = 100;
    vi.advanceTimersByTime(100);

    expect(engine.activatedFaults[0].duration).toBe(3000);
  });

  it('should handle empty entries array gracefully', () => {
    const engine = makeMockFaultEngine();
    const logs: string[] = [];
    const clock = () => 0;
    const log = (msg: string) => logs.push(msg);

    const scheduler = new ScenarioScheduler([], engine, clock, log);
    scheduler.start();
    scheduler.stop();

    expect(engine.activatedFaults).toHaveLength(0);
  });
});
