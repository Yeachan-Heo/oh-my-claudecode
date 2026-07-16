import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const runCjs = require('../../scripts/run.cjs');
const RUN_CJS_PATH = join(process.cwd(), 'scripts', 'run.cjs');
const HUNG_PARENT = join(process.cwd(), 'src', '__tests__', 'fixtures', 'hung-hooks', 'hung-parent.cjs');

function withWatchdog<T>(promise: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`runGenericChild exceeded ${timeoutMs}ms watchdog`)), timeoutMs);
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

function killIfAlive(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already dead */ }
}

async function waitForDeath(pid: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`PID ${pid} survived process-tree reap`);
}

describe('run.cjs generic hook timeout supervisor', () => {
  it('exports generic timeout resolution without dispatching when required', () => {
    expect(runCjs.DEFAULT_GENERIC_TIMEOUT_MS).toBe(59500);
    expect(runCjs.resolveGenericTimeoutMs(null)).toBe(59500);
    const manifestHook = { timeoutMs: 3000, event: 'PostToolUse' };
    expect(runCjs.resolveGenericTimeoutMs(manifestHook))
      .toBe(runCjs.resolveInnerTimeoutMs(manifestHook));
    expect(runCjs.resolveGenericTimeoutMs(manifestHook)).toBe(2500);
  });

  it('reaps a timed-out generic hook and its POSIX grandchild', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-hung-generic-'));
    const pidfile = join(directory, 'grandchild.pid');
    const previousPidfile = process.env.OMC_TEST_PIDFILE;
    let grandchildPid: number | undefined;
    process.env.OMC_TEST_PIDFILE = pidfile;
    try {
      const startedAt = Date.now();
      const status = await withWatchdog(runCjs.runGenericChild(HUNG_PARENT, [], 250, null));
      const elapsed = Date.now() - startedAt;
      expect(status).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(5000);
      grandchildPid = Number(readFileSync(pidfile, 'utf8'));
      expect(grandchildPid).toBeGreaterThan(0);
      if (process.platform !== 'win32') await waitForDeath(grandchildPid);
    } finally {
      if (previousPidfile === undefined) delete process.env.OMC_TEST_PIDFILE;
      else process.env.OMC_TEST_PIDFILE = previousPidfile;
      killIfAlive(grandchildPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('propagates numeric exits and fail-opens for signal exits and spawn errors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-generic-exit-'));
    try {
      const numericExit = join(directory, 'numeric-exit.cjs');
      const signalExit = join(directory, 'signal-exit.cjs');
      writeFileSync(numericExit, 'process.exit(3);');
      writeFileSync(signalExit, "process.kill(process.pid, 'SIGKILL');");

      await expect(withWatchdog(runCjs.runGenericChild(numericExit, [], 2000, null))).resolves.toBe(3);
      await expect(withWatchdog(runCjs.runGenericChild(signalExit, [], 2000, null))).resolves.toBe(0);
      const originalExecPath = process.execPath;
      Object.defineProperty(process, 'execPath', { configurable: true, value: join(directory, 'missing-node') });
      try {
        await expect(withWatchdog(runCjs.runGenericChild(join(directory, 'missing.cjs'), [], 2000, null))).resolves.toBe(0);
      } finally {
        Object.defineProperty(process, 'execPath', { configurable: true, value: originalExecPath });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('terminalizes once when a child exits after its timeout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-generic-late-'));
    const fixture = join(directory, 'late-exit.cjs');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    writeFileSync(fixture, 'setTimeout(() => process.exit(7), 150);');
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(withWatchdog(runCjs.runGenericChild(fixture, [], 50, null))).resolves.toBe(0);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reaps the detached hook tree when the runner is terminated before its timeout (POSIX)', async () => {
    if (process.platform === 'win32') return; // POSIX-only: exercises process-group reap. Killing the grandchild proves its whole group (incl. the direct hook child) was reaped. Windows programmatic SIGTERM force-terminates rather than delivering a catchable signal, so this outer-cancellation path is POSIX-specific.
    const directory = mkdtempSync(join(tmpdir(), 'omc-runner-cancel-'));
    const pidfile = join(directory, 'grandchild.pid');
    let grandchildPid: number | undefined;
    // Manifest-null target => the runner arms the 59500ms default timer; we terminate the
    // runner well before it fires, so only the new signal-handler reap can prevent an orphan.
    const runner = spawn(process.execPath, [RUN_CJS_PATH, HUNG_PARENT], {
      stdio: 'ignore',
      env: { ...process.env, OMC_TEST_PIDFILE: pidfile },
    });
    try {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !existsSync(pidfile)) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(existsSync(pidfile)).toBe(true);
      grandchildPid = Number(readFileSync(pidfile, 'utf8'));
      expect(grandchildPid).toBeGreaterThan(0);

      const runnerExit = new Promise<void>(resolve => runner.once('exit', () => resolve()));
      runner.kill('SIGTERM');
      await Promise.race([
        runnerExit,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('runner did not exit after SIGTERM')), 5000)),
      ]);
      await waitForDeath(grandchildPid);
    } finally {
      killIfAlive(grandchildPid);
      try { runner.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
