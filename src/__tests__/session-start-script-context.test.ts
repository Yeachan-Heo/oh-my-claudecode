import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Standalone hook runtime source is intentionally JavaScript-only.
import { publishCacheOccupancy } from '../../scripts/lib/cache-occupancy.mjs';

const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'session-start.mjs');
const NODE = process.execPath;

function startPostToolFailureLockHolder(statePath: string) {
  const source = `import { openSync, writeSync, closeSync, unlinkSync, constants } from 'node:fs';
const lockPath = process.argv[1] + '.lock';
const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), null, 'utf-8');
process.stdout.write('LOCKED\\n');
process.stdin.once('data', () => {
  try { closeSync(fd); unlinkSync(lockPath); process.exitCode = 0; }
  catch { process.exitCode = 1; }
});`;
  const child = spawn(NODE, ['--input-type=module', '-e', source, statePath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let readyOutput = '';
  let exitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      exitResult = { code, signal };
      resolve(exitResult);
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for lock holder: ${readyOutput}`)), 5000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onStdout = (chunk: Buffer) => {
      readyOutput += chunk.toString();
      if (readyOutput.includes('LOCKED\n')) finish();
    };
    const onStderr = (chunk: Buffer) => { readyOutput += chunk.toString(); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Lock holder exited before acquisition (${code ?? signal}): ${readyOutput}`));
    };
    const onError = (error: Error) => finish(error);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });

  const waitForExit = async (timeoutMs: number) => {
    if (exitResult) return exitResult;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([exited, timedOut]);
    if (timeout) clearTimeout(timeout);
    return result;
  };

  return {
    ready,
    async release() {
      if (!exitResult && child.stdin.writable && !child.stdin.writableEnded) child.stdin.end('release');
      let result = await waitForExit(5000);
      if (!result) {
        child.kill();
        result = await waitForExit(1000);
      }
      return result;
    },
  };
}

function startSqliteMutationLockHolder(databasePath: string) {
  const source = `import Database from 'better-sqlite3';
const database = new Database(process.argv[1]);
database.pragma('journal_mode = WAL');
database.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)');
database.exec('BEGIN IMMEDIATE');
process.stdout.write('LOCKED');
process.stdin.once('data', () => { database.exec('ROLLBACK'); database.close(); });
process.stdin.resume();`;
  const child = spawn(NODE, ['--input-type=module', '-e', source, databasePath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error(`Timed out acquiring SQLite mutation lock: ${output}`)), 5000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('LOCKED')) finish();
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('error', error => finish(error));
    child.once('exit', code => {
      if (!output.includes('LOCKED')) finish(new Error(`SQLite mutation lock holder exited (${code}): ${output}`));
    });
  });

  return {
    ready,
    async release() {
      child.stdin.end('release');
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    },
  };
}

function startSessionStartProcess(
  scriptPath: string,
  fakeHome: string,
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
) {
  const child = spawn(NODE, [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, ...extraEnv },
  });
  let stdout = '';
  let stderr = '';
  const output = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`SessionStart timed out: ${stderr}`));
    }, 30_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`SessionStart exited (${code ?? signal}): ${stderr}`));
    });
  });
  child.stdin.end(JSON.stringify(input));
  return { child, output };
}

async function waitForFilesToDisappear(paths: string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every(path => !existsSync(path))) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return paths.every(path => !existsSync(path));
}

async function waitForFilesToAppear(paths: string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every(path => existsSync(path))) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return paths.every(path => existsSync(path));
}

describe('session-start.mjs regression #1386', () => {
  let tempDir: string;
  let fakeHome: string;
  let fakeProject: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-script-'));
    fakeHome = join(tempDir, 'home');
    fakeProject = join(tempDir, 'project');
    mkdirSync(fakeProject, { recursive: true });
    mkdirSync(join(fakeProject, '.omc', 'state', 'sessions', 'session-1386'), { recursive: true });
    // session-start validateCwd requires a real workspace anchor.
    execFileSync('git', ['init', '--quiet', fakeProject], { stdio: 'ignore' });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not restore retired ultrawork state', () => {
    writeFileSync(
      join(fakeProject, '.omc', 'state', 'sessions', 'session-1386', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-1386',
        started_at: '2026-03-06T00:00:00.000Z',
        original_prompt: 'Old task that should not override a new request',
      }),
    );

    const raw = execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-1386',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
      timeout: 15000,
    }).trim();

    const output = JSON.parse(raw) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    const context = output.hookSpecificOutput?.additionalContext || '';

    expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
    expect(context).not.toContain('Old task that should not override a new request');
  });

  it('purges legacy tool-failure state without disturbing unrelated inactive-session state', () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const oldSessionDir = join(stateDir, 'sessions', 'session-old-without-marker');
    mkdirSync(oldSessionDir, { recursive: true });
    const legacyRootError = join(stateDir, 'last-tool-error.json');
    const legacySessionError = join(oldSessionDir, 'last-tool-error-state.json');
    const unrelatedState = join(oldSessionDir, 'unrelated-state.json');
    writeFileSync(legacyRootError, JSON.stringify({ tool_input_preview: 'legacy input secret', error: 'legacy raw error' }));
    writeFileSync(legacySessionError, JSON.stringify({ tool_input_preview: 'legacy input secret', error: 'legacy raw error' }));
    writeFileSync(unrelatedState, 'preserve this state');

    const raw = execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-current',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: '',
        OMC_STATE_DIR: '',
      },
      timeout: 15000,
    }).trim();

    expect(JSON.parse(raw).continue).toBe(true);
    expect(existsSync(legacyRootError)).toBe(false);
    expect(existsSync(legacySessionError)).toBe(false);
    expect(existsSync(join(oldSessionDir, 'session-started.json'))).toBe(false);
    expect(readFileSync(unrelatedState, 'utf-8')).toBe('preserve this state');
  });

  it('preserves sanitized canonical tool-failure records and their retry counts', () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-retry-state');
    mkdirSync(sessionDir, { recursive: true });
    const rootPath = join(stateDir, 'last-tool-error.json');
    const sessionPath = join(sessionDir, 'last-tool-error-state.json');
    const rootState = {
      tool_name: 'Bash',
      error: 'Tool execution failed (details omitted for privacy).',
      timestamp: new Date().toISOString(),
      retry_count: 4,
    };
    const sessionState = { ...rootState, retry_count: 7 };
    writeFileSync(rootPath, JSON.stringify(rootState));
    writeFileSync(sessionPath, JSON.stringify(sessionState));

    execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'session-current', cwd: fakeProject }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: '',
        OMC_STATE_DIR: '',
      },
      timeout: 15000,
    });

    expect(JSON.parse(readFileSync(rootPath, 'utf-8'))).toEqual(rootState);
    expect(JSON.parse(readFileSync(sessionPath, 'utf-8'))).toEqual(sessionState);
  });

  it('purges legacy atomic temp files but preserves a fresh sanitized temp', () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-temp-files');
    mkdirSync(sessionDir, { recursive: true });
    const legacyPaths = [
      join(stateDir, `.last-tool-error.json.tmp.${randomUUID()}`),
      join(stateDir, `.last-tool-error-state.json.tmp.${randomUUID()}`),
      join(sessionDir, `.last-tool-error.json.tmp.${randomUUID()}`),
      join(sessionDir, `.last-tool-error-state.json.tmp.${randomUUID()}`),
    ];
    for (const path of legacyPaths) writeFileSync(path, JSON.stringify({ tool_input_preview: 'legacy temp secret', error: 'legacy raw error' }));

    const freshPath = join(stateDir, `.last-tool-error.json.tmp.${randomUUID()}`);
    const unrelatedTempPath = join(stateDir, '.last-tool-error.json.tmp.not-a-uuid');
    writeFileSync(freshPath, JSON.stringify({
      tool_name: 'Bash',
      error: 'Tool execution failed (details omitted for privacy).',
      timestamp: new Date().toISOString(),
      retry_count: 4,
    }));
    writeFileSync(unrelatedTempPath, 'not an atomic temp name');

    const output = JSON.parse(execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'session-current', cwd: fakeProject }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: '',
        OMC_STATE_DIR: '',
      },
      timeout: 15000,
    }));

    expect(output.continue).toBe(true);
    for (const path of legacyPaths) expect(existsSync(path)).toBe(false);
    expect(existsSync(freshPath)).toBe(true);
    expect(existsSync(unrelatedTempPath)).toBe(true);
  });

  it('preserves an in-flight legacy temp until the PostToolUseFailure lock is released', async () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const canonicalPath = join(stateDir, 'last-tool-error.json');
    const tempPath = join(stateDir, `.last-tool-error.json.tmp.${randomUUID()}`);
    const holder = startPostToolFailureLockHolder(canonicalPath);
    let sessionStart: ReturnType<typeof startSessionStartProcess> | undefined;

    try {
      await holder.ready;
      writeFileSync(tempPath, '{"tool_input_preview":"in-flight legacy payload"');
      expect(existsSync(tempPath)).toBe(true);
      sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
        hook_event_name: 'SessionStart',
        session_id: 'session-current',
        cwd: fakeProject,
      }, {
        CLAUDE_PLUGIN_ROOT: '',
        OMC_STATE_DIR: '',
        OMC_TEST_TOOL_FAILURE_LOCK_WAIT_MS: '100',
      });

      const output = JSON.parse(await sessionStart.output);
      expect(output.continue).toBe(true);
      expect(existsSync(tempPath)).toBe(true);
      expect(await holder.release()).toEqual({ code: 0, signal: null });
      expect(await waitForFilesToDisappear([tempPath], 15_000)).toBe(true);
    } finally {
      await holder.release();
      if (sessionStart) await sessionStart.output.catch(() => '');
    }
  });

  it('defers cleanup for locked root and session state until the locks are released', async () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-locked');
    mkdirSync(sessionDir, { recursive: true });
    const rootPath = join(stateDir, 'last-tool-error.json');
    const sessionPath = join(sessionDir, 'last-tool-error-state.json');
    const rootTemp = join(stateDir, `.last-tool-error.json.tmp.${randomUUID()}`);
    const sessionTemp = join(sessionDir, `.last-tool-error-state.json.tmp.${randomUUID()}`);
    const cleanupPaths = [rootPath, rootTemp, sessionPath, sessionTemp];
    const rootHolder = startPostToolFailureLockHolder(rootPath);
    const sessionHolder = startPostToolFailureLockHolder(sessionPath);
    let sessionStart: ReturnType<typeof startSessionStartProcess> | undefined;

    try {
      await Promise.all([rootHolder.ready, sessionHolder.ready]);
      writeFileSync(rootPath, JSON.stringify({ tool_input_preview: 'root legacy payload', error: 'legacy root error' }));
      writeFileSync(rootTemp, '{"tool_input_preview":"root legacy temp"');
      writeFileSync(sessionPath, JSON.stringify({ tool_input_preview: 'session legacy payload', error: 'legacy session error' }));
      writeFileSync(sessionTemp, '{"tool_input_preview":"session legacy payload"');
      sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
        hook_event_name: 'SessionStart',
        session_id: 'session-current',
        cwd: fakeProject,
      }, {
        CLAUDE_PLUGIN_ROOT: '',
        OMC_STATE_DIR: '',
        OMC_HOOK_BACKGROUND_CHILD: '0',
        OMC_TEST_TOOL_FAILURE_LOCK_WAIT_MS: '100',
      });

      const output = JSON.parse(await sessionStart.output);
      expect(output.continue).toBe(true);
      expect(cleanupPaths.every(path => existsSync(path))).toBe(true);
      expect(await rootHolder.release()).toEqual({ code: 0, signal: null });
      expect(await sessionHolder.release()).toEqual({ code: 0, signal: null });
      expect(await waitForFilesToDisappear(cleanupPaths, 15_000)).toBe(true);
    } finally {
      await Promise.all([rootHolder.release(), sessionHolder.release()]);
      if (sessionStart) await sessionStart.output.catch(() => '');
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('continues when failure-state lock creation is denied', async () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const legacyPath = join(stateDir, 'last-tool-error.json');
    writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'read-only legacy secret' }));
    chmodSync(stateDir, 0o555);
    let sessionStart: ReturnType<typeof startSessionStartProcess> | undefined;

    try {
      sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
        hook_event_name: 'SessionStart',
        session_id: 'session-current',
        cwd: fakeProject,
      }, {
        CLAUDE_PLUGIN_ROOT: '',
        OMC_STATE_DIR: '',
        OMC_HOOK_BACKGROUND_CHILD: '0',
        OMC_TEST_TOOL_FAILURE_LOCK_WAIT_MS: '100',
      });
      const output = JSON.parse(await sessionStart.output);
      expect(output.continue).toBe(true);
      expect(existsSync(legacyPath)).toBe(true);
    } finally {
      chmodSync(stateDir, 0o755);
      if (sessionStart) await sessionStart.output.catch(() => '');
    }
  });

  it('does not classify unverifiable failure-state locks as retryable contention', async () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const legacyPath = join(stateDir, 'last-tool-error.json');
    const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
    const initialScanReadyPath = join(tempDir, 'initial-scan-ready');
    const initialScanReleasePath = join(tempDir, 'initial-scan-release');
    writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'unverifiable legacy secret' }));
    writeFileSync(`${legacyPath}.lock`, 'malformed lock metadata');

    const sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
      hook_event_name: 'SessionStart',
      session_id: 'session-current',
      cwd: fakeProject,
    }, {
      CLAUDE_PLUGIN_ROOT: '',
      OMC_STATE_DIR: '',
      OMC_HOOK_BACKGROUND_CHILD: '0',
      OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '1500',
      OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_READY_PATH: initialScanReadyPath,
      OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_RELEASE_PATH: initialScanReleasePath,
    });

    try {
      const output = JSON.parse(await sessionStart.output);
      expect(output.continue).toBe(true);
      expect(await waitForFilesToAppear([workerLockPath, initialScanReadyPath], 10_000)).toBe(true);
      expect(existsSync(legacyPath)).toBe(true);
      expect(readFileSync(`${legacyPath}.lock`, 'utf-8')).toBe('malformed lock metadata');
      writeFileSync(initialScanReleasePath, 'continue');
      expect(await waitForFilesToDisappear([workerLockPath], 15_000)).toBe(true);
    } finally {
      writeFileSync(initialScanReleasePath, 'continue');
      await sessionStart.output.catch(() => '');
    }
  });

  it('stops waiting for other plugin versions once the worker reaches its hard lifetime', async () => {
    const configDir = join(fakeHome, '.claude');
    const pluginParent = join(tempDir, 'plugin-cache', 'oh-my-claudecode');
    const currentPluginRoot = join(pluginParent, 'current');
    const olderPluginRoot = join(pluginParent, 'older');
    const registryDir = join(configDir, '.omc', 'cache-occupancy');
    const omcRoot = join(fakeProject, '.omc');
    const workerLockPath = join(omcRoot, 'state', '.legacy-tool-failure-cleanup-worker.lock');
    expect(publishCacheOccupancy(olderPluginRoot, configDir, process.pid)).toBe(true);

    const startedAt = Date.now();
    const worker = spawn(NODE, [SCRIPT_PATH, '--stabilize-legacy-tool-failure-state', omcRoot, '500', '3000'], {
      stdio: 'ignore',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_PLUGIN_ROOT: currentPluginRoot,
        OMC_HOOK_BACKGROUND_CHILD: '1',
      },
    });
    const workerExit = new Promise<number | null>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => resolve(code));
    });

    try {
      expect(await waitForFilesToAppear([workerLockPath], 5000)).toBe(true);
      // Past the 500 ms stabilization window the older version still holds the worker.
      await new Promise(resolve => setTimeout(resolve, 1000));
      expect(worker.exitCode).toBeNull();

      const exitCode = await Promise.race([
        workerExit,
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 7000)),
      ]);
      expect(exitCode).toBe(0);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3000);
      expect(existsSync(workerLockPath)).toBe(false);
      // The older version never exited: the worker gave up waiting for it.
      expect(readdirSync(registryDir)).toHaveLength(1);
    } finally {
      rmSync(registryDir, { recursive: true, force: true });
      if (worker.exitCode === null) worker.kill();
      await workerExit.catch(() => undefined);
    }
  });

  it('stops waiting for the state directory once the worker reaches its hard lifetime', async () => {
    const configDir = join(fakeHome, '.claude');
    const pluginParent = join(tempDir, 'plugin-cache', 'oh-my-claudecode');
    const currentPluginRoot = join(pluginParent, 'current');
    const olderPluginRoot = join(pluginParent, 'older');
    const registryDir = join(configDir, '.omc', 'cache-occupancy');
    const omcRoot = join(fakeProject, '.omc');
    const stateDir = join(omcRoot, 'state');
    rmSync(stateDir, { recursive: true, force: true });
    expect(publishCacheOccupancy(olderPluginRoot, configDir, process.pid)).toBe(true);

    const startedAt = Date.now();
    const worker = spawn(NODE, [SCRIPT_PATH, '--stabilize-legacy-tool-failure-state', omcRoot, '500', '2000'], {
      stdio: 'ignore',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_PLUGIN_ROOT: currentPluginRoot,
        OMC_HOOK_BACKGROUND_CHILD: '1',
      },
    });
    const workerExit = new Promise<number | null>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => resolve(code));
    });

    try {
      // Past the 500 ms window the older version still keeps the worker waiting.
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(worker.exitCode).toBeNull();

      const exitCode = await Promise.race([
        workerExit,
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 6000)),
      ]);
      expect(exitCode).toBe(0);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2000);
      expect(existsSync(stateDir)).toBe(false);
      // The older version never exited: the worker gave up waiting for it.
      expect(readdirSync(registryDir)).toHaveLength(1);
    } finally {
      rmSync(registryDir, { recursive: true, force: true });
      if (worker.exitCode === null) worker.kill();
      await workerExit.catch(() => undefined);
    }
  });

  it('leaves legacy artifacts in place when the cleanup lock frees up after the hard lifetime', async () => {
    const omcRoot = join(fakeProject, '.omc');
    const stateDir = join(omcRoot, 'state');
    const legacyPath = join(stateDir, 'last-tool-error.json');
    const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
    writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'legacy payload that outlives the worker' }));
    const holder = startPostToolFailureLockHolder(legacyPath);
    let worker: ReturnType<typeof spawn> | undefined;
    let workerExit: Promise<{ code: number | null; at: number }> | undefined;

    try {
      await holder.ready;
      worker = spawn(NODE, [SCRIPT_PATH, '--stabilize-legacy-tool-failure-state', omcRoot, '500', '1000'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
          CLAUDE_PLUGIN_ROOT: join(tempDir, 'plugin-cache', 'oh-my-claudecode', 'current'),
          OMC_HOOK_BACKGROUND_CHILD: '1',
        },
      });
      const child = worker;
      workerExit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => resolve({ code, at: Date.now() }));
      });
      expect(await waitForFilesToAppear([workerLockPath], 5000)).toBe(true);

      // Free the lock after the 1000 ms lifetime but before the 2500 ms cleanup wait runs out.
      await new Promise(resolve => setTimeout(resolve, 1700));
      const releasedAt = Date.now();
      expect(await holder.release()).toEqual({ code: 0, signal: null });

      const exit = await Promise.race([
        workerExit,
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 5000)),
      ]);
      expect(exit?.code).toBe(0);
      expect(existsSync(legacyPath)).toBe(true);
      // The worker left at its deadline while the lock was still held, not once the lock freed up.
      expect(exit!.at).toBeLessThan(releasedAt);
      expect(existsSync(workerLockPath)).toBe(false);
    } finally {
      await holder.release();
      if (worker && worker.exitCode === null) worker.kill();
      await workerExit?.catch(() => undefined);
    }
  });

  it('stops waiting for the cleanup worker lock once the worker reaches its hard lifetime', async () => {
    const omcRoot = join(fakeProject, '.omc');
    const stateDir = join(omcRoot, 'state');
    const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
    const holder = startPostToolFailureLockHolder(join(stateDir, '.legacy-tool-failure-cleanup-worker'));
    let worker: ReturnType<typeof spawn> | undefined;
    let workerExit: Promise<{ code: number | null; at: number }> | undefined;

    try {
      await holder.ready;
      worker = spawn(NODE, [SCRIPT_PATH, '--stabilize-legacy-tool-failure-state', omcRoot, '50', '200'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
          CLAUDE_PLUGIN_ROOT: join(tempDir, 'plugin-cache', 'oh-my-claudecode', 'current'),
          OMC_HOOK_BACKGROUND_CHILD: '1',
        },
      });
      const child = worker;
      workerExit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => resolve({ code, at: Date.now() }));
      });

      // Free the lock long after the 200 ms lifetime but before the worker's own lock wait (about 3 s) could run out.
      await new Promise(resolve => setTimeout(resolve, 2500));
      const releasedAt = Date.now();
      expect(await holder.release()).toEqual({ code: 0, signal: null });

      const exit = await Promise.race([
        workerExit,
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 5000)),
      ]);
      expect(exit?.code).toBe(0);
      // The worker left at its deadline while the lock was still held, not once the lock freed up.
      expect(exit!.at).toBeLessThan(releasedAt);
      expect(existsSync(workerLockPath)).toBe(false);
    } finally {
      await holder.release();
      if (worker && worker.exitCode === null) worker.kill();
      await workerExit?.catch(() => undefined);
    }
  });

  it.skipIf(process.platform === 'win32')('bounds the plugin occupancy probe after the worker lock by the hard lifetime', async () => {
    const configDir = join(fakeHome, '.claude');
    const pluginParent = join(tempDir, 'plugin-cache', 'oh-my-claudecode');
    const omcRoot = join(fakeProject, '.omc');
    const stateDir = join(omcRoot, 'state');
    const legacyPath = join(stateDir, 'last-tool-error.json');
    const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
    const fakeBin = join(tempDir, 'fake-bin');
    const psLog = join(tempDir, 'ps.log');
    const slowMarker = join(tempDir, 'ps-slow-started');
    const platformPreload = join(tempDir, 'darwin-platform.mjs');
    const lstart = 'Tue Jan  6 09:00:00 2026';
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(platformPreload, "Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });\n");
    // The batched occupancy ps hangs once the worker lock exists; every other call answers at once.
    const ps = join(fakeBin, 'ps');
    writeFileSync(ps, [
      '#!/bin/sh',
      'echo "$@" >> "$PS_LOG"',
      'case "$4" in',
      '  pid=,lstart=)',
      '    if [ -e "$WORKER_LOCK" ]; then : > "$PS_SLOW_MARKER"; exec sleep 10; fi',
      '    IFS=,; for id in $2; do printf \'%5s %s\\n\' "$id" "$PS_LSTART"; done',
      '    ;;',
      '  *) echo "$PS_LSTART" ;;',
      'esac',
      '',
    ].join('\n'));
    chmodSync(ps, 0o755);
    const psEnv = { PATH: `${fakeBin}:${process.env.PATH}`, PS_LOG: psLog, PS_SLOW_MARKER: slowMarker, PS_LSTART: lstart, WORKER_LOCK: workerLockPath };
    // The first exec of a new script can take seconds on a loaded host, longer than the probe cap.
    spawnSync(ps, ['warmup'], { env: { ...psEnv, PS_LOG: '/dev/null' }, timeout: 30000 });
    // An older plugin version whose live session the fake ps confirms.
    expect(publishCacheOccupancy(join(pluginParent, 'older'), configDir, process.pid, String(new Date(lstart).getTime()))).toBe(true);
    writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'legacy payload that outlives the worker' }));

    const worker = spawn(NODE, ['--import', platformPreload, SCRIPT_PATH, '--stabilize-legacy-tool-failure-state', omcRoot, '50', '400'], {
      stdio: 'ignore',
      env: {
        ...process.env,
        ...psEnv,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_PLUGIN_ROOT: join(pluginParent, 'current'),
        OMC_HOOK_BACKGROUND_CHILD: '1',
      },
    });
    const workerExit = new Promise<{ code: number | null; at: number }>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => resolve({ code, at: Date.now() }));
    });

    try {
      expect(await waitForFilesToAppear([slowMarker], 5000)).toBe(true);
      const probeStartedAt = Date.now();

      const exit = await Promise.race([
        workerExit,
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 6000)),
      ]);
      expect(exit?.code).toBe(0);
      // The probe is cut off by the 400 ms lifetime, not by the 2 s darwin ps timeout.
      expect(exit!.at - probeStartedAt).toBeLessThan(1200);
      expect(existsSync(workerLockPath)).toBe(false);
      expect(existsSync(legacyPath)).toBe(true);
      // One batched ps per scan: before the worker lock and after it.
      const batchedCalls = readFileSync(psLog, 'utf8').split('\n').filter(line => line.endsWith('-o pid=,lstart='));
      expect(batchedCalls).toHaveLength(2);
    } finally {
      if (worker.exitCode === null) worker.kill();
      await workerExit.catch(() => undefined);
    }
  });

  it('lets stabilization workers exit while sanitized failure records remain', async () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const legacyPath = join(stateDir, 'last-tool-error.json');
    const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
    const initialScanReadyPath = join(tempDir, 'initial-scan-ready');
    const initialScanReleasePath = join(tempDir, 'initial-scan-release');
    const sanitizedState = {
      tool_name: 'Bash',
      error: 'Tool execution failed (details omitted for privacy).',
      timestamp: new Date().toISOString(),
      retry_count: 1,
    };
    writeFileSync(legacyPath, JSON.stringify(sanitizedState));

    const sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
      hook_event_name: 'SessionStart',
      session_id: 'session-current',
      cwd: fakeProject,
    }, {
      CLAUDE_PLUGIN_ROOT: '',
      OMC_STATE_DIR: '',
      OMC_HOOK_BACKGROUND_CHILD: '0',
      OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '1500',
      OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_READY_PATH: initialScanReadyPath,
      OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_RELEASE_PATH: initialScanReleasePath,
    });
    // This worker's startup snapshot is synchronized with the test below.

    try {
      expect(JSON.parse(await sessionStart.output).continue).toBe(true);
      expect(await waitForFilesToAppear([workerLockPath, initialScanReadyPath], 10_000)).toBe(true);
      writeFileSync(initialScanReleasePath, 'continue');
      expect(await waitForFilesToDisappear([workerLockPath], 15_000)).toBe(true);
      expect(JSON.parse(readFileSync(legacyPath, 'utf-8'))).toEqual(sanitizedState);
    } finally {
      writeFileSync(initialScanReleasePath, 'continue');
      await sessionStart.output.catch(() => '');
    }
  });

  it('rescans root and newly created session records after the startup snapshot', async () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const rootPath = join(stateDir, 'last-tool-error.json');
    const lateSessionDir = join(stateDir, 'sessions', 'session-created-after-start');
    const lateSessionPath = join(lateSessionDir, 'last-tool-error-state.json');
    const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
    const initialScanReadyPath = join(tempDir, 'initial-scan-ready');
    const initialScanReleasePath = join(tempDir, 'initial-scan-release');
    const sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
      hook_event_name: 'SessionStart',
      session_id: 'session-current',
      cwd: fakeProject,
    }, {
      CLAUDE_PLUGIN_ROOT: '',
      OMC_STATE_DIR: '',
      OMC_HOOK_BACKGROUND_CHILD: '0',
      OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '1500',
      OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_READY_PATH: initialScanReadyPath,
      OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_RELEASE_PATH: initialScanReleasePath,
    });

    try {
      expect(JSON.parse(await sessionStart.output).continue).toBe(true);
      expect(await waitForFilesToAppear([workerLockPath, initialScanReadyPath], 10_000)).toBe(true);
      mkdirSync(lateSessionDir, { recursive: true });
      writeFileSync(rootPath, JSON.stringify({ tool_input_preview: 'late root legacy secret' }));
      writeFileSync(lateSessionPath, JSON.stringify({ tool_input_preview: 'late session legacy secret' }));
      writeFileSync(initialScanReleasePath, 'continue');

      expect(await waitForFilesToDisappear([rootPath, lateSessionPath], 15_000)).toBe(true);
      expect(await waitForFilesToDisappear([workerLockPath], 15_000)).toBe(true);
    } finally {
      writeFileSync(initialScanReleasePath, 'continue');
      await sessionStart.output.catch(() => '');
    }
  });

  it('purges artifacts published between the last periodic scan and final scan', async () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const legacyPath = join(stateDir, 'last-tool-error.json');
    const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
    const finalScanReadyPath = join(tempDir, 'final-scan-ready');
    const finalScanReleasePath = join(tempDir, 'final-scan-release');
    const sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
      hook_event_name: 'SessionStart',
      session_id: 'session-current',
      cwd: fakeProject,
    }, {
      CLAUDE_PLUGIN_ROOT: '',
      OMC_STATE_DIR: '',
      OMC_HOOK_BACKGROUND_CHILD: '0',
      OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '1000',
      OMC_TEST_TOOL_FAILURE_FINAL_SCAN_READY_PATH: finalScanReadyPath,
      OMC_TEST_TOOL_FAILURE_FINAL_SCAN_RELEASE_PATH: finalScanReleasePath,
    });

    try {
      expect(JSON.parse(await sessionStart.output).continue).toBe(true);
      expect(await waitForFilesToAppear([workerLockPath, finalScanReadyPath], 10_000)).toBe(true);
      writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'last-window legacy secret' }));
      writeFileSync(finalScanReleasePath, 'continue');

      expect(await waitForFilesToDisappear([legacyPath], 15_000)).toBe(true);
      expect(await waitForFilesToDisappear([workerLockPath], 15_000)).toBe(true);
    } finally {
      writeFileSync(finalScanReleasePath, 'continue');
      await sessionStart.output.catch(() => '');
    }
  });

  it('skips sanitized session records before waiting for the shared SQLite lock', async () => {
    const omcRoot = join(fakeProject, '.omc');
    const stateDir = join(omcRoot, 'state');
    const sessionsDir = join(stateDir, 'sessions');
    const sanitizedState = {
      tool_name: 'Bash',
      error: 'Tool execution failed (details omitted for privacy).',
      timestamp: new Date().toISOString(),
      retry_count: 0,
    };
    for (let index = 0; index < 20; index += 1) {
      const sessionDir = join(sessionsDir, `session-sanitized-${index}`);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'last-tool-error-state.json'), JSON.stringify(sanitizedState));
    }

    const holder = startSqliteMutationLockHolder(join(stateDir, '.state-mutation-locks.db'));
    try {
      await holder.ready;
      const startedAt = Date.now();
      const cleanup = spawnSync(NODE, [SCRIPT_PATH, '--purge-legacy-tool-failure-state', omcRoot, '1500'], {
        encoding: 'utf-8',
        timeout: 5000,
        env: {
          ...process.env,
          OMC_HOOK_BACKGROUND_CHILD: '1',
          OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '1',
        },
      });

      expect(cleanup.error).toBeUndefined();
      expect(cleanup.status).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(800);
      expect(readFileSync(join(sessionsDir, 'session-sanitized-0', 'last-tool-error-state.json'), 'utf8'))
        .toBe(JSON.stringify(sanitizedState));
    } finally {
      await holder.release();
    }
  });

  it('retries deferred cleanup after its own lock wait expires', async () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const legacyPath = join(stateDir, 'last-tool-error.json');
    const deferredCleanupReadyPath = join(tempDir, 'deferred-cleanup-ready');
    const holder = startPostToolFailureLockHolder(legacyPath);

    try {
      await holder.ready;
      writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'deferred legacy secret' }));
      const cleanup = spawnSync(NODE, [SCRIPT_PATH, '--purge-legacy-tool-failure-state', join(fakeProject, '.omc'), '100'], {
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
          ...process.env,
          OMC_HOOK_BACKGROUND_CHILD: '1',
          OMC_TEST_TOOL_FAILURE_DEFERRED_CLEANUP_READY_PATH: deferredCleanupReadyPath,
        },
      });
      expect(cleanup.error).toBeUndefined();
      expect(cleanup.status).toBe(0);
      expect(await waitForFilesToAppear([deferredCleanupReadyPath], 15_000)).toBe(true);
      expect(existsSync(legacyPath)).toBe(true);

      expect(await holder.release()).toEqual({ code: 0, signal: null });
      expect(await waitForFilesToDisappear([legacyPath], 15_000)).toBe(true);
    } finally {
      await holder.release();
    }
  });

  it('purges legacy tool-failure state from the home root on no-workspace startup', () => {
    const homeStateDir = join(fakeHome, '.omc', 'state');
    const homeSessionDir = join(homeStateDir, 'sessions', 'session-old-home');
    const otherWorkspaceRecord = join(fakeProject, '.omc', 'state', 'last-tool-error.json');
    mkdirSync(homeSessionDir, { recursive: true });
    const homeRootRecord = join(homeStateDir, 'last-tool-error.json');
    const homeSessionRecord = join(homeSessionDir, 'last-tool-error-state.json');
    writeFileSync(homeRootRecord, JSON.stringify({ tool_input_preview: 'legacy home secret' }));
    writeFileSync(homeSessionRecord, JSON.stringify({ tool_input_preview: 'legacy home session secret' }));
    writeFileSync(otherWorkspaceRecord, JSON.stringify({ tool_input_preview: 'unrelated workspace secret' }));

    const output = JSON.parse(execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'session-no-workspace', cwd: tempDir }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: '',
        OMC_STATE_DIR: '',
      },
      timeout: 15000,
    }));

    expect(output.continue).toBe(true);
    expect(existsSync(homeRootRecord)).toBe(false);
    expect(existsSync(homeSessionRecord)).toBe(false);
    expect(existsSync(otherWorkspaceRecord)).toBe(true);

    const customRoot = join(tempDir, 'custom-state');
    const customStateDir = join(customRoot, 'non-git', 'state');
    const customSessionDir = join(customStateDir, 'sessions', 'session-old-custom');
    mkdirSync(customSessionDir, { recursive: true });
    const customRootRecord = join(customStateDir, 'last-tool-error.json');
    const customSessionRecord = join(customSessionDir, 'last-tool-error-state.json');
    writeFileSync(customRootRecord, JSON.stringify({ tool_input_preview: 'legacy custom-root secret' }));
    writeFileSync(customSessionRecord, JSON.stringify({ tool_input_preview: 'legacy custom-session secret' }));

    const customOutput = JSON.parse(execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-no-workspace-custom',
        cwd: tempDir,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: '',
        OMC_STATE_DIR: customRoot,
      },
      timeout: 15000,
    }));

    expect(customOutput.continue).toBe(true);
    expect(existsSync(customRootRecord)).toBe(false);
    expect(existsSync(customSessionRecord)).toBe(false);
    expect(existsSync(otherWorkspaceRecord)).toBe(true);
  });

  it('publishes plugin occupancy before deferring no-workspace cleanup', () => {
    const pluginRoot = join(tempDir, 'plugins', 'cache', 'omc', 'current');
    const configDir = join(tempDir, 'claude-config');
    const registryDir = join(configDir, '.omc', 'cache-occupancy');
    mkdirSync(pluginRoot, { recursive: true });

    const output = JSON.parse(execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'session-no-workspace-plugin', cwd: tempDir }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_SESSION_OWNER_PID: String(process.pid),
        OMC_STATE_DIR: '',
        OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '0',
        NODE_ENV: 'test',
      },
      timeout: 15000,
    }));

    expect(output.continue).toBe(true);
    const records = readdirSync(registryDir).map(name => JSON.parse(readFileSync(join(registryDir, name), 'utf-8')));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ pid: process.pid, pluginRoot });
    expect(records[0].processStartIdentity).toEqual(expect.any(String));
  });

  it.skipIf(process.platform === 'win32')('does not follow symlinked session directories or state files', () => {
    const sessionsDir = join(fakeProject, '.omc', 'state', 'sessions');
    const externalSessionDir = join(tempDir, 'external-session');
    mkdirSync(externalSessionDir, { recursive: true });
    const externalDirectoryState = join(externalSessionDir, 'last-tool-error-state.json');
    writeFileSync(externalDirectoryState, 'preserve through directory symlink');
    const directoryLink = join(sessionsDir, 'session-directory-link');
    symlinkSync(externalSessionDir, directoryLink, 'dir');

    const fileSessionDir = join(sessionsDir, 'session-file-link');
    mkdirSync(fileSessionDir, { recursive: true });
    const externalFileState = join(tempDir, 'external-state.json');
    writeFileSync(externalFileState, 'preserve through file symlink');
    const fileLink = join(fileSessionDir, 'last-tool-error-state.json');
    symlinkSync(externalFileState, fileLink, 'file');

    execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-current',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: '',
        OMC_STATE_DIR: '',
      },
      timeout: 15000,
    });

    expect(existsSync(directoryLink)).toBe(true);
    expect(existsSync(externalDirectoryState)).toBe(true);
    expect(existsSync(fileLink)).toBe(true);
    expect(existsSync(externalFileState)).toBe(true);
  });

  it('injects persisted project memory into session-start additionalContext', () => {
    mkdirSync(join(fakeProject, '.omc'), { recursive: true });
    writeFileSync(
      join(fakeProject, '.omc', 'project-memory.json'),
      JSON.stringify({
        version: '1.0.0',
        lastScanned: Date.now(),
        projectRoot: fakeProject,
        techStack: {
          languages: [
            {
              name: 'TypeScript',
              version: '5.0.0',
              confidence: 'high',
              markers: ['tsconfig.json', 'package.json'],
            },
          ],
          frameworks: [],
          packageManager: 'pnpm',
          runtime: 'node',
        },
        build: {
          buildCommand: 'pnpm build',
          testCommand: 'pnpm test',
          lintCommand: null,
          devCommand: null,
          scripts: {},
        },
        conventions: {
          namingStyle: null,
          importStyle: null,
          testPattern: null,
          fileOrganization: null,
        },
        structure: {
          isMonorepo: false,
          workspaces: [],
          mainDirectories: ['src'],
          gitBranches: null,
        },
        customNotes: [
          {
            timestamp: Date.now(),
            source: 'manual',
            category: 'env',
            content: 'Requires LOCAL_API_BASE for smoke tests',
          },
        ],
        directoryMap: {},
        hotPaths: [],
        userDirectives: [
          {
            timestamp: Date.now(),
            directive: 'Preserve project memory directives at session start',
            context: '',
            source: 'explicit',
            priority: 'high',
          },
        ],
      }),
    );

    const raw = execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-1779',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
      timeout: 15000,
    }).trim();

    const output = JSON.parse(raw) as {
      continue: boolean;
      hookSpecificOutput?: { additionalContext?: string };
    };
    const context = output.hookSpecificOutput?.additionalContext || '';

    expect(output.continue).toBe(true);
    expect(context).toContain('<project-memory-context>');
    expect(context).toContain('[PROJECT MEMORY]');
    expect(context).toContain('Preserve project memory directives at session start');
    expect(context).toContain('[Project Environment]');
    expect(context).toContain('- TypeScript | pkg:pnpm | node');
    expect(context).toContain('- build=pnpm build | test=pnpm test');
    expect(context).toContain('[env] Requires LOCAL_API_BASE for smoke tests');
    expect(context).toContain('</project-memory-context>');
  });

  it('injects model routing override for non-standard providers before lower-priority context', () => {
    writeFileSync(
      join(fakeProject, 'AGENTS.md'),
      `# oh-my-claudecode - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>schema</guidance_schema_contract>

<operating_principles>
${'- oversized startup guidance\n'.repeat(700)}
</operating_principles>`,
    );

    const raw = execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-bedrock-script',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
      timeout: 15000,
    }).trim();

    const output = JSON.parse(raw) as {
      continue: boolean;
      hookSpecificOutput?: { additionalContext?: string };
    };
    const context = output.hookSpecificOutput?.additionalContext || '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MODEL ROUTING OVERRIDE');
    expect(context).toContain('tier alias');
    expect(context).toMatch(/\b(sonnet|opus|haiku)\b/);
    expect(context).not.toContain('Do NOT pass the `model` parameter');
    expect(context).not.toContain('Omit it entirely');
    expect(context.length).toBeLessThanOrEqual(6000);
  });

  it('surfaces update notices through systemMessage without injecting them into additionalContext', () => {
    const claudeDir = join(fakeHome, '.claude');
    const pluginRoot = join(tempDir, 'plugin');
    mkdirSync(join(claudeDir, '.omc'), { recursive: true });
    mkdirSync(join(claudeDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '1.0.0', type: 'module' }));
    writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));
    writeFileSync(
      join(claudeDir, '.omc', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '999.0.0',
        currentVersion: '1.0.0',
        updateAvailable: true,
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-update-script',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as {
      continue: boolean;
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(output.continue).toBe(true);
    expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage).toContain('v999.0.0');
    expect(output.systemMessage).toContain('/update');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('999.0.0');
  });

  it('does not show update notice when stale CLAUDE_PLUGIN_ROOT is older than plugin cache', () => {
    const claudeDir = join(fakeHome, '.claude');
    const stalePluginRoot = join(claudeDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.4');
    const latestPluginRoot = join(claudeDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.5');
    mkdirSync(join(claudeDir, '.omc'), { recursive: true });
    mkdirSync(join(claudeDir, 'hud'), { recursive: true });
    mkdirSync(stalePluginRoot, { recursive: true });
    mkdirSync(latestPluginRoot, { recursive: true });
    writeFileSync(join(stalePluginRoot, 'package.json'), JSON.stringify({ version: '4.14.4', type: 'module' }));
    writeFileSync(join(latestPluginRoot, 'package.json'), JSON.stringify({ version: '4.14.5', type: 'module' }));
    writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));
    writeFileSync(
      join(claudeDir, '.omc', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '4.14.5',
        currentVersion: '4.14.4',
        updateAvailable: true,
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-stale-plugin-root',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: stalePluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as {
      continue: boolean;
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(output.continue).toBe(true);
    expect(output.systemMessage ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage ?? '').not.toContain('4.14.4');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
  });


  it('suppresses plugin update notices when npm latest is newer than the marketplace channel', () => {
    const claudeDir = join(fakeHome, '.claude');
    const pluginRoot = join(claudeDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.15.4');
    const marketplaceRoot = join(claudeDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(claudeDir, '.omc'), { recursive: true });
    mkdirSync(join(claudeDir, 'hud'), { recursive: true });
    mkdirSync(join(pluginRoot), { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.4', type: 'module' }));
    writeFileSync(join(marketplaceRoot, 'package.json'), JSON.stringify({ version: '4.15.4', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-claudecode', version: '4.15.4' }],
      version: '4.15.4',
    }));
    writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));
    writeFileSync(
      join(claudeDir, '.omc', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '4.15.5',
        currentVersion: '4.15.4',
        updateAvailable: true,
        source: 'npm',
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-marketplace-channel-current',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };
    expect(output.systemMessage ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage ?? '').not.toContain('4.15.5');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
  });

  it('does not fall back to npm notices when marketplace metadata is unavailable', () => {
    const claudeDir = join(fakeHome, '.claude');
    const pluginRoot = join(claudeDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.15.4');
    const marketplaceRoot = join(claudeDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(claudeDir, '.omc'), { recursive: true });
    mkdirSync(join(claudeDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.4', type: 'module' }));
    writeFileSync(join(marketplaceRoot, 'package.json'), JSON.stringify({ version: '999.0.0', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'oh-my-claudecode',
      version: '999.0.0',
    }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-claudecode', version: '999x.0.0' }],
    }));
    writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));
    writeFileSync(
      join(claudeDir, '.omc', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '4.15.5',
        currentVersion: '4.15.4',
        updateAvailable: true,
        source: 'npm',
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-marketplace-channel-unavailable',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage ?? '').not.toContain('4.15.5');
    expect(JSON.parse(readFileSync(join(claudeDir, '.omc', 'update-check.json'), 'utf-8'))).toMatchObject({
      latestVersion: '4.15.4',
      currentVersion: '4.15.4',
      updateAvailable: false,
      source: 'marketplace-unavailable',
    });
  });

  it('treats a stable marketplace version as newer than the matching prerelease', () => {
    const claudeDir = join(fakeHome, '.claude');
    const pluginRoot = join(claudeDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.16.0-beta.1');
    const marketplaceRoot = join(claudeDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(claudeDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.16.0-beta.1', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-claudecode', version: '4.16.0' }],
    }));
    writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-marketplace-stable-after-prerelease',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage).toContain('v4.16.0');
  });

  it('uses the marketplace clone version for plugin update notices instead of npm latest', () => {
    const claudeDir = join(fakeHome, '.claude');
    const pluginRoot = join(claudeDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.15.3');
    const marketplaceRoot = join(claudeDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(claudeDir, '.omc'), { recursive: true });
    mkdirSync(join(claudeDir, 'hud'), { recursive: true });
    mkdirSync(join(pluginRoot), { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.3', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-claudecode', version: '4.15.4' }],
      version: '4.15.4',
    }));
    writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));
    writeFileSync(
      join(claudeDir, '.omc', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '4.15.5',
        currentVersion: '4.15.3',
        updateAvailable: true,
        source: 'npm',
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-marketplace-channel-update',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage).toContain('v4.15.4');
    expect(output.systemMessage).not.toContain('4.15.5');
    expect(output.systemMessage).toContain('/plugin marketplace update omc && /omc-setup');
    expect(output.systemMessage).not.toContain('/update');
  });

  it('does not emit npm-channel drift guidance when managed marketplace plugin is current', () => {
    const claudeDir = join(fakeHome, '.claude');
    const pluginRoot = join(claudeDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.15.4');
    const marketplaceRoot = join(claudeDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(claudeDir, '.omc'), { recursive: true });
    mkdirSync(join(claudeDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.4', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-claudecode', version: '4.15.4' }],
    }));
    writeFileSync(join(claudeDir, '.omc-version.json'), JSON.stringify({ version: '4.15.5' }));
    writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));
    writeFileSync(
      join(claudeDir, '.omc', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '4.15.5',
        currentVersion: '4.15.4',
        updateAvailable: true,
        source: 'npm',
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-marketplace-current-npm-newer',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as {
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    const combined = `${output.systemMessage ?? ''}\n${output.hookSpecificOutput?.additionalContext ?? ''}`;
    expect(combined).not.toContain('[OMC VERSION DRIFT DETECTED]');
    expect(combined).not.toContain("Run 'omc update'");
    expect(combined).not.toContain('4.15.5');
  });

  describe('CLAUDE.md version drift and claudeMdEnabled', () => {
    function runDriftSession(claudeMdEnabled: boolean | undefined): string {
      const claudeDir = join(fakeHome, '.claude');
      const pluginRoot = join(tempDir, 'local-plugin-4.15.4');
      mkdirSync(join(claudeDir, '.omc'), { recursive: true });
      mkdirSync(join(claudeDir, 'hud'), { recursive: true });
      mkdirSync(pluginRoot, { recursive: true });
      writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.4', type: 'module' }));
      writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# My own global config without OMC markers\n');
      if (claudeMdEnabled !== undefined) {
        writeFileSync(join(claudeDir, '.omc-config.json'), JSON.stringify({ claudeMdEnabled }));
      }

      const result = spawnSync(NODE, [SCRIPT_PATH], {
        input: JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: `session-claude-md-drift-${String(claudeMdEnabled)}`,
          cwd: fakeProject,
        }),
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          OMC_NOTIFY: '0',
        },
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        systemMessage?: string;
        hookSpecificOutput?: { additionalContext?: string };
      };
      return `${output.systemMessage ?? ''}\n${output.hookSpecificOutput?.additionalContext ?? ''}`;
    }

    it('reports CLAUDE.md drift when claudeMdEnabled is absent', () => {
      const combined = runDriftSession(undefined);
      expect(combined).toContain('[OMC VERSION DRIFT DETECTED]');
      expect(combined).toContain('CLAUDE.md instructions: unknown (needs migration)');
    });

    it('reports CLAUDE.md drift when claudeMdEnabled is true', () => {
      const combined = runDriftSession(true);
      expect(combined).toContain('CLAUDE.md instructions: unknown (needs migration)');
    });

    it('does not report CLAUDE.md drift when claudeMdEnabled is false', () => {
      const combined = runDriftSession(false);
      expect(combined).not.toContain('CLAUDE.md instructions');
      expect(combined).not.toContain('[OMC VERSION DRIFT DETECTED]');
    });
  });

  it('shows an npm update from unmanaged 4.15.7 local plugin roots (#3867)', () => {
    const claudeDir = join(fakeHome, '.claude');
    const pluginRoot = join(tempDir, 'local-plugin-4.15.7');
    mkdirSync(join(claudeDir, '.omc'), { recursive: true });
    mkdirSync(join(claudeDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.7', type: 'module' }));
    writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));
    writeFileSync(
      join(claudeDir, '.omc', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '5.0.0',
        currentVersion: '4.15.7',
        updateAvailable: true,
        source: 'npm',
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-3867-unmanaged-4157',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage).toContain('v5.0.0');
    expect(output.systemMessage).toContain('current: v4.15.7');
    expect(output.systemMessage).not.toContain('4.15.7L');
  });

  it('does not advertise npm 5.0.0 when managed marketplace channel is still 4.15.7 (#3867)', () => {
    const claudeDir = join(fakeHome, '.claude');
    const pluginRoot = join(claudeDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.15.7');
    const marketplaceRoot = join(claudeDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(claudeDir, '.omc'), { recursive: true });
    mkdirSync(join(claudeDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.7', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-claudecode', version: '4.15.7' }],
      version: '4.15.7',
    }));
    writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));
    writeFileSync(
      join(claudeDir, '.omc', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '5.0.0',
        currentVersion: '4.15.7',
        updateAvailable: true,
        source: 'npm',
      }),
    );
    // CLAUDE_CONFIG_DIR beats HOME. A leaked host/empty config dir would hide
    // the fixture marketplace clone and leave the npm 5.0.0 cache in place.
    const leakedHostConfigDir = join(tempDir, 'host-empty-claude-config');
    mkdirSync(leakedHostConfigDir, { recursive: true });
    const leakedHostEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: leakedHostConfigDir,
    };

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-3867-managed-4157',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...leakedHostEnv,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage ?? '').not.toContain('5.0.0');
    expect(JSON.parse(readFileSync(join(claudeDir, '.omc', 'update-check.json'), 'utf-8'))).toMatchObject({
      latestVersion: '4.15.7',
      currentVersion: '4.15.7',
      updateAvailable: false,
      source: 'marketplace',
    });
  });
});
