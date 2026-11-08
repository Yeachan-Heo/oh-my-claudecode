import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const runCjs = require('../../scripts/run.cjs');
const RUN_CJS_PATH = join(process.cwd(), 'scripts', 'run.cjs');
const HUNG_PARENT = join(process.cwd(), 'src', '__tests__', 'fixtures', 'hung-hooks', 'hung-parent.cjs');
const EPIPE_EXIT_PARENT = join(process.cwd(), 'src', '__tests__', 'fixtures', 'hung-hooks', 'epipe-exit-parent.cjs');

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
    expect(runCjs.resolveGenericTimeoutMs(null, 'linux')).toBe(59500);
    expect(runCjs.resolveGenericTimeoutMs(null, 'win32')).toBe(58500);
    const manifestHook = { timeoutMs: 3000, event: 'PostToolUse' };
    expect(runCjs.resolveGenericTimeoutMs(manifestHook, 'linux'))
      .toBe(runCjs.resolveInnerTimeoutMs(manifestHook, 'linux'));
    expect(runCjs.resolveGenericTimeoutMs(manifestHook, 'linux')).toBe(2500);
    expect(runCjs.resolveGenericTimeoutMs(manifestHook, 'win32')).toBe(2500);
    const gitHook = { timeoutMs: 5000, event: 'PostToolUse' };
    const winGitInner = runCjs.resolveGenericTimeoutMs(gitHook, 'win32');
    expect(winGitInner).toBe(3500);
    expect(winGitInner).toBeGreaterThanOrEqual(
      runCjs.WINDOWS_GENERIC_STARTUP_MS + runCjs.NESTED_OPERATION_TIMEOUT_MS + runCjs.NESTED_OPERATION_MARGIN_MS,
    );
    expect(winGitInner).toBeGreaterThan(runCjs.NESTED_OPERATION_TIMEOUT_MS);
    expect(runCjs.resolveGenericTimeoutMs({ timeoutMs: 1000, event: 'PostToolUse' }, 'win32')).toBe(500);
    expect(runCjs.resolveGenericTimeoutMs({ timeoutMs: 1500, event: 'PostToolUse' }, 'win32')).toBe(1000);
    expect(runCjs.resolveGenericTimeoutMs({ timeoutMs: 2000, event: 'PostToolUse' }, 'win32')).toBe(1500);
    expect(runCjs.resolveGenericTimeoutMs({ timeoutMs: 1000, event: 'PostToolUse' }, 'win32'))
      .toBeGreaterThanOrEqual(runCjs.MIN_HOOK_INNER_MS);
  });

  it('uses the source-owned supervisor only for Windows generic hooks', () => {
    expect(runCjs.resolveGenericChildCommand(HUNG_PARENT, ['argument'], 'win32')).toEqual([
      RUN_CJS_PATH,
      '--generic-child-supervisor',
      HUNG_PARENT,
      'argument',
    ]);
    expect(runCjs.resolveGenericChildCommand(HUNG_PARENT, ['argument'], 'linux')).toEqual([
      HUNG_PARENT,
      'argument',
    ]);
    expect(runCjs.resolveGenericChildStdio('win32')).toEqual(['inherit', 'pipe', 'pipe', 'ipc']);
    expect(runCjs.resolveGenericChildStdio('linux')).toEqual(['inherit', 'pipe', 'pipe']);
  });

  it('releases the Windows supervisor IPC channel and protocol stdio after an inner timeout', () => {
    let disconnected = 0;
    let unreferenced = 0;
    let stdoutDestroyed = 0;
    let stderrDestroyed = 0;
    runCjs.releaseGenericChild({
      connected: true,
      disconnect: () => { disconnected += 1; },
      unref: () => { unreferenced += 1; },
      stdout: { unpipe: () => {}, destroy: () => { stdoutDestroyed += 1; } },
      stderr: { unpipe: () => {}, destroy: () => { stderrDestroyed += 1; } },
    });
    expect(disconnected).toBe(1);
    expect(unreferenced).toBe(1);
    expect(stdoutDestroyed).toBe(1);
    expect(stderrDestroyed).toBe(1);
  });

  it('reaps the supervised hook tree when its IPC parent disappears', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-supervisor-parent-death-'));
    const pidfile = join(directory, 'grandchild.pid');
    let grandchildPid: number | undefined;
    const supervisor = spawn(process.execPath, [RUN_CJS_PATH, '--generic-child-supervisor', HUNG_PARENT], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      detached: true,
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

      const supervisorExit = new Promise<void>(resolve => supervisor.once('exit', () => resolve()));
      supervisor.disconnect();
      await waitForDeath(grandchildPid);
      await Promise.race([
        supervisorExit,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('supervisor did not exit after IPC disconnect')), 5000)),
      ]);
    } finally {
      killIfAlive(grandchildPid);
      try { supervisor.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves normal child completion through the supervisor', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-supervisor-normal-exit-'));
    const fixture = join(directory, 'numeric-exit.cjs');
    writeFileSync(fixture, 'process.exit(3);');
    const supervisor = spawn(process.execPath, [RUN_CJS_PATH, '--generic-child-supervisor', fixture], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      detached: process.platform !== 'win32',
    });
    try {
      const code = await new Promise<number | null>(resolve => supervisor.once('exit', resolve));
      expect(code).toBe(3);
    } finally {
      try { supervisor.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves a shipped 2000ms nested operation inside a 3s Windows hook budget', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-three-second-nested-'));
    const marker = join(directory, 'nested-complete');
    const fixture = join(directory, 'nested-operation.cjs');
    writeFileSync(fixture, `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'); process.exit(0); }, 2000);`);
    try {
      const innerMs = runCjs.resolveGenericTimeoutMs({ timeoutMs: 3000, event: 'PostToolUse' }, 'win32');
      expect(innerMs).toBe(2500);
      await expect(withWatchdog(runCjs.runGenericChild(fixture, [], innerMs, null), 3000)).resolves.toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('done');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reaps a timed-out generic hook and its POSIX grandchild', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-hung-generic-'));
    const pidfile = join(directory, 'grandchild.pid');
    const previousPidfile = process.env.OMC_TEST_PIDFILE;
    let grandchildPid: number | undefined;
    process.env.OMC_TEST_PIDFILE = pidfile;
    try {
      const innerMs = 1500;
      const outerMs = 3000;
      const startedAt = Date.now();
      const status = await withWatchdog(runCjs.runGenericChild(HUNG_PARENT, [], innerMs, null), outerMs);
      const elapsed = Date.now() - startedAt;
      expect(status).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(innerMs - 400);
      expect(elapsed).toBeLessThan(outerMs);
      grandchildPid = Number(readFileSync(pidfile, 'utf8'));
      expect(grandchildPid).toBeGreaterThan(0);
      await waitForDeath(grandchildPid);
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
      // POSIX SIGKILL reports a null exit code (fail-open 0). Windows Node
      // terminates with a numeric status instead of a POSIX signal.
      if (process.platform === 'win32') {
        await expect(withWatchdog(runCjs.runGenericChild(signalExit, [], 2000, null))).resolves.toBe(1);
      } else {
        await expect(withWatchdog(runCjs.runGenericChild(signalExit, [], 2000, null))).resolves.toBe(0);
      }
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

  it('keeps cancellation reaping active while successful output is settling (POSIX)', async () => {
    if (process.platform === 'win32') return;
    const directory = mkdtempSync(join(tmpdir(), 'omc-runner-settle-cancel-'));
    const pidfile = join(directory, 'orphan.pid');
    const fixture = join(directory, 'success-parent.cjs');
    writeFileSync(fixture, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
writeFileSync(process.env.OMC_TEST_PIDFILE, String(child.pid));
process.stdout.write('hook-ok\\n');
process.exit(0);
`);
    let orphanPid: number | undefined;
    const runner = spawn(process.execPath, [RUN_CJS_PATH, fixture], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMC_TEST_PIDFILE: pidfile },
      windowsHide: true,
    });
    try {
      let stdout = '';
      runner.stdout!.setEncoding('utf8');
      runner.stdout!.on('data', chunk => { stdout += chunk; });
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && (!existsSync(pidfile) || !stdout.includes('hook-ok'))) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(existsSync(pidfile)).toBe(true);
      expect(stdout).toContain('hook-ok');
      orphanPid = Number(readFileSync(pidfile, 'utf8'));
      expect(orphanPid).toBeGreaterThan(0);

      const runnerExit = new Promise<void>(resolve => runner.once('exit', () => resolve()));
      runner.kill('SIGTERM');
      await Promise.race([
        runnerExit,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('settling runner ignored SIGTERM')), 3000)),
      ]);
      await waitForDeath(orphanPid);
    } finally {
      killIfAlive(orphanPid);
      try { runner.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('reaps grandchildren when the runner is cancelled while the hook is an active writer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-runner-cancel-epipe-'));
    const pidfile = join(directory, 'grandchild.pid');
    let grandchildPid: number | undefined;
    const runner = spawn(process.execPath, [RUN_CJS_PATH, EPIPE_EXIT_PARENT], {
      stdio: 'ignore',
      env: { ...process.env, OMC_TEST_PIDFILE: pidfile },
      windowsHide: true,
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
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/PID', String(runner.pid)], { windowsHide: true, stdio: 'ignore', timeout: 2000 });
      } else {
        runner.kill('SIGTERM');
      }
      await Promise.race([
        runnerExit,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('runner did not exit after cancel')), 5000)),
      ]);
      await waitForDeath(grandchildPid);
    } finally {
      killIfAlive(grandchildPid);
      try { runner.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
