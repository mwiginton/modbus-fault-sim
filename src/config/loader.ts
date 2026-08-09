/**
 * Configuration loader for modbus-fault-sim.
 * Orchestrates YAML parsing, validation, and conversion to runtime structures.
 *
 * Validates: Requirements 7.1, 7.2, 7.3
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { validateConfig } from './validator.js';
import type { ConfigFile, ValidationError } from './schema.js';

/**
 * Load and validate a YAML configuration file.
 *
 * @param filePath - Path to the YAML configuration file
 * @returns A valid ConfigFile object, or an array of ValidationError objects
 */
export function loadConfig(filePath: string): ConfigFile | ValidationError[] {
  // Step 1: Read file from disk
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const message =
      err instanceof Error ? `File not found: ${err.message}` : `File not found: ${filePath}`;
    return [{ path: filePath, message }];
  }

  // Step 2: Parse YAML
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err: unknown) {
    let message = 'YAML parse error';
    if (err instanceof Error) {
      message = `YAML parse error: ${err.message}`;
    }
    return [{ path: filePath, message }];
  }

  // Step 3: Validate parsed object
  return validateConfig(parsed);
}
