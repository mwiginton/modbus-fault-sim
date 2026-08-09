/**
 * Tests for config/loader.ts
 * Validates: Requirements 7.1, 7.2, 7.3
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'modbus-fault-sim-loader-test-' + Date.now());

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeTestFile(name: string, content: string): string {
  const filePath = join(TEST_DIR, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

const VALID_YAML = `
listen:
  host: "127.0.0.1"
  port: 5020

devices:
  - name: "pump-1"
    unitId: 1
    registers:
      - name: "speed"
        address: 0
        type: uint16
        initialValue: 100

scenario:
  - offsetMs: 1000
    fault: freeze_register
    target: "pump-1.speed"
`;

describe('loadConfig', () => {
  describe('valid config file', () => {
    it('loads and parses a valid YAML config file successfully', () => {
      const filePath = writeTestFile('valid.yaml', VALID_YAML);
      const result = loadConfig(filePath);

      // Should return a ConfigFile, not an error array
      expect(Array.isArray(result)).toBe(false);
      expect(result).toHaveProperty('listen');
      expect(result).toHaveProperty('devices');
      expect(result).toHaveProperty('scenario');

      if (!Array.isArray(result)) {
        expect(result.listen.host).toBe('127.0.0.1');
        expect(result.listen.port).toBe(5020);
        expect(result.devices).toHaveLength(1);
        expect(result.devices[0].name).toBe('pump-1');
        expect(result.scenario).toHaveLength(1);
        expect(result.scenario[0].fault).toBe('freeze_register');
      }
    });
  });

  describe('file-not-found error', () => {
    it('returns a ValidationError when the file does not exist', () => {
      const result = loadConfig('/nonexistent/path/config.yaml');

      expect(Array.isArray(result)).toBe(true);
      if (Array.isArray(result)) {
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].path).toContain('/nonexistent/path/config.yaml');
        expect(result[0].message).toMatch(/not found|ENOENT|no such file/i);
      }
    });
  });

  describe('YAML syntax error', () => {
    it('returns a ValidationError when the YAML is malformed', () => {
      const badYaml = `
listen:
  host: "127.0.0.1"
  port: [invalid
    unclosed bracket
`;
      const filePath = writeTestFile('bad-syntax.yaml', badYaml);
      const result = loadConfig(filePath);

      expect(Array.isArray(result)).toBe(true);
      if (Array.isArray(result)) {
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].message).toMatch(/yaml|parse|syntax/i);
      }
    });
  });

  describe('invalid config content', () => {
    it('returns validation errors when required fields are missing', () => {
      const incompleteYaml = `
listen:
  host: "127.0.0.1"
`;
      const filePath = writeTestFile('incomplete.yaml', incompleteYaml);
      const result = loadConfig(filePath);

      expect(Array.isArray(result)).toBe(true);
      if (Array.isArray(result)) {
        expect(result.length).toBeGreaterThan(0);
        // Should report missing port, devices, scenario
        const messages = result.map((e) => e.message).join(' ');
        expect(messages).toMatch(/port|devices|scenario/i);
      }
    });
  });
});
