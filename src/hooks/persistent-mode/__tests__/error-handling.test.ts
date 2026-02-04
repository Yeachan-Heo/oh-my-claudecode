/**
 * Tests for issue #319: Stop hook error handling
 * Ensures the persistent-mode hook doesn't hang on errors
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';

const HOOK_PATH = join(__dirname, '../../../../templates/hooks/persistent-mode.mjs');
const TIMEOUT_MS = 3000;

describe('persistent-mode hook error handling (issue #319)', () => {
  it('should return continue:true on empty valid input without hanging', async () => {
    const result = await runHook('{}');
    expect(result.output).toContain('continue');
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('should return continue:true on broken stdin without hanging', async () => {
    const result = await runHook('', true); // Empty stdin, close immediately
    expect(result.output).toContain('continue');
    expect(result.timedOut).toBe(false);
  });

  it('should return continue:true on invalid JSON without hanging', async () => {
    const result = await runHook('invalid json{{{');
    expect(result.output).toContain('continue');
    expect(result.timedOut).toBe(false);
  });

  it('should complete within timeout even on errors', async () => {
    const result = await runHook('{"malformed": }');
    expect(result.timedOut).toBe(false);
    expect(result.duration).toBeLessThan(TIMEOUT_MS);
  });
});

interface HookResult {
  output: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  duration: number;
}

function runHook(input: string, closeImmediately = false): Promise<HookResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const proc = spawn('node', [HOOK_PATH]);

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
