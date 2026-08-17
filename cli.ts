/**
 * CLI entrypoint for modbus-fault-sim.
 *
 * Parses command-line arguments, loads configuration, starts the TCP server,
 * begins the scenario timeline, and handles graceful shutdown.
 *
 * Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.5, 17.6
 */

import { loadConfig } from './config/loader.js';
import type { ConfigFile, DeviceConfig, RegisterConfig, ScenarioEntryConfig, ValidationError } from './config/schema.js';
import { TcpServer } from './server/tcp-server.js';
import { handleConnection } from './server/connection-handler.js';
import { FaultEngine } from './faults/fault-engine.js';
import { ScenarioScheduler, type ScenarioEntry } from './faults/scenario-scheduler.js';
import { RegisterStore, type RegisterDescriptor } from './signals/register-store.js';
import type { Device } from './protocol/router.js';
import type { BehaviorConfig } from './signals/behaviors.js';

/**
 * Convert a BehaviorConfigYaml to a BehaviorConfig runtime type.
 */
function toBehaviorConfig(yaml: RegisterConfig['behavior']): BehaviorConfig | undefined {
  if (!yaml) return undefined;

  switch (yaml.type) {
    case 'sine':
      return {
        type: 'sine',
        params: { min: yaml.min!, max: yaml.max!, periodMs: yaml.periodMs! },
      };
    case 'ramp':
      return {
        type: 'ramp',
        params: { start: yaml.start!, end: yaml.end!, durationMs: yaml.durationMs! },
      };
    case 'constant':
      return {
        type: 'constant',
        params: { value: yaml.value! },
      };
  }
}

/**
 * Build runtime Device objects from validated config.
 */
function buildDevices(
  config: ConfigFile,
  clock: () => number,
): Map<number, Device> {
  const devices = new Map<number, Device>();

  for (const deviceConfig of config.devices) {
    const descriptors: RegisterDescriptor[] = deviceConfig.registers.map((reg) => ({
      name: reg.name,
      address: reg.address,
      type: reg.type,
      initialValue: reg.initialValue,
      behavior: toBehaviorConfig(reg.behavior),
    }));

    const store = new RegisterStore(descriptors, clock);
    devices.set(deviceConfig.unitId, { unitId: deviceConfig.unitId, store });
  }

  return devices;
}

/**
 * Build the unitId lookup for scenario targets.
 * Scenario targets use "deviceName" or "unitId:registerName" format for the fault engine.
 */
function buildScenarioEntries(
  config: ConfigFile,
): ScenarioEntry[] {
  // Build lookup: device name → unitId
  const deviceNameToUnitId = new Map<string, number>();
  for (const device of config.devices) {
    deviceNameToUnitId.set(device.name, device.unitId);
  }

  return config.scenario.map((entry) => {
    const params: Record<string, unknown> = {};
    if (entry.delayMs !== undefined) {
      params.delayMs = entry.delayMs;
    }

    // Resolve target to the format expected by FaultEngine:
    // - For freeze_register: "unitId:registerName"
    // - For slow_response/connection_drop: "unitId" (as string)
    let target = entry.target;
    if (entry.fault === 'freeze_register') {
      // Target is "deviceName.registerName" → "unitId:registerName"
      const dotIndex = entry.target.indexOf('.');
      if (dotIndex !== -1) {
        const deviceName = entry.target.substring(0, dotIndex);
        const registerName = entry.target.substring(dotIndex + 1);
        const unitId = deviceNameToUnitId.get(deviceName);
        if (unitId !== undefined) {
          target = `${unitId}:${registerName}`;
        }
      }
    } else {
      // Target may be "deviceName" or "deviceName.registerName"
      // In both cases, resolve to unitId as string for FaultEngine
      const dotIndex = entry.target.indexOf('.');
      const deviceName = dotIndex !== -1 ? entry.target.substring(0, dotIndex) : entry.target;
      const unitId = deviceNameToUnitId.get(deviceName);
      if (unitId !== undefined) {
        target = String(unitId);
      }
    }

    return {
      offsetMs: entry.offsetMs,
      faultType: entry.fault,
      target,
      params,
      duration: entry.durationMs,
    };
  });
}

/**
 * Main CLI entrypoint.
 *
 * @param args - Command-line arguments (process.argv.slice(2))
 */
export async function main(args: string[]): Promise<void> {
  // Req 17.4: No arguments → usage message
  if (args.length === 0) {
    process.stderr.write('Usage: modbus-fault-sim <config-file>\n');
    process.exitCode = 1;
    return;
  }

  const configPath = args[0];

  // Load and validate configuration
  const result = loadConfig(configPath);

  // Req 17.2 & 17.3: Handle errors
  if (Array.isArray(result)) {
    const errors = result as ValidationError[];
    for (const err of errors) {
      process.stderr.write(`${err.path}: ${err.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const config = result as ConfigFile;

  // Set up injectable clock: elapsed ms since server start
  const startTime = Date.now();
  const clock = (): number => Date.now() - startTime;

  // Build runtime structures
  const devices = buildDevices(config, clock);

  // Build fault engine (needs stores map for freeze delegation)
  const stores = new Map<number, RegisterStore>();
  for (const [unitId, device] of devices) {
    stores.set(unitId, device.store);
  }
  const faultEngine = new FaultEngine(stores, clock);

  // Build scenario entries
  const scenarioEntries = buildScenarioEntries(config);

  // Create scenario scheduler
  const scheduler = new ScenarioScheduler(
    scenarioEntries,
    faultEngine,
    clock,
    (msg: string) => process.stdout.write(msg + '\n'),
  );

  // Create TCP server
  const server = new TcpServer({
    host: config.listen.host,
    port: config.listen.port,
    onConnection: (socket) => handleConnection(socket, devices, faultEngine),
  });

  // Graceful shutdown handler (Req 17.5, 17.6)
  let shutdownInProgress = false;

  const shutdown = (): void => {
    if (shutdownInProgress) {
      // Req 17.6: Already exiting, just exit 0
      process.exitCode = 0;
      process.exit(0);
      return;
    }
    shutdownInProgress = true;

    // Cancel scenario timers
    scheduler.stop();

    // Attempt graceful close within 5 seconds
    const forceTimeout = setTimeout(() => {
      // Force-terminate all connections after 5s grace period
      server.closeAllConnections();
      process.exitCode = 0;
      process.exit(0);
    }, 5000);

    // Don't let the timeout prevent exit if server closes cleanly
    forceTimeout.unref();

    server.stop().then(() => {
      clearTimeout(forceTimeout);
      process.exitCode = 0;
      process.exit(0);
    }).catch(() => {
      clearTimeout(forceTimeout);
      process.exitCode = 0;
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start the server
  await server.start();

  // Req 17.1: Print ready message
  const addr = server.address();
  const host = addr?.address ?? config.listen.host;
  const port = addr?.port ?? config.listen.port;
  process.stdout.write(`Modbus fault simulator listening on ${host}:${port}\n`);

  // Begin scenario timeline
  scheduler.start();
}

// Invoke main at module level
main(process.argv.slice(2));
