/**
 * Configuration schema types for the modbus-fault-sim YAML configuration file.
 */

export type FaultType = 'freeze_register' | 'slow_response' | 'connection_drop';

export interface ListenConfig {
  host: string;
  port: number;
}

export interface BehaviorConfigYaml {
  type: 'sine' | 'ramp' | 'constant';
  min?: number;
  max?: number;
  periodMs?: number;
  start?: number;
  end?: number;
  durationMs?: number;
  value?: number;
}

export interface RegisterConfig {
  name: string;
  address: number;
  type: 'uint16' | 'float32';
  initialValue: number;
  behavior?: BehaviorConfigYaml;
}

export interface DeviceConfig {
  name: string;
  unitId: number;
  addressBase?: 'documentation' | 'zero';
  registers: RegisterConfig[];
}

export interface ScenarioEntryConfig {
  offsetMs: number;
  fault: FaultType;
  target: string;
  delayMs?: number;
  durationMs?: number;
}

export interface ConfigFile {
  listen: ListenConfig;
  devices: DeviceConfig[];
  scenario: ScenarioEntryConfig[];
}

export interface ValidationError {
  path: string;
  message: string;
}
