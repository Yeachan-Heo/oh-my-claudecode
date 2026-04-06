/**
 * Integration test: tmux env var forwarding
 *
 * Verifies that env vars set on the omc process actually arrive inside
 * a tmux session created the same way runClaudeOutsideTmux does.
 * No Claude CLI or API tokens are involved — the test runs `printenv`
 * inside the tmux pane and reads the output from a temp file.
 *
 * Skipped when tmux is not available (CI without tmux, Windows, etc.).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { wrapWithLoginShell, quoteShellArg } from '../tmux-utils.js';
import { buildEnvExportPrefix } from '../launch.js';

function isTmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_TMUX = isTmuxAvailable();

describe.skipIf(!HAS_TMUX)('tmux env forwarding — integration', () => {
  const SESSION_NAME = `omc-env-test-${Date.now()}`;
  let tempDir: string;
  let outFile: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-tmux-env-'));
    outFile = join(tempDir, 'env-output');
  });

  afterAll(() => {
    // Kill session if it still exists
    try {
      execFileSync('tmux', ['kill-session', '-t', SESSION_NAME], { stdio: 'ignore' });
    } catch { /* already gone */ }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('CLAUDE_CONFIG_DIR set via buildEnvExportPrefix reaches the tmux pane', () => {
    const testValue = '/tmp/omc-test-config-dir';

    // Build the env export prefix the same way runClaudeOutsideTmux does,
    // but with a controlled env snapshot instead of process.env
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = testValue;
    const envPrefix = buildEnvExportPrefix(['CLAUDE_CONFIG_DIR']);
    // Restore immediately — we only needed it for the prefix string
    if (savedConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }

    // Build command: export env, then write CLAUDE_CONFIG_DIR to file
    const innerCmd = `${envPrefix}printenv CLAUDE_CONFIG_DIR > ${quoteShellArg(outFile)}`;
    const shellCmd = wrapWithLoginShell(innerCmd);

    // Create a detached tmux session (same as runClaudeOutsideTmux)
    execFileSync('tmux', [
      'new-session', '-d', '-s', SESSION_NAME, shellCmd,
    ]);

    // Wait for the command to finish (it's just a printenv, should be instant)
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      // Session disappears once the command exits
      try {
        execFileSync('tmux', ['has-session', '-t', SESSION_NAME], { stdio: 'ignore' });
        // Still running, wait a bit
        execFileSync('sleep', ['0.1']);
      } catch {
        // Session gone — command finished
        break;
      }
    }

    expect(existsSync(outFile)).toBe(true);
    const result = readFileSync(outFile, 'utf-8').trim();
    expect(result).toBe(testValue);
  });

  it('values with spaces and special chars survive quoting through tmux', () => {
    const testValue = "/tmp/path with spaces/it's-a-test";
    const specialOutFile = join(tempDir, 'env-special');
    const specialSession = `${SESSION_NAME}-special`;

    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = testValue;
    const envPrefix = buildEnvExportPrefix(['CLAUDE_CONFIG_DIR']);
    if (savedConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }

    const innerCmd = `${envPrefix}printenv CLAUDE_CONFIG_DIR > ${quoteShellArg(specialOutFile)}`;
    const shellCmd = wrapWithLoginShell(innerCmd);

    try {
      execFileSync('tmux', [
        'new-session', '-d', '-s', specialSession, shellCmd,
      ]);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          execFileSync('tmux', ['has-session', '-t', specialSession], { stdio: 'ignore' });
          execFileSync('sleep', ['0.1']);
        } catch {
          break;
        }
      }

      expect(existsSync(specialOutFile)).toBe(true);
      const result = readFileSync(specialOutFile, 'utf-8').trim();
      expect(result).toBe(testValue);
    } finally {
      try {
        execFileSync('tmux', ['kill-session', '-t', specialSession], { stdio: 'ignore' });
      } catch { /* already gone */ }
    }
  });
});
