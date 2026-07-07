/**
 * Tests for issue #319: Stop hook error handling
 * Ensures the persistent-mode hook doesn't hang on errors
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const TEMPLATE_HOOK_PATH = join(__dirname, '../../../../templates/hooks/persistent-mode.mjs');
const SCRIPT_HOOK_PATH = join(__dirname, '../../../../scripts/persistent-mode.mjs');
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
    for (const hookPath of [TEMPLATE_HOOK_PATH, SCRIPT_HOOK_PATH]) {
      const result = await runHook('invalid json{{{', { hookPath });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output)).toEqual({ continue: true, suppressOutput: true });
    }
  });

  it('should complete within timeout even on errors', async () => {
    const result = await runHook('{"malformed": }');
    expect(result.timedOut).toBe(false);
    expect(result.duration).toBeLessThan(TIMEOUT_MS);
  });

  it('bounds execution when stdin stays open', async () => {
    for (const hookPath of [TEMPLATE_HOOK_PATH, SCRIPT_HOOK_PATH]) {
      const result = await runHook('{"cwd":"."}', {
        hookPath,
        closeStdin: false,
        env: { OMC_PERSISTENT_MODE_TIMEOUT_MS: '250' },
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.duration).toBeLessThan(TIMEOUT_MS);
      expect(JSON.parse(result.output)).toEqual({ continue: true, suppressOutput: true });
    }
  });

  it('honors persistent-mode environment skip before reading stdin', async () => {
    const skipEnvs: Array<Record<string, string>> = [
      { DISABLE_OMC: '1' },
      { OMC_SKIP_HOOKS: 'other,persistent-mode' },
      { OMC_SKIP_HOOKS: 'other,stop-continuation' },
    ];
    for (const hookPath of [TEMPLATE_HOOK_PATH, SCRIPT_HOOK_PATH]) {
      for (const env of skipEnvs) {
        const result = await runHook('{"cwd":"."}', {
          hookPath,
          closeStdin: false,
          env,
        });

        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(result.duration).toBeLessThan(1000);
        expect(JSON.parse(result.output)).toEqual({ continue: true, suppressOutput: true });
      }
    }
  });

  it('keeps the default safety timeout below the shipped Stop hook wrapper kill', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '../../../../hooks/hooks.json'), 'utf-8'));
    const stopHook = manifest.hooks.Stop[0].hooks.find((hook: { command?: string }) =>
      hook.command?.includes('/scripts/persistent-mode.mjs'),
    );
    expect(stopHook?.timeout).toBe(10);

    const wrapperKillMs = stopHook.timeout * 1000 - 500;
    for (const hookPath of [TEMPLATE_HOOK_PATH, SCRIPT_HOOK_PATH]) {
      expect(readDefaultSafetyTimeoutMs(hookPath)).toBeLessThan(wrapperKillMs);
    }
  });

  it('registers watchdog handlers before top-level awaited dynamic imports', () => {
    for (const hookPath of [TEMPLATE_HOOK_PATH, SCRIPT_HOOK_PATH]) {
      const source = readFileSync(hookPath, 'utf-8');
      const timeoutIndex = source.indexOf('const safetyTimeout = setTimeout');
      const handlerIndex = source.indexOf('process.on("uncaughtException"');
      const dynamicImportIndex = source.indexOf('await import(pathToFileURL(join(__dirname, "lib", "config-dir.mjs"))');

      expect(timeoutIndex).toBeGreaterThan(-1);
      expect(handlerIndex).toBeGreaterThan(timeoutIndex);
      expect(dynamicImportIndex).toBeGreaterThan(handlerIndex);
    }
  });
});

interface HookResult {
  output: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  duration: number;
}

function readDefaultSafetyTimeoutMs(hookPath: string): number {
  const source = readFileSync(hookPath, 'utf-8');
  const match = source.match(/const DEFAULT_SAFETY_TIMEOUT_MS = (\d+);/);
  if (!match) throw new Error(`Missing DEFAULT_SAFETY_TIMEOUT_MS in ${hookPath}`);
  return Number(match[1]);
}

function runHook(
  input: string,
  options: boolean | { hookPath?: string; closeStdin?: boolean; env?: Record<string, string> } = {},
): Promise<HookResult> {
  const normalized = typeof options === 'boolean'
    ? { closeStdin: options }
    : options;
  const hookPath = normalized.hookPath ?? TEMPLATE_HOOK_PATH;
  const closeStdin = normalized.closeStdin ?? true;

  return new Promise((resolve) => {
    const startTime = Date.now();
    const proc = spawn('node', [hookPath], {
      env: { ...process.env, ...normalized.env },
    });

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

    if (input) {
      proc.stdin.write(input);
    }
    if (closeStdin) {
      proc.stdin.end();
    }
  });
}
