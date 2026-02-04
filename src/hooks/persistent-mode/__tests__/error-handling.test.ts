/**
 * Tests for issue #319, #385: Stop hook error handling
 * Ensures the persistent-mode hook doesn't hang on errors
 *
 * Tests all three script variants:
 * - templates/hooks/persistent-mode.mjs (installed to ~/.claude/hooks/)
 * - scripts/persistent-mode.mjs (standalone ESM)
 * - scripts/persistent-mode.cjs (standalone CJS)
 *
 * Also tests stop-continuation.mjs for the same stdin hang issue.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');
const TEMPLATE_HOOK_PATH = join(PROJECT_ROOT, 'templates/hooks/persistent-mode.mjs');
const SCRIPTS_MJS_PATH = join(PROJECT_ROOT, 'scripts/persistent-mode.mjs');
const SCRIPTS_CJS_PATH = join(PROJECT_ROOT, 'scripts/persistent-mode.cjs');
const STOP_CONTINUATION_PATH = join(PROJECT_ROOT, 'templates/hooks/stop-continuation.mjs');
const TIMEOUT_MS = 6000;

interface HookResult {
  output: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  duration: number;
}

function runHook(hookPath: string, input: string, closeImmediately = false): Promise<HookResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const proc = spawn('node', [hookPath]);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 100);
    }, TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      resolve({
        output: stdout,
        stderr,
        exitCode: code,
        timedOut,
        duration
      });
    });

    if (closeImmediately) {
      proc.stdin.end();
    } else {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

describe('persistent-mode hook error handling (issue #319, #385)', () => {
  // Template version (templates/hooks/persistent-mode.mjs)
  describe('templates/hooks/persistent-mode.mjs', () => {
    it('should return continue:true on empty valid input without hanging', async () => {
      const result = await runHook(TEMPLATE_HOOK_PATH, '{}');
      expect(result.output).toContain('continue');
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    });

    it('should return continue:true on broken stdin without hanging', async () => {
      const result = await runHook(TEMPLATE_HOOK_PATH, '', true);
      expect(result.output).toContain('continue');
      expect(result.timedOut).toBe(false);
    });

    it('should return continue:true on invalid JSON without hanging', async () => {
      const result = await runHook(TEMPLATE_HOOK_PATH, 'invalid json{{{');
      expect(result.output).toContain('continue');
      expect(result.timedOut).toBe(false);
    });

    it('should complete within timeout even on errors', async () => {
      const result = await runHook(TEMPLATE_HOOK_PATH, '{"malformed": }');
      expect(result.timedOut).toBe(false);
      expect(result.duration).toBeLessThan(TIMEOUT_MS);
    });
  });

  // Scripts ESM version (scripts/persistent-mode.mjs)
  describe('scripts/persistent-mode.mjs (issue #385 fix)', () => {
    it('should exist', () => {
      expect(existsSync(SCRIPTS_MJS_PATH)).toBe(true);
    });

    it('should return continue:true on empty valid input without hanging', async () => {
      const result = await runHook(SCRIPTS_MJS_PATH, '{}');
      expect(result.output).toContain('continue');
      expect(result.timedOut).toBe(false);
    });

    it('should return continue:true on broken stdin without hanging', async () => {
      const result = await runHook(SCRIPTS_MJS_PATH, '', true);
      expect(result.output).toContain('continue');
      expect(result.timedOut).toBe(false);
    });

    it('should return continue:true on invalid JSON without hanging', async () => {
      const result = await runHook(SCRIPTS_MJS_PATH, 'invalid json{{{');
      expect(result.output).toContain('continue');
      expect(result.timedOut).toBe(false);
    });

    it('should complete within timeout', async () => {
      const result = await runHook(SCRIPTS_MJS_PATH, '{}');
      expect(result.timedOut).toBe(false);
      expect(result.duration).toBeLessThan(TIMEOUT_MS);
    });
  });

  // Scripts CJS version (scripts/persistent-mode.cjs)
  describe('scripts/persistent-mode.cjs (issue #385 fix)', () => {
    it('should exist', () => {
      expect(existsSync(SCRIPTS_CJS_PATH)).toBe(true);
    });

    it('should return continue:true on empty valid input without hanging', async () => {
      const result = await runHook(SCRIPTS_CJS_PATH, '{}');
      expect(result.output).toContain('continue');
      expect(result.timedOut).toBe(false);
    });

    it('should return continue:true on broken stdin without hanging', async () => {
      const result = await runHook(SCRIPTS_CJS_PATH, '', true);
      expect(result.output).toContain('continue');
      expect(result.timedOut).toBe(false);
    });

    it('should return continue:true on invalid JSON without hanging', async () => {
      const result = await runHook(SCRIPTS_CJS_PATH, 'invalid json{{{');
      expect(result.output).toContain('continue');
      expect(result.timedOut).toBe(false);
    });

    it('should complete within timeout', async () => {
      const result = await runHook(SCRIPTS_CJS_PATH, '{}');
      expect(result.timedOut).toBe(false);
      expect(result.duration).toBeLessThan(TIMEOUT_MS);
    });
  });
});

describe('stop-continuation hook (issue #385)', () => {
  it('should exist', () => {
    expect(existsSync(STOP_CONTINUATION_PATH)).toBe(true);
  });

  it('should return continue:true on empty stdin without hanging', async () => {
    const result = await runHook(STOP_CONTINUATION_PATH, '', true);
    expect(result.output).toContain('continue');
    expect(result.timedOut).toBe(false);
  });

  it('should return continue:true on valid input without hanging', async () => {
    const result = await runHook(STOP_CONTINUATION_PATH, '{}');
    expect(result.output).toContain('continue');
    expect(result.timedOut).toBe(false);
  });

  it('should complete within timeout', async () => {
    const result = await runHook(STOP_CONTINUATION_PATH, '{}');
    expect(result.timedOut).toBe(false);
    expect(result.duration).toBeLessThan(TIMEOUT_MS);
  });
});
