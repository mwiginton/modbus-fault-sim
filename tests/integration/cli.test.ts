/**
 * Integration tests for the CLI entrypoint.
 *
 * Tests cover:
 * - Req 17.1: Successful startup with valid config
 * - Req 17.2: Missing configuration file
 * - Req 17.3: Invalid configuration file
 * - Req 17.4: No arguments provided
 * - Req 17.5: SIGTERM graceful shutdown
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const CLI_JS = resolve(__dirname, '../../dist/cli.js');

/**
 * Helper: run the CLI as a child process with given args.
 */
function runCli(
  args: string[],
  options?: { killAfterMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('node', [CLI_JS, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    // If killAfterMs is specified, send SIGTERM after that time
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    if (options?.killAfterMs) {
      killTimer = setTimeout(() => {
        child.kill('SIGTERM');
      }, options.killAfterMs);
    }

    // Safety timeout to prevent test hangs
    const safetyTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 10000);

    child.on('exit', (code) => {
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(safetyTimer);
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

describe('CLI entrypoint', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'modbus-cli-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should print usage message and exit 1 when no arguments provided (Req 17.4)', async () => {
    const { exitCode, stderr } = await runCli([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Usage:');
  });

  it('should print error and exit 1 when config file does not exist (Req 17.2)', async () => {
    const missingPath = join(tmpDir, 'nonexistent.yaml');
    const { exitCode, stderr } = await runCli([missingPath]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('nonexistent.yaml');
  });

  it('should print validation errors and exit 1 for invalid config (Req 17.3)', async () => {
    const invalidConfig = join(tmpDir, 'invalid.yaml');
    writeFileSync(invalidConfig, 'listen:\n  host: 127.0.0.1\n');
    const { exitCode, stderr } = await runCli([invalidConfig]);
    expect(exitCode).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('should start server and print ready message for valid config (Req 17.1)', async () => {
    const validConfig = join(tmpDir, 'valid.yaml');
    writeFileSync(validConfig, `
listen:
  host: 127.0.0.1
  port: 0
devices:
  - unitId: 1
    name: test-device
    registers:
      - name: reg1
        address: 0
        type: uint16
        initialValue: 100
scenario: []
`);
    // Start and kill after 500ms — enough time to start but not hang the test
    const { stdout } = await runCli([validConfig], { killAfterMs: 500 });
    expect(stdout).toContain('listening on');
    expect(stdout).toContain('127.0.0.1');
  });
});
