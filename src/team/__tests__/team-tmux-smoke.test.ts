import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shutdownTeamV2, startTeamV2 } from '../runtime-v2.js';
import { executeTeamApiOperation } from '../api-interop.js';
import { readTeamConfig } from '../monitor.js';
import { createTeamInstanceBinding } from '../team-instance.js';
import { observeProcessIdentity } from '../team-owner-epoch.js';
import type { TeamEvent } from '../types.js';
import { observeTmuxServerIdentity, paneHasActiveTask, paneLooksReady } from '../tmux-session.js';
import { absPath, TeamPaths } from '../state-paths.js';
import { isTmuxAvailable, tmuxCmdAsync } from '../../cli/tmux-utils.js';
import { isProcessAlive } from '../../platform/process-utils.js';

const SMOKE_ENABLED = process.env.OMC_TEAM_TMUX_SMOKE === '1'
  && process.platform !== 'win32'
  && isTmuxAvailable();

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FAKE_PROVIDER = join(REPO_ROOT, 'src', 'team', '__tests__', 'fixtures', 'fake-team-provider.mjs');
const OMC_CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const TSX_LOADER_URL = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
// Outside /tmp because provider preflight rejects binaries resolved there,
// and outside bridge/ so a run never rewrites the tracked bundle.
const SMOKE_CACHE = join(REPO_ROOT, 'node_modules', '.cache', 'omc-team-tmux-smoke');
const RUNTIME_CLI_PATH = join(SMOKE_CACHE, 'bridge', 'runtime-cli.cjs');
const SHUTDOWN_ACK_TIMEOUT_MS = 30_000;
// Live lanes pick a fake-team-provider.mjs scenario; only the default one
// meets every assertion below.
const FAKE_PROVIDER_SCENARIO = process.env.OMC_FAKE_PROVIDER_SCENARIO;
const execFileAsync = promisify(execFile);

type TraceEntry = {
  step: string;
  pid: number;
  process_started_at: string | null;
  failed_step?: string;
  message?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function writeExecutable(path: string, lines: string[]): Promise<void> {
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  await chmod(path, 0o755);
}

async function waitFor<T>(
  label: string,
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  diagnostics: () => Promise<string> = async () => '',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}; last=${JSON.stringify(value)}\n${await diagnostics()}`);
    }
    await sleep(100);
    value = await read();
  }
  return value;
}

async function listPaneIds(socketPath: string): Promise<string[] | null> {
  try {
    const { stdout } = await tmuxCmdAsync(
      ['-S', socketPath, 'list-panes', '-a', '-F', '#{pane_id}'],
      { timeout: 2_000, stripTmux: true },
    );
    return stdout.split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

async function capturePane(socketPath: string, paneId: string): Promise<string> {
  const { stdout } = await tmuxCmdAsync(
    ['-S', socketPath, 'capture-pane', '-p', '-t', paneId, '-S', '-80'],
    { timeout: 2_000, stripTmux: true },
  );
  return stdout;
}

async function processesMentioning(markers: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync('ps', ['-A', '-ww', '-o', 'pid=,args=']);
  return stdout
    .split('\n')
    .filter(line => markers.some(marker => line.includes(marker)))
    .map(line => line.trim());
}

function socketRefusesConnections(socketPath: string): Promise<boolean> {
  return new Promise(resolveProbe => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolveProbe(false);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      resolveProbe(error.code === 'ECONNREFUSED' || error.code === 'ENOENT');
    });
  });
}

// createTeamSession starts its detached server on /tmp/o-<leader pid>-*.sock.
// Cleanup kills only sockets that appeared during the test, because an older
// socket under a reused pid can belong to someone's live team.
async function privateSockets(): Promise<string[]> {
  const prefix = `o-${process.pid.toString(36)}-`;
  const entries = await readdir('/tmp').catch(() => [] as string[]);
  return entries
    .filter(name => name.startsWith(prefix) && name.endsWith('.sock'))
    .map(name => join('/tmp', name));
}

describe.skipIf(!SMOKE_ENABLED)('team tmux smoke: fake claude worker lifecycle', () => {
  beforeAll(async () => {
    // Mirror the checkout minus bridge/ so the real build script emits a
    // private bundle that still resolves the repo's native addon.
    await mkdir(SMOKE_CACHE, { recursive: true });
    for (const entry of await readdir(REPO_ROOT)) {
      if (['bridge', 'node_modules', '.git'].includes(entry)) continue;
      await rm(join(SMOKE_CACHE, entry), { force: true });
      await symlink(join(REPO_ROOT, entry), join(SMOKE_CACHE, entry));
    }
    execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'build-runtime-cli.mjs')], {
      cwd: SMOKE_CACHE,
      stdio: 'pipe',
    });
  }, 120_000);

  let fixtureRoot = '';
  let runRoot = '';
  let runtimeCliPath = '';
  let cwd = '';
  let tracePath = '';
  let socketsBefore = new Set<string>();
  const savedEnv = new Map<string, string | undefined>();

  async function readTrace(): Promise<TraceEntry[]> {
    const raw = await readFile(tracePath, 'utf8').catch(() => '');
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as TraceEntry);
  }

  async function traceDiagnostics(): Promise<string> {
    return `fake provider trace:\n${await readFile(tracePath, 'utf8').catch(() => '<none>')}`;
  }

  beforeEach(async () => {
    // Short root: tmux socket paths must stay under the Darwin sun_path limit.
    fixtureRoot = await mkdtemp(join(tmpdir(), 'omc-smoke-'));
    runRoot = await mkdtemp(join(SMOKE_CACHE, 'run-'));
    const binDir = join(runRoot, 'bin');
    // Every runtime-cli process names its entry in argv. A per-run link gives
    // the leftover scan a marker that concurrent runs in this checkout lack;
    // node resolves the link, so the bundle still loads from its real home.
    runtimeCliPath = join(runRoot, 'bridge', 'runtime-cli.cjs');
    const home = join(fixtureRoot, 'home');
    const privateTmp = join(fixtureRoot, 'tmp');
    cwd = join(fixtureRoot, 'workdir');
    tracePath = join(fixtureRoot, 'fake-provider.trace.jsonl');
    for (const dir of [binDir, dirname(runtimeCliPath), home, privateTmp, cwd, join(fixtureRoot, 'state'), join(fixtureRoot, 'tmux')]) {
      await mkdir(dir, { recursive: true });
    }

    await symlink(RUNTIME_CLI_PATH, runtimeCliPath);
    await writeExecutable(join(binDir, 'claude'), [
      '#!/bin/sh',
      // Login shells may reorder PATH (macOS path_helper); pin the omc shim.
      `export PATH=${shellQuote(binDir)}:"$PATH"`,
      `exec ${shellQuote(process.execPath)} --import ${shellQuote(TSX_LOADER_URL)} ${shellQuote(FAKE_PROVIDER)} --trace ${shellQuote(tracePath)}${FAKE_PROVIDER_SCENARIO ? ` --scenario ${shellQuote(FAKE_PROVIDER_SCENARIO)}` : ''} "$@"`,
    ]);
    await writeExecutable(join(binDir, 'omc'), [
      '#!/bin/sh',
      `exec ${shellQuote(process.execPath)} --import ${shellQuote(TSX_LOADER_URL)} ${shellQuote(OMC_CLI_ENTRY)} "$@"`,
    ]);

    const privateEnv: Record<string, string | undefined> = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      OMC_STATE_DIR: join(fixtureRoot, 'state'),
      OMC_RUNTIME_CLI_PATH: runtimeCliPath,
      TMUX_TMPDIR: join(fixtureRoot, 'tmux'),
      TMPDIR: privateTmp,
      TEMP: privateTmp,
      TMP: privateTmp,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      SHELL: '/bin/sh',
      TMUX: undefined,
      TMUX_PANE: undefined,
      PSMUX_SESSION: undefined,
      CMUX_SURFACE_ID: undefined,
      CMUX_WORKSPACE_ID: undefined,
      HERDR_PANE_ID: undefined,
      OMC_TEAM_MULTIPLEXER: 'tmux',
      OMC_TEAM_WORKTREE_MODE: undefined,
      OMC_TEAM_WORKER_ENV_PASSTHROUGH: undefined,
      OMC_TEAM_WORKER: undefined,
      OMC_TEAM_NAME: undefined,
      CLAUDE_SESSION_ID: undefined,
      OMC_SESSION_ID: undefined,
    };
    savedEnv.clear();
    for (const [key, value] of Object.entries(privateEnv)) {
      savedEnv.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    socketsBefore = new Set(await privateSockets());
  });

  afterEach(async () => {
    const leftovers: string[] = [];
    const providers = new Map((await readTrace()).map(entry => [entry.pid, entry.process_started_at]));
    for (const [pid, processStartedAt] of providers) {
      const state = processStartedAt
        ? observeProcessIdentity({ pid, process_started_at: processStartedAt })
        : isProcessAlive(pid) ? 'unknown' : 'dead';
      if (state === 'matching') {
        try { process.kill(pid, 'SIGKILL'); } catch { /* exited concurrently */ }
      } else if (state === 'unknown') {
        leftovers.push(`provider pid ${pid}: identity unverifiable, not signalled`);
      }
    }
    for (const socketPath of (await privateSockets()).filter(path => !socketsBefore.has(path))) {
      await tmuxCmdAsync(['-S', socketPath, 'kill-server'], { timeout: 2_000, stripTmux: true }).catch(() => undefined);
      const serverGone = await waitFor(
        `tmux server on ${socketPath} to exit`,
        () => socketRefusesConnections(socketPath),
        refused => refused,
        5_000,
      ).catch(() => false);
      if (serverGone) await rm(socketPath, { force: true });
      else leftovers.push(`tmux server still accepts connections on ${socketPath}; socket kept`);
    }
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(runRoot, { recursive: true, force: true });
    if (leftovers.length > 0) throw new Error(`smoke cleanup left live resources:\n${leftovers.join('\n')}`);
  });

  it('launches a worker that claims and completes its task, then acks shutdown and leaves nothing behind', async () => {
    const teamName = `tmux-smoke-${randomUUID().slice(0, 8)}`;
    const runtime = await startTeamV2({
      teamName,
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Smoke task', description: 'Claim this task, complete it, then wait for shutdown.' }],
      pluginConfig: {},
      cwd,
    });
    const serverIdentity = runtime.config.tmux_server_identity;
    const leaderCwd = runtime.cwd;

    expect(runtime.startupFailures, await traceDiagnostics()).toEqual([]);
    expect(serverIdentity?.socket_path).toEqual(expect.any(String));
    const socketPath = serverIdentity!.socket_path;
    const [worker] = runtime.config.workers;
    expect(worker).toMatchObject({ name: 'worker-1', assigned_tasks: ['1'], pane_id: expect.stringMatching(/^%\d+$/) });
    const paneId = worker!.pane_id!;
    expect(await listPaneIds(socketPath)).toContain(paneId);

    const completed = await waitFor(
      'task 1 to be completed through the worker API',
      async () => {
        const envelope = await executeTeamApiOperation('read-task', { team_name: runtime.teamName, task_id: '1' }, leaderCwd);
        return envelope.ok ? (envelope.data.task as { status?: string; owner?: string }) : null;
      },
      task => task?.status === 'completed',
      30_000,
      traceDiagnostics,
    );
    expect(completed).toMatchObject({ status: 'completed', owner: 'worker-1' });

    await waitFor(
      'worker pane to return to an idle prompt',
      () => capturePane(socketPath, paneId),
      captured => paneLooksReady(captured, 'claude') && !paneHasActiveTask(captured, 'claude'),
      10_000,
      traceDiagnostics,
    );

    // Cleanup deletes events.jsonl; a hard link keeps the leader's appends readable.
    const eventsWitness = join(fixtureRoot, 'events.witness.jsonl');
    await link(absPath(leaderCwd, TeamPaths.events(runtime.teamName)), eventsWitness);
    const shutdown = await shutdownTeamV2(runtime.teamName, leaderCwd, {
      instanceId: runtime.instanceId,
      timeoutMs: SHUTDOWN_ACK_TIMEOUT_MS,
    });
    expect(shutdown).toEqual({ outcome: 'cleaned' });
    const leaderEvents = (await readFile(eventsWitness, 'utf8'))
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as TeamEvent);
    expect(leaderEvents.filter(event => event.type === 'shutdown_ack'), 'leader never consumed the worker shutdown ack')
      .toEqual([expect.objectContaining({ worker: 'worker-1', reason: 'accept' })]);

    const providerSteps = (await readTrace()).map(entry => entry.step);
    expect(providerSteps.slice(-2), await traceDiagnostics()).toEqual(['write-shutdown-ack', 'exit']);

    expect((await listPaneIds(socketPath))?.includes(paneId) ?? false).toBe(false);
    await waitFor('team tmux server to exit', () => observeTmuxServerIdentity(serverIdentity!), state => state === 'dead', 10_000);

    expect(await readTeamConfig(runtime.teamName, leaderCwd)).toBeNull();
    expect(existsSync(absPath(leaderCwd, TeamPaths.root(runtime.teamName)))).toBe(false);
    const binding = createTeamInstanceBinding({ teamName: runtime.teamName, cwd: leaderCwd, instanceId: runtime.instanceId });
    const receipt = JSON.parse(await readFile(
      absPath(leaderCwd, TeamPaths.teamInstanceCleanupReceipt(binding.workspace_hash, runtime.teamName, runtime.instanceId)),
      'utf8',
    )) as Record<string, unknown>;
    expect(receipt).toMatchObject({ kind: 'team-instance-cleanup', instance_id: runtime.instanceId, phase: 'completed' });
    expect(existsSync(absPath(leaderCwd, TeamPaths.teamInstanceReservation(binding.workspace_hash, runtime.teamName)))).toBe(false);

    const providerPids = [...new Set((await readTrace()).map(entry => entry.pid))];
    expect(providerPids).toHaveLength(1);
    expect(isProcessAlive(providerPids[0]!)).toBe(false);
    await waitFor(
      'no worker, bootstrap, or provider process from this run',
      () => processesMentioning([fixtureRoot, runRoot, runtime.teamName]),
      leftovers => leftovers.length === 0,
      10_000,
    );
  }, 180_000);
});
