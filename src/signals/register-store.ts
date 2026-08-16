/**
 * Register store for a simulated Modbus device.
 *
 * Manages a set of named registers with uint16 and float32 types,
 * applies time-varying behaviors, and supports freeze/unfreeze for
 * fault injection.
 */

import { type BehaviorConfig, computeBehaviorValue } from './behaviors.js';
import { float32ToWords, wordsToFloat32 } from '../protocol/float32.js';

/** Modbus exception codes returned by store operations. */
export enum ErrorCode {
  /** Address not in the device register map, or FC 06 on float32. */
  ILLEGAL_DATA_ADDRESS = 0x02,
  /** Quantity outside legal range. */
  ILLEGAL_DATA_VALUE = 0x03,
}

/** Describes a register to be managed by the store. */
export interface RegisterDescriptor {
  name: string;
  address: number;           // Wire address (zero-based)
  type: 'uint16' | 'float32';
  initialValue: number;
  behavior?: BehaviorConfig;
}

/** Internal slot representing a single register. */
interface RegisterSlot {
  name: string;
  type: 'uint16' | 'float32';
  baseAddress: number;
  wordCount: number;         // 1 for uint16, 2 for float32
  currentValue: number;
  behavior: BehaviorConfig | null;
  frozen: boolean;
  frozenValue: number | null;
  /** When true, currentValue takes priority over behavior (set by client writes). */
  pinned: boolean;
}

/**
 * RegisterStore manages a device's holding register space.
 *
 * It maps wire addresses to register slots, handles reads/writes with
 * address validation, encodes float32 across two words, applies behaviors,
 * and supports freeze/unfreeze for fault injection.
 */
export class RegisterStore {
  /** Map from wire address to the owning RegisterSlot. */
  private readonly addressMap: Map<number, RegisterSlot> = new Map();
  /** Map from register name to its slot (for freeze/unfreeze). */
  private readonly nameMap: Map<string, RegisterSlot> = new Map();
  /** Injectable clock returning elapsed milliseconds. */
  private readonly clock: () => number;

  constructor(registers: RegisterDescriptor[], clock: () => number) {
    this.clock = clock;

    for (const desc of registers) {
      const wordCount = desc.type === 'float32' ? 2 : 1;
      const slot: RegisterSlot = {
        name: desc.name,
        type: desc.type,
        baseAddress: desc.address,
        wordCount,
        currentValue: desc.initialValue,
        behavior: desc.behavior ?? null,
        frozen: false,
        frozenValue: null,
        pinned: false,
      };

      this.nameMap.set(desc.name, slot);

      // Map all addresses occupied by this register to the same slot
      for (let i = 0; i < wordCount; i++) {
        this.addressMap.set(desc.address + i, slot);
      }
    }
  }

  /**
   * Read N consecutive registers starting at address.
   * Returns an array of uint16 values, or an ErrorCode.
   */
  readRegisters(startAddress: number, quantity: number): number[] | ErrorCode {
    // Validate that all addresses in the range exist
    for (let i = 0; i < quantity; i++) {
      if (!this.addressMap.has(startAddress + i)) {
        return ErrorCode.ILLEGAL_DATA_ADDRESS;
      }
    }

    const result: number[] = [];
    for (let i = 0; i < quantity; i++) {
      const addr = startAddress + i;
      const slot = this.addressMap.get(addr)!;
      const value = this.getSlotValue(slot);

      if (slot.type === 'uint16') {
        result.push(value & 0xFFFF);
      } else {
        // float32: encode to two words, pick the correct one
        const [hi, lo] = float32ToWords(value);
        const offset = addr - slot.baseAddress;
        result.push(offset === 0 ? hi : lo);
      }
    }

    return result;
  }

  /**
   * Write a single register (FC 06).
   * Returns undefined on success, or an ErrorCode.
   */
  writeSingle(address: number, value: number): void | ErrorCode {
    const slot = this.addressMap.get(address);
    if (!slot) {
      return ErrorCode.ILLEGAL_DATA_ADDRESS;
    }

    // FC 06 on any address occupied by float32 is illegal (Req 10.4)
    if (slot.type === 'float32') {
      return ErrorCode.ILLEGAL_DATA_ADDRESS;
    }

    // If frozen, silently ignore but respond as if succeeded (Req 13.2)
    if (slot.frozen) {
      return undefined;
    }

    slot.currentValue = value & 0xFFFF;
    if (slot.behavior) {
      slot.pinned = true;
    }
    return undefined;
  }

  /**
   * Write multiple registers (FC 16).
   * Returns undefined on success, or an ErrorCode.
   */
  writeMultiple(startAddress: number, values: number[]): void | ErrorCode {
    const quantity = values.length;

    // Validate that all addresses in the range exist
    for (let i = 0; i < quantity; i++) {
      if (!this.addressMap.has(startAddress + i)) {
        return ErrorCode.ILLEGAL_DATA_ADDRESS;
      }
    }

    // Process writes
    let i = 0;
    while (i < quantity) {
      const addr = startAddress + i;
      const slot = this.addressMap.get(addr)!;

      if (slot.frozen) {
        // Skip over all words belonging to this slot (Req 13.2)
        i += slot.wordCount - (addr - slot.baseAddress);
        continue;
      }

      if (slot.type === 'float32') {
        // Writing at the base address with at least 2 values: decode as IEEE 754 (Req 10.3)
        if (addr === slot.baseAddress && i + 1 < quantity) {
          slot.currentValue = wordsToFloat32(values[i], values[i + 1]);
          if (slot.behavior) {
            slot.pinned = true;
          }
          i += 2;
        } else {
          // Partial write to a float32 word — just advance
          // (This is an edge case; the protocol handlers should prevent it)
          i += 1;
        }
      } else {
        slot.currentValue = values[i] & 0xFFFF;
        if (slot.behavior) {
          slot.pinned = true;
        }
        i += 1;
      }
    }

    return undefined;
  }

  /** Check if an address exists in this store. */
  hasAddress(address: number): boolean {
    return this.addressMap.has(address);
  }

  /** Freeze a register at its current value (Req 13.1). */
  freeze(registerName: string): void {
    const slot = this.nameMap.get(registerName);
    if (!slot) return;

    slot.frozen = true;
    slot.frozenValue = this.getSlotValue(slot);
  }

  /** Unfreeze a register, restoring live values (Req 13.3). */
  unfreeze(registerName: string): void {
    const slot = this.nameMap.get(registerName);
    if (!slot) return;

    slot.frozen = false;
    slot.frozenValue = null;
    slot.pinned = false;
  }

  /**
   * Get the current effective value for a register slot.
   * Handles frozen state, pinned (client-written) state, behaviors, and raw stored values.
   */
  private getSlotValue(slot: RegisterSlot): number {
    // If frozen, return frozen value (Req 13.1)
    if (slot.frozen && slot.frozenValue !== null) {
      return slot.frozenValue;
    }

    // If pinned by a client write, return stored value instead of behavior
    if (slot.pinned) {
      return slot.currentValue;
    }

    // If has behavior and not frozen/pinned, compute value
    if (slot.behavior) {
      const raw = computeBehaviorValue(slot.behavior, this.clock());
      // uint16 registers with behaviors: round the computed value (Req 11.4)
      if (slot.type === 'uint16') {
        return Math.round(raw);
      }
      return raw;
    }

    // No behavior: return stored value
    return slot.currentValue;
  }
}
