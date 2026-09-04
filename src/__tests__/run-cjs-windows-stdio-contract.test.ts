import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

const runCjs = require('../../scripts/run.cjs');
const RUN_CJS_PATH = join(process.cwd(), 'scripts', 'run.cjs');
const HUNG_PARENT = join(process.cwd(), 'src', '__tests__', 'fixtures', 'hung-hooks', 'hung-parent.cjs');
const DETACHED_ORPHAN = join(process.cwd(), 'src', '__tests__', 'fixtures', 'hung-hooks', 'detached-stdout-orphan.cjs');
const SUCCESS_ORPHAN = join(process.cwd(), 'src', '__tests__', 'fixtures', 'hung-hooks', 'success-parent-stdout-orphan.cjs');
const EPIPE_EXIT_PARENT = join(process.cwd(), 'src', '__tests__', 'fixtures', 'hung-hooks', 'epipe-exit-parent.cjs');

function killIfAlive(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already dead */ }
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        timeout: 2000,
        stdio: 'ignore',
      });
    } catch { /* already dead or taskkill unavailable */ }
  }
}

async function waitForDeath(pid: number, timeoutMs = 3000): Promise<void> {
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

async function waitForFile(path: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function writePluginHook(root: string, scriptName: string, source: string, timeoutSec: number): string {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  const target = join(root, 'scripts', scriptName);
  writeFileSync(target, source);
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      PostToolUse: [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/${scriptName}`,
          timeout: timeoutSec,
        }],
      }],
    },
  }));
  return target;
}
async function runDeclaredOrphan(declaredSec: number): Promise<{
  elapsed: number;
  stdout: string;
  stderr: string;
  orphanPid: number;
  stdoutEnded: boolean;
  exitCode: number | null;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-budget-'));
  const pidfile = join(directory, 'orphan.pid');
  const pluginRoot = join(directory, 'plugin');
  const declaredMs = Math.round(declaredSec * 1000);
  const target = writePluginHook(
    pluginRoot,
    'orphan-hook.cjs',
    readFileSync(DETACHED_ORPHAN, 'utf8'),
    declaredSec,
  );
  const startedAt = Date.now();
  const runner = spawn(process.execPath, [RUN_CJS_PATH, target], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OMC_TEST_PIDFILE: pidfile, CLAUDE_PLUGIN_ROOT: pluginRoot },
    windowsHide: true,
  });
  let orphanPid: number | undefined;
  try {
    let stdout = '';
    let stderr = '';
    let stdoutEnded = false;
    runner.stdout.setEncoding('utf8');
    runner.stderr.setEncoding('utf8');
    runner.stdout.on('data', chunk => { stdout += chunk; });
    runner.stderr.on('data', chunk => { stderr += chunk; });
    runner.stdout.on('end', () => { stdoutEnded = true; });
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`run.cjs exceeded declared ${declaredMs}ms outer budget`)),
        declaredMs,
      );
      runner.once('exit', code => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    await waitForFile(pidfile, declaredMs);
    orphanPid = Number(readFileSync(pidfile, 'utf8'));
    const exitCode = await exitPromise;
    await new Promise(resolve => setTimeout(resolve, 50));
    return {
      elapsed: Date.now() - startedAt,
      stdout,
      stderr,
      orphanPid,
      stdoutEnded,
      exitCode,
    };
  } finally {
    killIfAlive(orphanPid);
    try { runner.kill('SIGKILL'); } catch { /* already gone */ }
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('run.cjs Windows/protocol stdio contract (#3920)', () => {
  it('never hands protocol stdout/stderr to a process that can outlive the runner', () => {
    expect(runCjs.resolveGenericChildStdio('win32')).toEqual(['inherit', 'pipe', 'pipe', 'ipc']);
    expect(runCjs.resolveGenericChildStdio('linux')).toEqual(['inherit', 'pipe', 'pipe']);
    expect(runCjs.resolveGenericChildStdio('darwin')).toEqual(['inherit', 'pipe', 'pipe']);
  });

  it('keeps a usable inner timeout inside the declared hook budget', () => {
    const cases = [
      { timeoutMs: 1000, event: 'PostToolUse', win32: 500, linux: 500 },
      { timeoutMs: 1500, event: 'PostToolUse', win32: 1000, linux: 1000 },
      { timeoutMs: 2000, event: 'PostToolUse', win32: 1500, linux: 1500 },
      { timeoutMs: 3000, event: 'PostToolUse', win32: 2500, linux: 2500 },
      { timeoutMs: 5000, event: 'PostToolUse', win32: 3500, linux: 4500 },
      { timeoutMs: 10000, event: 'PostToolUse', win32: 8500, linux: 9500 },
      { timeoutMs: 60000, event: 'PostToolUse', win32: 58500, linux: 59500 },
    ] as const;
    for (const row of cases) {
      const winInner = runCjs.resolveGenericTimeoutMs({ timeoutMs: row.timeoutMs, event: row.event }, 'win32');
      const posixInner = runCjs.resolveGenericTimeoutMs({ timeoutMs: row.timeoutMs, event: row.event }, 'linux');
      expect(winInner, `win32 inner for ${row.timeoutMs}`).toBe(row.win32);
      expect(posixInner, `linux inner for ${row.timeoutMs}`).toBe(row.linux);
      expect(winInner).toBeGreaterThanOrEqual(Math.min(row.timeoutMs - 1, runCjs.MIN_HOOK_INNER_MS));
      expect(winInner / row.timeoutMs).toBeGreaterThanOrEqual(runCjs.MIN_HOOK_INNER_FRACTION);
      expect(row.timeoutMs - winInner).toBeLessThanOrEqual(runCjs.WINDOWS_TIMEOUT_CUSHION_MS);
    }
    const gitInner = runCjs.resolveGenericTimeoutMs({ timeoutMs: 5000, event: 'PostToolUse' }, 'win32');
    expect(runCjs.NESTED_OPERATION_TIMEOUT_MS).toBe(2000);
    expect(gitInner).toBeGreaterThan(runCjs.NESTED_OPERATION_TIMEOUT_MS);
    expect(gitInner).toBeGreaterThanOrEqual(runCjs.NESTED_INNER_FLOOR_MS);
    expect(runCjs.resolveGenericTimeoutMs({ timeoutMs: 3000, event: 'PostToolUse' }, 'win32'))
      .toBeGreaterThan(runCjs.NESTED_OPERATION_TIMEOUT_MS);
    expect(runCjs.resolveGenericTimeoutMs(null, 'win32')).toBe(58500);
    expect(runCjs.resolveGenericTimeoutMs(null, 'linux')).toBe(59500);
  });

  it('keeps every shipped 3s hook visible to the short-budget contract', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string; timeout?: number }> }>>;
    };
    const commands = Object.values(manifest.hooks)
      .flatMap(groups => groups)
      .flatMap(group => group.hooks ?? [])
      .filter(hook => hook.timeout === 3)
      .map(hook => [...(hook.command ?? '').matchAll(/scripts[/\\]([^"\s]+)/g)].at(-1)?.[1])
      .filter((name): name is string => Boolean(name))
      .sort();
    expect(commands).toEqual([
      'post-tool-rules-injector.mjs',
      'post-tool-use-failure.mjs',
      'project-memory-posttool.mjs',
      'subagent-tracker.mjs',
      'wiki-pre-compact.mjs',
      'workflow-drift-guard.mjs',
    ]);
  });
  it('fail-opens inside a 1s declared budget without requiring cold-start completion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-one-second-'));
    try {
      const pluginRoot = join(directory, 'plugin');
      const target = writePluginHook(pluginRoot, 'hang-hook.cjs', 'setInterval(() => {}, 1e9);', 1);
      const startedAt = Date.now();
      const result = spawnSync(process.execPath, [RUN_CJS_PATH, target], {
        encoding: 'utf8',
        timeout: 1000,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        windowsHide: true,
      });
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(result.stderr).toMatch(/timed out after 500ms; exiting fail-open/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([1.5, 2, 3, 5])('spawns a grandchild and exits inside a %ss declared outer budget', async (declaredSec) => {
    const declaredMs = Math.round(declaredSec * 1000);
    const result = await runDeclaredOrphan(declaredSec);
    expect(result.exitCode).toBe(0);
    expect(result.orphanPid).toBeGreaterThan(0);
    expect(result.elapsed).toBeLessThan(declaredMs);
    expect(result.stdoutEnded).toBe(true);
    expect(result.stdout).toContain('hook-ready');
    expect(result.stderr).toMatch(/timed out after \d+ms; exiting fail-open/);
    const inner = runCjs.resolveGenericTimeoutMs({ timeoutMs: declaredMs, event: 'PostToolUse' });
    expect(inner).toBeGreaterThanOrEqual(runCjs.MIN_HOOK_INNER_MS);
    expect(result.elapsed).toBeGreaterThanOrEqual(Math.max(0, inner - 200));
  });

  it('closes protocol stdout when the runner times out even if a detached descendant still lives', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-eof-'));
    const pidfile = join(directory, 'orphan.pid');
    let orphanPid: number | undefined;
    const pluginRoot = join(directory, 'plugin');
    const declaredSec = 3;
    const declaredMs = declaredSec * 1000;
    const target = writePluginHook(
      pluginRoot,
      'orphan-hook.cjs',
      readFileSync(DETACHED_ORPHAN, 'utf8'),
      declaredSec,
    );
    const startedAt = Date.now();
    const runner = spawn(process.execPath, [RUN_CJS_PATH, target], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMC_TEST_PIDFILE: pidfile, CLAUDE_PLUGIN_ROOT: pluginRoot },
      windowsHide: true,
    });
    try {
      let stdout = '';
      let stderr = '';
      let stdoutEnded = false;
      runner.stdout.setEncoding('utf8');
      runner.stderr.setEncoding('utf8');
      runner.stdout.on('data', chunk => { stdout += chunk; });
      runner.stderr.on('data', chunk => { stderr += chunk; });
      runner.stdout.on('end', () => { stdoutEnded = true; });

      await waitForFile(pidfile, declaredMs);
      orphanPid = Number(readFileSync(pidfile, 'utf8'));
      expect(orphanPid).toBeGreaterThan(0);

      const remainingMs = Math.max(1, declaredMs - (Date.now() - startedAt));
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`run.cjs exceeded declared ${declaredMs}ms outer budget`)),
          remainingMs,
        );
        runner.once('exit', code => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(exitCode).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(declaredMs);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(stdoutEnded).toBe(true);
      expect(stdout).toContain('hook-ready');
      expect(stderr).toContain('hook-stderr');
      expect(stderr).toMatch(/timed out after \d+ms; exiting fail-open/);

      try {
        process.kill(orphanPid, 0);
        // Detached grandchild may still be alive; protocol EOF must not depend on it.
      } catch (error: unknown) {
        expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
      }
    } finally {
      killIfAlive(orphanPid);
      try { runner.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('closes protocol stdout after a successful hook exit even if a detached descendant still lives', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-success-eof-'));
    const pidfile = join(directory, 'orphan.pid');
    const outerTimeoutMs = 2000;
    let orphanPid: number | undefined;
    try {
      const startedAt = Date.now();
      const result = spawnSync(process.execPath, [RUN_CJS_PATH, SUCCESS_ORPHAN], {
        encoding: 'utf8',
        timeout: outerTimeoutMs,
        env: { ...process.env, OMC_TEST_PIDFILE: pidfile },
        windowsHide: true,
      });
      const elapsed = Date.now() - startedAt;
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status).toBe(0);
      expect(elapsed).toBeLessThan(outerTimeoutMs);
      expect(result.stdout).toContain('hook-ok');
      expect(result.stderr).toContain('hook-err');
      expect(result.stderr).not.toMatch(/timed out after \d+ms/);
      await waitForFile(pidfile, 2000);
      const pid = Number(readFileSync(pidfile, 'utf8'));
      orphanPid = pid;
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      killIfAlive(orphanPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('forwards hook stdout and stderr exactly once through the runner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-forward-'));
    try {
      const fixture = join(directory, 'echo-hook.cjs');
      writeFileSync(fixture, 'process.stdout.write("OUT-BYTES"); process.stderr.write("ERR-BYTES");');
      const result = spawnSync(process.execPath, [RUN_CJS_PATH, fixture], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('OUT-BYTES');
      expect(result.stderr).toBe('ERR-BYTES');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('forwards all 512KiB from a successful hook to a 1KiB/10ms consumer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-slow-consumer-'));
    const byteCount = 512 * 1024;
    const expected = Buffer.allocUnsafe(byteCount);
    for (let index = 0; index < expected.length; index += 1) expected[index] = index % 251;
    let runner: ReturnType<typeof spawn> | undefined;
    try {
      const pluginRoot = join(directory, 'plugin');
      const fixture = writePluginHook(
        pluginRoot,
        'large-output.cjs',
        `const output = Buffer.allocUnsafe(${byteCount});\nfor (let index = 0; index < output.length; index += 1) output[index] = index % 251;\nprocess.stdout.write(output, () => process.exit(0));`,
        10,
      );
      runner = spawn(process.execPath, [RUN_CJS_PATH, fixture], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let stderr = '';
      runner.stderr!.setEncoding('utf8');
      runner.stderr!.on('data', chunk => { stderr += chunk; });
      const slowConsumer = new Writable({
        highWaterMark: 1024,
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          setTimeout(callback, Math.ceil(chunk.length / 1024) * 10);
        },
      });
      runner.stdout!.pipe(slowConsumer);
      const exitPromise = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('slow protocol consumer exceeded hook budget')), 10000);
        runner!.once('exit', code => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      const consumerFinish = new Promise<void>(resolve => slowConsumer.once('finish', resolve));
      const [exitCode] = await Promise.all([exitPromise, consumerFinish]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(Buffer.concat(chunks)).toEqual(expected);
    } finally {
      try { runner?.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);

  it.skipIf(process.platform === 'win32')('exits nonzero when a successful hook leaves output queued to a paused consumer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-paused-success-'));
    let runner: ReturnType<typeof spawn> | undefined;
    try {
      const pluginRoot = join(directory, 'plugin');
      const fixture = writePluginHook(
        pluginRoot,
        'paused-success.cjs',
        `process.stdout.write(Buffer.alloc(1024 * 1024, 120));\nprocess.stderr.write('PAUSE-MARKER\\n');\nprocess.exit(0);`,
        2,
      );
      const startedAt = Date.now();
      runner = spawn(process.execPath, [RUN_CJS_PATH, fixture], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        windowsHide: true,
      });
      let stderr = '';
      let maxQueuedBytes = 0;
      runner.stderr!.setEncoding('utf8');
      runner.stderr!.on('data', chunk => { stderr += chunk; });
      runner.stdout!.pause();
      runner.stdout!.on('readable', () => {
        maxQueuedBytes = Math.max(maxQueuedBytes, runner!.stdout!.readableLength);
      });
      const exitPromise = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('queued protocol destination pinned run.cjs')), 5000);
        runner!.once('exit', code => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      const stderrEnd = new Promise<void>(resolve => runner!.stderr!.once('end', resolve));
      const [exitCode] = await Promise.all([exitPromise, stderrEnd]);
      const innerMs = runCjs.resolveGenericTimeoutMs({ timeoutMs: 2000, event: 'PostToolUse' });
      expect(exitCode).toBe(1);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(innerMs - 300);
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(maxQueuedBytes).toBeGreaterThan(0);
      expect(stderr).toContain('PAUSE-MARKER');
    } finally {
      try { runner?.stdout?.destroy(); } catch { /* already closed */ }
      try { runner?.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 7000);
  it('classifies consumer-closed protocol destinations as fail-open errors', () => {
    expect(runCjs.isClosedDestinationError({ code: 'EPIPE' })).toBe(true);
    expect(runCjs.isClosedDestinationError({ code: 'ERR_STREAM_DESTROYED' })).toBe(true);
    expect(runCjs.isClosedDestinationError({ code: 'ERR_STREAM_WRITE_AFTER_END' })).toBe(true);
    expect(runCjs.isClosedDestinationError({ code: 'EIO' })).toBe(false);
  });

  it('fail-opens when the protocol stdout consumer closes early', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-closed-out-'));
    let runner: ReturnType<typeof spawn> | undefined;
    try {
      const readyFile = join(directory, 'hook-ready');
      const goFile = join(directory, 'hook-go');
      const fixture = join(directory, 'write-hook.cjs');
      writeFileSync(fixture, `
const { existsSync, writeFileSync } = require('node:fs');
writeFileSync(process.env.OMC_READY_FILE, 'ready');
const writeOutput = () => {
  if (!existsSync(process.env.OMC_GO_FILE)) return setTimeout(writeOutput, 1);
  process.stdout.write('OUT-BYTES');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(pause, 0, 0, 25);
  process.stderr.write('ERR-BYTES');
};
writeOutput();
`);
      const child = runner = spawn(process.execPath, [RUN_CJS_PATH, fixture], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OMC_READY_FILE: readyFile, OMC_GO_FILE: goFile },
        windowsHide: true,
      });
      let stderr = '';
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', chunk => { stderr += chunk; });
      await waitForFile(readyFile);
      child.stdout!.destroy();
      writeFileSync(goFile, 'go');
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('runner hung after stdout consumer close')), 5000);
        child.once('exit', status => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      expect(code).toBe(0);
      expect(stderr).toContain('ERR-BYTES');
      expect(stderr).not.toMatch(/EPIPE/);
    } finally {
      try { runner?.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fail-opens when the protocol stderr consumer closes early', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-closed-err-'));
    try {
      const fixture = join(directory, 'write-hook.cjs');
      writeFileSync(fixture, 'process.stdout.write("OUT-BYTES"); process.stderr.write("ERR-BYTES");');
      const runner = spawn(process.execPath, [RUN_CJS_PATH, fixture], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      runner.stdout.setEncoding('utf8');
      runner.stdout.on('data', chunk => { stdout += chunk; });
      runner.stderr.destroy();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('runner hung after stderr consumer close')), 5000);
        runner.once('exit', status => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      expect(code).toBe(0);
      expect(stdout).toContain('OUT-BYTES');
      expect(stdout).not.toMatch(/EPIPE/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('bounds cleanup when a hook survives the closed stdout channel', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-closed-out-survivor-'));
    let runner: ReturnType<typeof spawn> | undefined;
    try {
      const readyFile = join(directory, 'hook-ready');
      const goFile = join(directory, 'hook-go');
      const pluginRoot = join(directory, 'plugin');
      const target = writePluginHook(pluginRoot, 'surviving-hook.cjs', `
const { existsSync, writeFileSync } = require('node:fs');
process.stdout.on('error', () => {});
writeFileSync(process.env.OMC_READY_FILE, 'ready');
const start = () => {
  if (!existsSync(process.env.OMC_GO_FILE)) return setTimeout(start, 1);
  process.stdout.write('OUT-BYTES');
  setInterval(() => {}, 1e9);
};
start();
`, 5);
      const startedAt = Date.now();
      const child = runner = spawn(process.execPath, [RUN_CJS_PATH, target], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, OMC_READY_FILE: readyFile, OMC_GO_FILE: goFile },
        windowsHide: true,
      });
      child.stderr!.resume();
      await waitForFile(readyFile);
      child.stdout!.destroy();
      writeFileSync(goFile, 'go');
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('runner waited for the inner timeout after stdout close')), 1500);
        child.once('exit', status => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      expect(code).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(1500);
    } finally {
      try { runner?.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fail-opens a drain-aware noisy stdout hook when the consumer closes early', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-drain-out-'));
    try {
      const pluginRoot = join(directory, 'plugin');
      const target = writePluginHook(pluginRoot, 'drain-out.cjs', `
process.stderr.write('ERR-KEEP\\n');
process.stdout.on('error', () => {
  process.stderr.write('ERR-AFTER-EPIPE\\n');
  process.exit(7);
});
const pump = () => {
  try {
    while (process.stdout.write('n'.repeat(1024))) {}
    process.stdout.once('drain', pump);
  } catch {
    process.stderr.write('ERR-AFTER-EPIPE\\n');
    process.exit(7);
  }
};
pump();
`, 5);
      const startedAt = Date.now();
      const runner = spawn(process.execPath, [RUN_CJS_PATH, target], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        windowsHide: true,
      });
      let stderr = '';
      runner.stderr.setEncoding('utf8');
      runner.stderr.on('data', chunk => { stderr += chunk; });
      runner.stdout.destroy();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('drain-aware stdout hook waited for inner timeout')), 1500);
        runner.once('exit', status => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      expect(code).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(stderr).toContain('ERR-KEEP');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fail-opens a drain-aware noisy stderr hook when the consumer closes early', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-drain-err-'));
    try {
      const pluginRoot = join(directory, 'plugin');
      const target = writePluginHook(pluginRoot, 'drain-err.cjs', `
process.stdout.write('OUT-KEEP\\n');
process.stderr.on('error', () => {
  process.stdout.write('OUT-AFTER-EPIPE\\n');
  process.exit(7);
});
const pump = () => {
  try {
    while (process.stderr.write('n'.repeat(1024))) {}
    process.stderr.once('drain', pump);
  } catch {
    process.stdout.write('OUT-AFTER-EPIPE\\n');
    process.exit(7);
  }
};
pump();
`, 5);
      const startedAt = Date.now();
      const runner = spawn(process.execPath, [RUN_CJS_PATH, target], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        windowsHide: true,
      });
      let stdout = '';
      runner.stdout.setEncoding('utf8');
      runner.stdout.on('data', chunk => { stdout += chunk; });
      runner.stderr.destroy();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('drain-aware stderr hook waited for inner timeout')), 1500);
        runner.once('exit', status => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      expect(code).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(stdout).toContain('OUT-KEEP');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('reaps grandchildren when stdout closes and the hook leader EPIPE-exits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-close-reap-'));
    const pidfile = join(directory, 'grandchild.pid');
    let grandchildPid: number | undefined;
    const runner = spawn(process.execPath, [RUN_CJS_PATH, EPIPE_EXIT_PARENT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMC_TEST_PIDFILE: pidfile },
      windowsHide: true,
    });
    try {
      await waitForFile(pidfile, 4000);
      grandchildPid = Number(readFileSync(pidfile, 'utf8'));
      expect(grandchildPid).toBeGreaterThan(0);
      runner.stdout.destroy();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('runner hung after stdout close with grandchild')), 3000);
        runner.once('exit', status => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      expect(code).toBe(0);
      await waitForDeath(grandchildPid);
    } finally {
      killIfAlive(grandchildPid);
      try { runner.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('writes a visible timeout diagnostic on fail-open', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-timeout-diag-'));
    try {
      const pluginRoot = join(directory, 'plugin');
      const target = writePluginHook(pluginRoot, 'hang-hook.cjs', 'setInterval(() => {}, 1e9);', 1);
      const startedAt = Date.now();
      const result = spawnSync(process.execPath, [RUN_CJS_PATH, target], {
        encoding: 'utf8',
        timeout: 2000,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        windowsHide: true,
      });
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(result.stderr).toMatch(/timed out after \d+ms; exiting fail-open/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fail-opens a timed-out hook when the protocol stderr consumer is closed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-timeout-closed-err-'));
    try {
      const pluginRoot = join(directory, 'plugin');
      const target = writePluginHook(pluginRoot, 'hang-hook.cjs', 'setInterval(() => {}, 1e9);', 1);
      const startedAt = Date.now();
      const runner = spawn(process.execPath, [RUN_CJS_PATH, target], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        windowsHide: true,
      });
      runner.stderr.destroy();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed-out runner crashed or hung after stderr close')), 2000);
        runner.once('exit', status => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      expect(code).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('fail-opens when a paused stderr consumer closes after the timeout diagnostic is queued', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-paused-err-'));
    try {
      const pluginRoot = join(directory, 'plugin');
      const target = writePluginHook(pluginRoot, 'hang-hook.cjs', 'setInterval(() => {}, 1e9);', 1);
      const startedAt = Date.now();
      const runner = spawn(process.execPath, [RUN_CJS_PATH, target], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        windowsHide: true,
      });
      runner.stderr.pause();
      const exitPromise = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('runner hung after delayed stderr close')), 2000);
        runner.once('exit', status => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      const innerMs = runCjs.resolveGenericTimeoutMs({ timeoutMs: 1000, event: 'PostToolUse' });
      await new Promise(resolve => setTimeout(resolve, innerMs + 50));
      if (runner.exitCode === null) runner.stderr.destroy();
      const code = await exitPromise;
      expect(code).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('exits on timeout when a noisy hook has a non-draining protocol consumer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-noisy-'));
    let runner: ReturnType<typeof spawn> | undefined;
    try {
      const pluginRoot = join(directory, 'plugin');
      const target = writePluginHook(
        pluginRoot,
        'noisy-hook.cjs',
        'process.stderr.write("n".repeat(8192)); setInterval(() => { process.stderr.write("n".repeat(256)); }, 20);',
        1,
      );
      const startedAt = Date.now();
      runner = spawn(process.execPath, [RUN_CJS_PATH, target], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        windowsHide: true,
      });
      runner.stderr!.pause();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('noisy hook kept runner alive past outer deadline')), 2000);
        runner!.once('exit', status => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      expect(code).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      try { runner?.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reaps grandchildren when the hook leader exits on protocol EPIPE at timeout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-epipe-reap-'));
    const pidfile = join(directory, 'grandchild.pid');
    const previousPidfile = process.env.OMC_TEST_PIDFILE;
    let grandchildPid: number | undefined;
    process.env.OMC_TEST_PIDFILE = pidfile;
    const innerMs = 1500;
    const outerMs = 3000;
    try {
      const startedAt = Date.now();
      let deadline: NodeJS.Timeout | undefined;
      const status = await Promise.race([
        runCjs.runGenericChild(EPIPE_EXIT_PARENT, [], innerMs, null),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`epipe-exit parent exceeded ${outerMs}ms outer deadline`)),
            outerMs,
          );
        }),
      ]).finally(() => clearTimeout(deadline));
      expect(status).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(outerMs);
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

  it('reaps timed-out generic descendants so no orphan survives', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-reap-'));
    const pidfile = join(directory, 'grandchild.pid');
    const previousPidfile = process.env.OMC_TEST_PIDFILE;
    let grandchildPid: number | undefined;
    process.env.OMC_TEST_PIDFILE = pidfile;
    // 250ms is below observed Windows supervisor→hook→grandchild cold start
    // (361–559ms). Inner budget must cover that spawn chain; outer deadline
    // is a separate assertion so a hung reap cannot hide behind a long inner.
    const innerMs = 1500;
    const outerMs = 3000;
    try {
      const startedAt = Date.now();
      let deadline: NodeJS.Timeout | undefined;
      const status = await Promise.race([
        runCjs.runGenericChild(HUNG_PARENT, [], innerMs, null),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`runGenericChild exceeded ${outerMs}ms outer deadline`)),
            outerMs,
          );
        }),
      ]).finally(() => clearTimeout(deadline));
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
});
