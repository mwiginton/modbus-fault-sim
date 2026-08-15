/**
 * Scenario scheduler for timed fault activation.
 *
 * Sorts scenario entries by offset (stable sort preserving declaration order
 * for ties), schedules each as a setTimeout relative to server start, and
 * handles deactivation via the fault engine's tick() method.
 *
 * Validates: Requirements 16.1, 16.2, 16.3
 */

import type { FaultType, ActiveFault } from '../server/connection-handler.js';
import type { FaultEngine } from './fault-engine.js';

export interface ScenarioEntry {
  offsetMs: number;
  faultType: FaultType;
  target: string;
  params: Record<string, unknown>;
  duration?: number;
}

export class ScenarioScheduler {
  private readonly entries: ScenarioEntry[];
  private readonly faultEngine: FaultEngine;
  private readonly clock: () => number;
  private readonly log: (msg: string) => void;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    entries: ScenarioEntry[],
    faultEngine: FaultEngine,
    clock: () => number,
    log: (msg: string) => void,
  ) {
    // Stable sort by offset, preserving declaration order for equal offsets
    this.entries = [...entries].sort((a, b) => a.offsetMs - b.offsetMs);
    this.faultEngine = faultEngine;
    this.clock = clock;
    this.log = log;
  }

  /** Start scheduling. Called when server begins listening. */
  start(): void {
    const startTime = this.clock();

    for (const entry of this.entries) {
      const delay = entry.offsetMs - (this.clock() - startTime);
      const timer = setTimeout(() => this.fire(entry), delay);
      this.timers.push(timer);
    }
  }

  /** Cancel all pending timers (for graceful shutdown). */
  stop(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.length = 0;
  }

  private fire(entry: ScenarioEntry): void {
    const elapsedMs = this.clock();

    // Log activation (Req 16.3)
    this.log(`[${elapsedMs}ms] ${entry.faultType} activated on ${entry.target}`);

    // Build and activate the fault
    const fault: ActiveFault = {
      type: entry.faultType,
      target: entry.target,
      activatedAt: elapsedMs,
      duration: entry.duration,
      params: entry.params,
    };
    this.faultEngine.activate(fault);

    // Schedule deactivation if duration is specified
    if (entry.duration !== undefined) {
      const deactivateDelay = entry.duration;
      const deactivateTimer = setTimeout(() => {
        this.faultEngine.tick(this.clock());
      }, deactivateDelay);
      this.timers.push(deactivateTimer);
    }
  }
}
