/**
 * Fault injection engine.
 *
 * Manages active faults per device, handles duration-based expiry,
 * and applies fault effects (freeze, delay, connection drop) to
 * pending Modbus responses.
 */

import type {
  FaultEngine as IFaultEngine,
  ActiveFault,
  FaultType,
} from '../server/connection-handler.js';
import type { RouteResult } from '../protocol/router.js';
import type { RegisterStore } from '../signals/register-store.js';

export type { ActiveFault, FaultType } from '../server/connection-handler.js';

/**
 * Concrete implementation of the FaultEngine interface.
 *
 * Accepts a map of unit ID → RegisterStore (for freeze delegation)
 * and an injectable clock function for deterministic testing.
 */
export class FaultEngine implements IFaultEngine {
  private readonly stores: Map<number, RegisterStore>;
  private readonly clock: () => number;

  /** Active faults indexed by a composite key for fast lookup. */
  private readonly activeFaults: ActiveFault[] = [];

  constructor(stores: Map<number, RegisterStore>, clock: () => number) {
    this.stores = stores;
    this.clock = clock;
  }

  /** Activate a fault. For freeze_register, delegates to the register store. */
  activate(fault: ActiveFault): void {
    this.activeFaults.push(fault);

    if (fault.type === 'freeze_register') {
      const { unitId, registerName } = this.parseFreezeTarget(fault.target);
      const store = this.stores.get(unitId);
      if (store) {
        store.freeze(registerName);
      }
    }
  }

  /** Deactivate expired faults based on current time. */
  tick(nowMs: number): void {
    for (let i = this.activeFaults.length - 1; i >= 0; i--) {
      const fault = this.activeFaults[i];
      if (fault.duration !== undefined && nowMs >= fault.activatedAt + fault.duration) {
        this.deactivate(i);
      }
    }
  }

  /**
   * Apply faults to a pending response.
   *
   * Priority order:
   * 1. connection_drop → close immediately, consume the fault (one-shot)
   * 2. slow_response → delay, then send
   * 3. No fault → send immediately
   */
  async applyFaults(
    deviceUnitId: number,
    result: RouteResult,
    send: (buf: Buffer) => void,
    close: () => void,
  ): Promise<void> {
    // Check for connection_drop first (highest priority, one-shot)
    const dropIndex = this.activeFaults.findIndex(
      (f) => f.type === 'connection_drop' && this.getTargetUnitId(f) === deviceUnitId,
    );
    if (dropIndex !== -1) {
      // Remove the one-shot fault and close
      this.activeFaults.splice(dropIndex, 1);
      close();
      return;
    }

    // Check for slow_response
    const slowFault = this.activeFaults.find(
      (f) => f.type === 'slow_response' && this.getTargetUnitId(f) === deviceUnitId,
    );
    if (slowFault) {
      const delayMs = (slowFault.params.delayMs as number) ?? 0;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      if (result.pdu) {
        send(result.pdu);
      }
      return;
    }

    // No active fault for this device — send immediately
    if (result.pdu) {
      send(result.pdu);
    }
  }

  /** Check if a register is frozen for a specific device. */
  isFrozen(deviceUnitId: number, registerName: string): boolean {
    return this.activeFaults.some(
      (f) =>
        f.type === 'freeze_register' &&
        this.matchesFreezeTarget(f.target, deviceUnitId, registerName),
    );
  }

  /** Remove a fault by index and handle cleanup (e.g., unfreezing). */
  private deactivate(index: number): void {
    const fault = this.activeFaults[index];
    this.activeFaults.splice(index, 1);

    if (fault.type === 'freeze_register') {
      const { unitId, registerName } = this.parseFreezeTarget(fault.target);
      const store = this.stores.get(unitId);
      if (store) {
        store.unfreeze(registerName);
      }
    }
  }

  /**
   * Parse a freeze target string in the format "unitId:registerName".
   */
  private parseFreezeTarget(target: string): { unitId: number; registerName: string } {
    const colonIndex = target.indexOf(':');
    if (colonIndex === -1) {
      // Fallback: target is just the register name (no unit specified)
      return { unitId: 0, registerName: target };
    }
    const unitId = parseInt(target.substring(0, colonIndex), 10);
    const registerName = target.substring(colonIndex + 1);
    return { unitId, registerName };
  }

  /** Check if a freeze target matches a given device and register. */
  private matchesFreezeTarget(
    target: string,
    deviceUnitId: number,
    registerName: string,
  ): boolean {
    const parsed = this.parseFreezeTarget(target);
    return parsed.unitId === deviceUnitId && parsed.registerName === registerName;
  }

  /** Extract the target unit ID from a fault (for slow_response and connection_drop). */
  private getTargetUnitId(fault: ActiveFault): number {
    if (fault.type === 'freeze_register') {
      return this.parseFreezeTarget(fault.target).unitId;
    }
    return parseInt(fault.target, 10);
  }
}
