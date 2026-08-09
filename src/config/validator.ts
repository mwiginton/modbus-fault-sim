/**
 * Configuration validator for modbus-fault-sim.
 * Validates a parsed YAML object against schema and business rules.
 * Collects all errors rather than failing on first.
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 16.4
 */

import type {
  ConfigFile,
  ListenConfig,
  DeviceConfig,
  RegisterConfig,
  BehaviorConfigYaml,
  ScenarioEntryConfig,
  FaultType,
  ValidationError,
} from './schema.js';

const VALID_FAULT_TYPES: FaultType[] = ['freeze_register', 'slow_response', 'connection_drop'];
const VALID_REGISTER_TYPES = ['uint16', 'float32'] as const;
const VALID_BEHAVIOR_TYPES = ['sine', 'ramp', 'constant'] as const;
const VALID_ADDRESS_BASES = ['documentation', 'zero'] as const;

/**
 * Validate a raw parsed YAML object and return either a valid ConfigFile
 * or an array of ValidationError objects.
 */
export function validateConfig(raw: unknown): ConfigFile | ValidationError[] {
  const errors: ValidationError[] = [];

  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ path: '', message: 'Configuration must be an object' });
    return errors;
  }

  const obj = raw as Record<string, unknown>;

  // Validate listen
  const listen = validateListen(obj['listen'], errors);

  // Validate devices
  const devices = validateDevices(obj['devices'], errors);

  // Validate scenario (needs device/register names for target validation)
  const scenario = validateScenario(obj['scenario'], devices, errors);

  if (errors.length > 0) {
    return errors;
  }

  return {
    listen: listen!,
    devices: devices!,
    scenario: scenario!,
  };
}

function validateListen(
  raw: unknown,
  errors: ValidationError[]
): ListenConfig | null {
  if (raw === undefined || raw === null) {
    errors.push({ path: 'listen', message: 'Required field "listen" is missing' });
    return null;
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ path: 'listen', message: 'Field "listen" must be an object' });
    return null;
  }

  const obj = raw as Record<string, unknown>;
  let valid = true;

  if (obj['host'] === undefined || obj['host'] === null) {
    errors.push({ path: 'listen.host', message: 'Required field "host" is missing' });
    valid = false;
  } else if (typeof obj['host'] !== 'string') {
    errors.push({ path: 'listen.host', message: 'Field "host" must be a string' });
    valid = false;
  }

  if (obj['port'] === undefined || obj['port'] === null) {
    errors.push({ path: 'listen.port', message: 'Required field "port" is missing' });
    valid = false;
  } else if (typeof obj['port'] !== 'number' || !Number.isInteger(obj['port'])) {
    errors.push({ path: 'listen.port', message: 'Field "port" must be an integer' });
    valid = false;
  }

  if (!valid) return null;

  return { host: obj['host'] as string, port: obj['port'] as number };
}

function validateDevices(
  raw: unknown,
  errors: ValidationError[]
): DeviceConfig[] | null {
  if (raw === undefined || raw === null) {
    errors.push({ path: 'devices', message: 'Required field "devices" is missing' });
    return null;
  }

  if (!Array.isArray(raw)) {
    errors.push({ path: 'devices', message: 'Field "devices" must be an array' });
    return null;
  }

  if (raw.length === 0) {
    errors.push({ path: 'devices', message: 'Field "devices" must contain at least one device' });
    return null;
  }

  const devices: DeviceConfig[] = [];
  let allValid = true;

  for (let i = 0; i < raw.length; i++) {
    const device = validateDevice(raw[i], `devices[${i}]`, errors);
    if (device) {
      devices.push(device);
    } else {
      allValid = false;
    }
  }

  if (!allValid) return devices.length > 0 ? devices : null;
  return devices;
}

function validateDevice(
  raw: unknown,
  path: string,
  errors: ValidationError[]
): DeviceConfig | null {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ path, message: 'Device must be an object' });
    return null;
  }

  const obj = raw as Record<string, unknown>;
  let valid = true;

  // name
  if (obj['name'] === undefined || obj['name'] === null) {
    errors.push({ path: `${path}.name`, message: 'Required field "name" is missing' });
    valid = false;
  } else if (typeof obj['name'] !== 'string') {
    errors.push({ path: `${path}.name`, message: 'Field "name" must be a string' });
    valid = false;
  }

  // unitId
  if (obj['unitId'] === undefined || obj['unitId'] === null) {
    errors.push({ path: `${path}.unitId`, message: 'Required field "unitId" is missing' });
    valid = false;
  } else if (typeof obj['unitId'] !== 'number' || !Number.isInteger(obj['unitId'])) {
    errors.push({ path: `${path}.unitId`, message: 'Field "unitId" must be an integer' });
    valid = false;
  }

  // addressBase (optional)
  let addressBase: 'documentation' | 'zero' | undefined;
  if (obj['addressBase'] !== undefined && obj['addressBase'] !== null) {
    if (typeof obj['addressBase'] !== 'string' ||
        !(VALID_ADDRESS_BASES as readonly string[]).includes(obj['addressBase'])) {
      errors.push({
        path: `${path}.addressBase`,
        message: `Field "addressBase" must be one of: ${VALID_ADDRESS_BASES.join(', ')}`,
      });
      valid = false;
    } else {
      addressBase = obj['addressBase'] as 'documentation' | 'zero';
    }
  }

  // registers
  if (obj['registers'] === undefined || obj['registers'] === null) {
    errors.push({ path: `${path}.registers`, message: 'Required field "registers" is missing' });
    valid = false;
  } else if (!Array.isArray(obj['registers'])) {
    errors.push({ path: `${path}.registers`, message: 'Field "registers" must be an array' });
    valid = false;
  }

  if (!valid || !Array.isArray(obj['registers'])) return null;

  const registers: RegisterConfig[] = [];
  let registersValid = true;

  for (let i = 0; i < (obj['registers'] as unknown[]).length; i++) {
    const reg = validateRegister(
      (obj['registers'] as unknown[])[i],
      `${path}.registers[${i}]`,
      addressBase,
      errors
    );
    if (reg) {
      registers.push(reg);
    } else {
      registersValid = false;
    }
  }

  // Overlap detection (Req 9.1, 9.2, 9.3)
  if (registers.length > 0) {
    detectOverlaps(registers, path, errors);
  }

  if (!registersValid && registers.length === 0) return null;

  return {
    name: obj['name'] as string,
    unitId: obj['unitId'] as number,
    ...(addressBase !== undefined ? { addressBase } : {}),
    registers,
  };
}

function validateRegister(
  raw: unknown,
  path: string,
  addressBase: 'documentation' | 'zero' | undefined,
  errors: ValidationError[]
): RegisterConfig | null {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ path, message: 'Register must be an object' });
    return null;
  }

  const obj = raw as Record<string, unknown>;
  let valid = true;

  // name
  if (obj['name'] === undefined || obj['name'] === null) {
    errors.push({ path: `${path}.name`, message: 'Required field "name" is missing' });
    valid = false;
  } else if (typeof obj['name'] !== 'string') {
    errors.push({ path: `${path}.name`, message: 'Field "name" must be a string' });
    valid = false;
  }

  // address
  if (obj['address'] === undefined || obj['address'] === null) {
    errors.push({ path: `${path}.address`, message: 'Required field "address" is missing' });
    valid = false;
  } else if (typeof obj['address'] !== 'number' || !Number.isInteger(obj['address'])) {
    errors.push({ path: `${path}.address`, message: 'Field "address" must be an integer' });
    valid = false;
  }

  // type
  if (obj['type'] === undefined || obj['type'] === null) {
    errors.push({ path: `${path}.type`, message: 'Required field "type" is missing' });
    valid = false;
  } else if (typeof obj['type'] !== 'string' ||
             !(VALID_REGISTER_TYPES as readonly string[]).includes(obj['type'])) {
    errors.push({
      path: `${path}.type`,
      message: `Field "type" must be one of: ${VALID_REGISTER_TYPES.join(', ')}`,
    });
    valid = false;
  }

  // initialValue
  if (obj['initialValue'] === undefined || obj['initialValue'] === null) {
    errors.push({ path: `${path}.initialValue`, message: 'Required field "initialValue" is missing' });
    valid = false;
  } else if (typeof obj['initialValue'] !== 'number') {
    errors.push({ path: `${path}.initialValue`, message: 'Field "initialValue" must be a number' });
    valid = false;
  }

  if (!valid) return null;

  const declaredAddress = obj['address'] as number;
  let wireAddress = declaredAddress;

  // Address base conversion (Req 8.1, 8.2, 8.3)
  if (addressBase === 'documentation') {
    if (declaredAddress < 40001) {
      errors.push({
        path: `${path}.address`,
        message: `Documentation address ${declaredAddress} is less than 40001; documentation addresses must be at least 40001`,
      });
      return null;
    }
    wireAddress = declaredAddress - 40001;
  }

  // Validate behavior if present
  let behavior: BehaviorConfigYaml | undefined;
  if (obj['behavior'] !== undefined && obj['behavior'] !== null) {
    behavior = validateBehavior(obj['behavior'], `${path}.behavior`, errors) ?? undefined;
    if (obj['behavior'] !== undefined && obj['behavior'] !== null && behavior === undefined) {
      // behavior validation failed but we can still proceed with the register
    }
  }

  return {
    name: obj['name'] as string,
    address: wireAddress,
    type: obj['type'] as 'uint16' | 'float32',
    initialValue: obj['initialValue'] as number,
    ...(behavior ? { behavior } : {}),
  };
}

function validateBehavior(
  raw: unknown,
  path: string,
  errors: ValidationError[]
): BehaviorConfigYaml | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push({ path, message: 'Behavior must be an object' });
    return null;
  }

  const obj = raw as Record<string, unknown>;

  if (obj['type'] === undefined || obj['type'] === null) {
    errors.push({ path: `${path}.type`, message: 'Required field "type" is missing' });
    return null;
  }

  if (typeof obj['type'] !== 'string' ||
      !(VALID_BEHAVIOR_TYPES as readonly string[]).includes(obj['type'])) {
    errors.push({
      path: `${path}.type`,
      message: `Field "type" must be one of: ${VALID_BEHAVIOR_TYPES.join(', ')}`,
    });
    return null;
  }

  const behaviorType = obj['type'] as 'sine' | 'ramp' | 'constant';
  const result: BehaviorConfigYaml = { type: behaviorType };

  switch (behaviorType) {
    case 'sine': {
      let valid = true;
      if (obj['min'] === undefined || obj['min'] === null) {
        errors.push({ path: `${path}.min`, message: 'Required field "min" is missing for sine behavior' });
        valid = false;
      } else if (typeof obj['min'] !== 'number') {
        errors.push({ path: `${path}.min`, message: 'Field "min" must be a number' });
        valid = false;
      }
      if (obj['max'] === undefined || obj['max'] === null) {
        errors.push({ path: `${path}.max`, message: 'Required field "max" is missing for sine behavior' });
        valid = false;
      } else if (typeof obj['max'] !== 'number') {
        errors.push({ path: `${path}.max`, message: 'Field "max" must be a number' });
        valid = false;
      }
      if (obj['periodMs'] === undefined || obj['periodMs'] === null) {
        errors.push({ path: `${path}.periodMs`, message: 'Required field "periodMs" is missing for sine behavior' });
        valid = false;
      } else if (typeof obj['periodMs'] !== 'number') {
        errors.push({ path: `${path}.periodMs`, message: 'Field "periodMs" must be a number' });
        valid = false;
      }
      if (!valid) return null;
      result.min = obj['min'] as number;
      result.max = obj['max'] as number;
      result.periodMs = obj['periodMs'] as number;
      break;
    }
    case 'ramp': {
      let valid = true;
      if (obj['start'] === undefined || obj['start'] === null) {
        errors.push({ path: `${path}.start`, message: 'Required field "start" is missing for ramp behavior' });
        valid = false;
      } else if (typeof obj['start'] !== 'number') {
        errors.push({ path: `${path}.start`, message: 'Field "start" must be a number' });
        valid = false;
      }
      if (obj['end'] === undefined || obj['end'] === null) {
        errors.push({ path: `${path}.end`, message: 'Required field "end" is missing for ramp behavior' });
        valid = false;
      } else if (typeof obj['end'] !== 'number') {
        errors.push({ path: `${path}.end`, message: 'Field "end" must be a number' });
        valid = false;
      }
      if (obj['durationMs'] === undefined || obj['durationMs'] === null) {
        errors.push({ path: `${path}.durationMs`, message: 'Required field "durationMs" is missing for ramp behavior' });
        valid = false;
      } else if (typeof obj['durationMs'] !== 'number') {
        errors.push({ path: `${path}.durationMs`, message: 'Field "durationMs" must be a number' });
        valid = false;
      }
      if (!valid) return null;
      result.start = obj['start'] as number;
      result.end = obj['end'] as number;
      result.durationMs = obj['durationMs'] as number;
      break;
    }
    case 'constant': {
      if (obj['value'] === undefined || obj['value'] === null) {
        errors.push({ path: `${path}.value`, message: 'Required field "value" is missing for constant behavior' });
        return null;
      } else if (typeof obj['value'] !== 'number') {
        errors.push({ path: `${path}.value`, message: 'Field "value" must be a number' });
        return null;
      }
      result.value = obj['value'] as number;
      break;
    }
  }

  return result;
}

/**
 * Detect overlapping wire address ranges among registers within a device.
 * Float32 registers occupy 2 consecutive addresses. (Req 9.1, 9.2, 9.3)
 */
function detectOverlaps(
  registers: RegisterConfig[],
  devicePath: string,
  errors: ValidationError[]
): void {
  interface RegisterRange {
    name: string;
    start: number;
    end: number; // inclusive
  }

  const ranges: RegisterRange[] = registers.map((reg) => {
    const wordCount = reg.type === 'float32' ? 2 : 1;
    return {
      name: reg.name,
      start: reg.address,
      end: reg.address + wordCount - 1,
    };
  });

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i];
      const b = ranges[j];
      if (a.start <= b.end && b.start <= a.end) {
        // Compute overlapping addresses
        const overlapStart = Math.max(a.start, b.start);
        const overlapEnd = Math.min(a.end, b.end);
        const conflicting: number[] = [];
        for (let addr = overlapStart; addr <= overlapEnd; addr++) {
          conflicting.push(addr);
        }
        errors.push({
          path: `${devicePath}.registers`,
          message: `Registers "${a.name}" and "${b.name}" overlap at address(es) ${conflicting.join(', ')}`,
        });
      }
    }
  }
}

function validateScenario(
  raw: unknown,
  devices: DeviceConfig[] | null,
  errors: ValidationError[]
): ScenarioEntryConfig[] | null {
  if (raw === undefined || raw === null) {
    errors.push({ path: 'scenario', message: 'Required field "scenario" is missing' });
    return null;
  }

  if (!Array.isArray(raw)) {
    errors.push({ path: 'scenario', message: 'Field "scenario" must be an array' });
    return null;
  }

  // Build set of valid targets: device names + "deviceName.registerName"
  const validTargets = new Set<string>();
  if (devices) {
    for (const device of devices) {
      validTargets.add(device.name);
      for (const reg of device.registers) {
        validTargets.add(`${device.name}.${reg.name}`);
      }
    }
  }

  const entries: ScenarioEntryConfig[] = [];
  let allValid = true;

  for (let i = 0; i < raw.length; i++) {
    const entry = validateScenarioEntry(raw[i], `scenario[${i}]`, validTargets, errors);
    if (entry) {
      entries.push(entry);
    } else {
      allValid = false;
    }
  }

  if (!allValid && entries.length === 0) return null;
  return entries;
}

function validateScenarioEntry(
  raw: unknown,
  path: string,
  validTargets: Set<string>,
  errors: ValidationError[]
): ScenarioEntryConfig | null {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ path, message: 'Scenario entry must be an object' });
    return null;
  }

  const obj = raw as Record<string, unknown>;
  let valid = true;

  // offsetMs
  if (obj['offsetMs'] === undefined || obj['offsetMs'] === null) {
    errors.push({ path: `${path}.offsetMs`, message: 'Required field "offsetMs" is missing' });
    valid = false;
  } else if (typeof obj['offsetMs'] !== 'number') {
    errors.push({ path: `${path}.offsetMs`, message: 'Field "offsetMs" must be a number' });
    valid = false;
  }

  // fault
  if (obj['fault'] === undefined || obj['fault'] === null) {
    errors.push({ path: `${path}.fault`, message: 'Required field "fault" is missing' });
    valid = false;
  } else if (typeof obj['fault'] !== 'string' ||
             !(VALID_FAULT_TYPES as readonly string[]).includes(obj['fault'])) {
    errors.push({
      path: `${path}.fault`,
      message: `Invalid fault type "${obj['fault']}"; must be one of: ${VALID_FAULT_TYPES.join(', ')}`,
    });
    valid = false;
  }

  // target
  if (obj['target'] === undefined || obj['target'] === null) {
    errors.push({ path: `${path}.target`, message: 'Required field "target" is missing' });
    valid = false;
  } else if (typeof obj['target'] !== 'string') {
    errors.push({ path: `${path}.target`, message: 'Field "target" must be a string' });
    valid = false;
  } else if (validTargets.size > 0 && !validTargets.has(obj['target'] as string)) {
    errors.push({
      path: `${path}.target`,
      message: `Target "${obj['target']}" does not match any configured device or register`,
    });
    valid = false;
  }

  // Optional: delayMs
  if (obj['delayMs'] !== undefined && obj['delayMs'] !== null) {
    if (typeof obj['delayMs'] !== 'number') {
      errors.push({ path: `${path}.delayMs`, message: 'Field "delayMs" must be a number' });
      valid = false;
    }
  }

  // Optional: durationMs
  if (obj['durationMs'] !== undefined && obj['durationMs'] !== null) {
    if (typeof obj['durationMs'] !== 'number') {
      errors.push({ path: `${path}.durationMs`, message: 'Field "durationMs" must be a number' });
      valid = false;
    }
  }

  if (!valid) return null;

  const result: ScenarioEntryConfig = {
    offsetMs: obj['offsetMs'] as number,
    fault: obj['fault'] as FaultType,
    target: obj['target'] as string,
  };

  if (obj['delayMs'] !== undefined && obj['delayMs'] !== null) {
    result.delayMs = obj['delayMs'] as number;
  }
  if (obj['durationMs'] !== undefined && obj['durationMs'] !== null) {
    result.durationMs = obj['durationMs'] as number;
  }

  return result;
}
