import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentProcessStartIdentity } from '../team-owner-epoch.js';
import {
  activateTeamInstanceUnderLock,
  createTeamInstanceBinding,
  reserveTeamInstance,
  withTeamInstanceLifecycleLock,
} from '../team-instance.js';
import {
  awaitWorkerLaunchAcknowledgement,
  awaitWorkerLaunchProviderStarted,
  buildWorkerLaunchBootstrapSpec,
  isWorkerLaunchAttemptAccepted,
  isWorkerLaunchAttemptCurrent,
  observeWorkerLaunchProvider,
  prepareWorkerLaunchAttempt,
  revokeWorkerLaunchAttempt,
  runWorkerLaunchBootstrap,
  terminateWorkerLaunchProvider,
  type WorkerLaunchAttempt,
  type WorkerLaunchBootstrapResult,
} from '../worker-launch-ack.js';
import {
  adoptWorkerPaneOwnership,
  captureTmuxServerIdentity,
  observeTmuxServerIdentity,
} from '../tmux-session.js';
import type { TmuxServerIdentity } from '../types.js';
import { absPath, TeamPaths } from '../state-paths.js';
import { tmuxCmdAsync, isTmuxAvailable } from '../../cli/tmux-utils.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import {
  captureOwnedProcessGroup,
  isProcessAlive,
  terminateOwnedProcessGroup,
  type OwnedProcessGroup,
} from '../../platform/process-utils.js';

const TEAM_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const REPLACEMENT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const INCARNATION_A_INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const INCARNATION_B_INSTANCE_ID = '44444444-4444-4444-8444-444444444444';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNTIME_CLI_PATH = join(REPO_ROOT, 'bridge', 'runtime-cli.cjs');
const HAS_POSIX_TMUX = process.platform !== 'win32' && isTmuxAvailable();

type StartedRecord = {
  pid: number;
  process_start_identity: string;
  process_group_id?: number;
};

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

const PRIVATE_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'CLAUDE_CONFIG_DIR',
  'OMC_STATE_DIR',
  'OMC_RUNTIME_CLI_PATH',
  'TMUX_TMPDIR',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TMUX',
  'PSMUX_SESSION',
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitBounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const settled = promise.then(
    value => ({ kind: 'value' as const, value }),
    () => ({ kind: 'rejected' as const }),
  );
  const timeout = new Promise<{ kind: 'timeout' }>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result.kind === 'value' ? result.value : undefined;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('shutdown_owner_exit_timeout'));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function processGroupIsAbsent(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function createPrivateTmuxSession(
  cwd: string,
  sessionName: string,
  socketPath: string,
): Promise<{
  leaderPaneId: string;
  workerPaneId: string;
  serverIdentity: TmuxServerIdentity;
  serverProcessGroup?: OwnedProcessGroup;
}> {
  const tmuxArgs = (args: string[]) => ['-S', socketPath, ...args];
  const created = await tmuxCmdAsync(tmuxArgs([
    'new-session', '-d', '-P', '-F', '#S:#{window_index} #{pane_id}',
    '-s', sessionName, '-x', '120', '-y', '40', '-c', cwd,
  ]), { timeout: 5_000, stripTmux: true });
  const createdMatch = created.stdout.trim().match(/^\S+\s+(%\d+)$/);
  if (!createdMatch?.[1]) throw new Error(`private_tmux_leader_missing:${created.stdout.trim()}`);
  const split = await tmuxCmdAsync(tmuxArgs([
    'split-window', '-h', '-d', '-P', '-F', '#{pane_id}',
    '-t', `${sessionName}:0`, '-c', cwd,
  ]), { timeout: 5_000, stripTmux: true });
  const workerPaneId = split.stdout.trim().split(/\s+/)[0] ?? '';
  if (!/^%\d+$/.test(workerPaneId)) throw new Error(`private_tmux_worker_missing:${split.stdout.trim()}`);
  const serverIdentity = await captureTmuxServerIdentity(socketPath);
  if (!serverIdentity) throw new Error('private_tmux_server_identity_missing');
  const serverProcessGroup = captureOwnedProcessGroup(serverIdentity.server_pid);
  return {
    leaderPaneId: createdMatch[1],
    workerPaneId,
    serverIdentity,
    ...(serverProcessGroup
      && serverProcessGroup.pid !== process.pid
      && serverProcessGroup.pid === serverProcessGroup.processGroupId
      ? { serverProcessGroup }
      : {}),
  };
}

async function waitForShutdownFence(
  configPath: string,
  childPid: number,
  instanceId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      const attempt = config.shutdown_attempt as Record<string, unknown> | undefined;
      if (
        config.lifecycle_state === 'shutting_down'
        && attempt?.pid === childPid
        && typeof attempt.instance_id === 'string'
        && attempt.instance_id.toLowerCase() === instanceId.toLowerCase()
      ) {
        return config;
      }
    } catch {
      // The child may still be publishing the first durable config revision.
    }
    await sleep(25);
  }
  throw new Error(`shutdown_fence_not_observed:${childPid}`);
}

type PrivateTmuxPaneState = 'alive' | 'dead' | 'unknown';

/**
 * Parse the complete native pane inventory used as the removal proof. A
 * successful command with no records is not proof: tmux may have failed before
 * emitting output. Duplicate or malformed rows are likewise unknown.
 */
function parsePrivateTmuxPaneInventory(output: string): Map<string, Exclude<PrivateTmuxPaneState, 'unknown'>> | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0 || lines.some(line => line.length === 0)) return null;
  const panes = new Map<string, Exclude<PrivateTmuxPaneState, 'unknown'>>();
  for (const line of lines) {
    const match = line.match(/^(%\d+) ([01])$/);
    if (!match || panes.has(match[1]!)) return null;
    panes.set(match[1]!, match[2] === '0' ? 'alive' : 'dead');
  }
  return panes;
}

async function queryPrivateTmuxPaneLiveness(
  socketPath: string,
  paneId: string,
): Promise<PrivateTmuxPaneState> {
  const tmuxOptions = { timeout: 2_000, stripTmux: true };
  let display: { stdout: string; stderr: string } | null = null;
  try {
    display = await tmuxCmdAsync([
      '-S', socketPath, 'display-message', '-t', paneId, '-p', '#{pane_dead}',
    ], tmuxOptions);
  } catch {
    // Fall through to the complete inventory. An error alone is unknown.
  }
  if (display && !display.stderr.trim()) {
    const state = display.stdout.replace(/\r?\n$/, '');
    if (state === '0') return 'alive';
    if (state === '1') return 'dead';
  }

  let inventory: { stdout: string; stderr: string };
  try {
    inventory = await tmuxCmdAsync([
      '-S', socketPath, 'list-panes', '-a', '-F', '#{pane_id} #{pane_dead}',
    ], tmuxOptions);
  } catch {
    return 'unknown';
  }
  if (inventory.stderr.trim()) return 'unknown';
  const panes = parsePrivateTmuxPaneInventory(inventory.stdout);
  if (!panes) return 'unknown';
  return panes.get(paneId) ?? 'dead';
}

async function waitForPaneLiveness(
  socketPath: string,
  paneId: string,
  expected: 'alive' | 'dead',
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await queryPrivateTmuxPaneLiveness(socketPath, paneId) === expected) return true;
    await sleep(25);
  }
  return await queryPrivateTmuxPaneLiveness(socketPath, paneId) === expected;
}

async function waitForTmuxServerDead(
  identity: TmuxServerIdentity,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await observeTmuxServerIdentity(identity) === 'dead') return;
    await sleep(25);
  }
  throw new Error(`private_tmux_server_death_not_observed:${identity.server_pid}`);
}

async function waitForTmuxServerMatching(
  identity: TmuxServerIdentity,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await observeTmuxServerIdentity(identity) === 'matching') return;
    await sleep(25);
  }
  throw new Error(`private_tmux_server_matching_not_observed:${identity.server_pid}`);
}

function fixtureManifest(config: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 2,
    state_revision: config.state_revision,
    name: config.name,
    instance_id: config.instance_id,
    tmux_server_identity: config.tmux_server_identity,
    task: config.task,
    leader: {
      session_id: `fixture-${String(config.name)}`,
      worker_id: 'leader-fixed',
      role: 'leader',
    },
    policy: {
      display_mode: 'split_pane',
      worker_launch_mode: config.worker_launch_mode ?? 'interactive',
      dispatch_mode: 'transport_direct',
      dispatch_ack_timeout_ms: 1_000,
    },
    governance: {
      delegation_only: false,
      plan_approval_required: false,
      nested_teams_allowed: false,
      one_team_per_leader_session: true,
      cleanup_requires_all_workers_inactive: true,
    },
    permissions_snapshot: {
      approval_mode: 'default',
      sandbox_mode: 'default',
      network_access: false,
    },
    tmux_session: config.tmux_session,
    worker_count: config.worker_count,
    workers: config.workers,
    next_task_id: config.next_task_id,
    created_at: config.created_at,
    leader_cwd: config.leader_cwd,
    team_state_root: config.team_state_root,
    leader_pane_id: config.leader_pane_id,
    hud_pane_id: config.hud_pane_id ?? null,
    resize_hook_name: config.resize_hook_name ?? null,
    resize_hook_target: config.resize_hook_target ?? null,
  };
}

async function persistFixtureConfigAndManifest(
  stateRoot: string,
  configPath: string,
  config: Record<string, unknown>,
): Promise<void> {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  await writeFile(join(stateRoot, 'manifest.json'), JSON.stringify(fixtureManifest(config), null, 2), 'utf8');
}

describe.skipIf(!HAS_POSIX_TMUX)('runtime v2 ordinary shutdown interruption', () => {
  beforeAll(() => {
    // kill-pane runs through the bundled identity guard. CI does not build
    // bridge/ before tests, so materialize runtime-cli.cjs next to the
    // package root where the native start-time addon can still be resolved.
    execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'build-runtime-cli.mjs')], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
    if (!existsSync(RUNTIME_CLI_PATH)) {
      throw new Error(`runtime_cli_bundle_missing:${RUNTIME_CLI_PATH}`);
    }
  });

  let fixtureRoot = '';
  let cwd = '';
  let home = '';
  let stateDir = '';
  let tmuxTmpDir = '';
  let tmuxSocketPath = '';
  let sessionName = '';
  let child: ChildProcess | undefined;
  let attempt: WorkerLaunchAttempt | undefined;
  let bootstrap: Promise<WorkerLaunchBootstrapResult> | undefined;
  let startedRecord: StartedRecord | undefined;
  let ownedLaunchGroup: OwnedProcessGroup | undefined;
  let launchAttempts: WorkerLaunchAttempt[] = [];
  let launchBootstraps: Array<Promise<WorkerLaunchBootstrapResult>> = [];
  let launchGroups: OwnedProcessGroup[] = [];
  let tmuxServerGroups: OwnedProcessGroup[] = [];
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    // Keep tmux's Unix-domain socket below macOS's pathname length limit.
    fixtureRoot = await mkdtemp(join(tmpdir(), 'omc-pr5-'));
    cwd = join(fixtureRoot, 'workdir');
    home = join(fixtureRoot, 'home');
    stateDir = join(fixtureRoot, 'state');
    tmuxTmpDir = join(fixtureRoot, 'tmux');
    tmuxSocketPath = join(tmuxTmpDir, 'default');
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await mkdir(tmuxTmpDir, { recursive: true });

    originalEnv.clear();
    for (const key of PRIVATE_ENV_KEYS) originalEnv.set(key, process.env[key]);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = join(home, 'config');
    process.env.XDG_CACHE_HOME = join(home, 'cache');
    process.env.XDG_DATA_HOME = join(home, 'data');
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
    process.env.OMC_STATE_DIR = stateDir;
    process.env.OMC_RUNTIME_CLI_PATH = RUNTIME_CLI_PATH;
    process.env.TMUX_TMPDIR = tmuxTmpDir;
    const privateTmpDir = join(fixtureRoot, 'tmp');
    process.env.TMPDIR = privateTmpDir;
    process.env.TEMP = privateTmpDir;
    process.env.TMP = privateTmpDir;
    delete process.env.TMUX;
    delete process.env.PSMUX_SESSION;
    await mkdir(privateTmpDir, { recursive: true });

    sessionName = `omc-shutdown-interruption-${randomUUID().slice(0, 8)}`;
    child = undefined;
    attempt = undefined;
    bootstrap = undefined;
    startedRecord = undefined;
    ownedLaunchGroup = undefined;
    launchAttempts = [];
    launchBootstraps = [];
    launchGroups = [];
    tmuxServerGroups = [];
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* child may have exited concurrently */ }
    }
    if (child) await waitBounded(waitForChildExit(child, 3_000), 3_500);
    const allAttempts = [...new Set([
      ...(attempt ? [attempt] : []),
      ...launchAttempts,
    ])];
    for (const launchAttempt of allAttempts) {
      if (existsSync(launchAttempt.expectedPath) || existsSync(launchAttempt.startedPath)) {
        await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
        await revokeWorkerLaunchAttempt(launchAttempt, 'test_cleanup').catch(() => false);
        await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
      }
    }
    // A failing disposal regression may already have removed its receipt.
    // Cleanup still requires the creation-bound group captured while owned.
    const allLaunchGroups = [...new Set([
      ...(ownedLaunchGroup ? [ownedLaunchGroup] : []),
      ...launchGroups,
    ])];
    for (const launchGroup of allLaunchGroups) {
      await terminateOwnedProcessGroup({
        pid: launchGroup.pid,
        expectedStartIdentity: launchGroup.processStartIdentity,
        processGroupId: launchGroup.processGroupId,
        deadlineAt: new Date(Date.now() + 2_000).toISOString(),
        force: true,
      }).catch(() => undefined);
    }
    const allBootstraps = [...new Set([
      ...(bootstrap ? [bootstrap] : []),
      ...launchBootstraps,
    ])];
    for (const launchBootstrap of allBootstraps) {
      await waitBounded(launchBootstrap, 4_000);
    }
    if (tmuxSocketPath) {
      await tmuxCmdAsync(
        ['-S', tmuxSocketPath, 'kill-server'],
        { timeout: 2_000, stripTmux: true },
      ).catch(() => undefined);
    }
    const allTmuxServerGroups = [...new Set(tmuxServerGroups)];
    for (const serverGroup of allTmuxServerGroups) {
      await terminateOwnedProcessGroup({
        pid: serverGroup.pid,
        expectedStartIdentity: serverGroup.processStartIdentity,
        processGroupId: serverGroup.processGroupId,
        deadlineAt: new Date(Date.now() + 2_000).toISOString(),
        force: true,
      }).catch(() => undefined);
    }
    for (const key of PRIVATE_ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = '';
    }
    tmuxSocketPath = '';
  });

  it('takes over an interrupted ordinary owner and cleans only its provider and panes', async () => {
    const teamName = 'shutdown-interruption-team';
    const workerName = 'worker-1';
    const runtimeCliPath = process.env.OMC_RUNTIME_CLI_PATH!;
    const stateRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);
    const configPath = join(stateRoot, 'config.json');
    const providerMarker = join(cwd, 'provider-started.json');
    const panes = await createPrivateTmuxSession(cwd, sessionName, tmuxSocketPath);
    if (panes.serverProcessGroup) tmuxServerGroups.push(panes.serverProcessGroup);
    await expect(waitForPaneLiveness(panes.serverIdentity.socket_path, panes.leaderPaneId, 'alive', 2_000)).resolves.toBe(true);
    await expect(waitForPaneLiveness(panes.serverIdentity.socket_path, panes.workerPaneId, 'alive', 2_000)).resolves.toBe(true);

    await reserveTeamInstance({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });
    attempt = await prepareWorkerLaunchAttempt({
      cwd,
      teamName,
      workerName,
      paneId: panes.workerPaneId,
      instanceId: TEAM_INSTANCE_ID,
      provider: 'claude',
      runtimeCliPath,
      context: { kind: 'initial' },
    });
    launchAttempts.push(attempt);
    const providerScript = [
      "const fs=require('node:fs')",
      `fs.writeFileSync(${JSON.stringify(providerMarker)}, JSON.stringify({pid:process.pid}))`,
      'setInterval(()=>{},1000)',
    ].join(';');
    // Keep the provider outside the tmux pane so shutdown must prove these
    // two independently owned resources rather than deriving provider death
    // from pane liveness.
    bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      attempt!,
      [process.execPath, '-e', providerScript],
      cwd,
    ));
    launchBootstraps.push(bootstrap);
    await expect(awaitWorkerLaunchAcknowledgement(attempt!, { timeoutMs: 2_000, pollIntervalMs: 5 }))
      .resolves.toEqual({ ok: true });
    await expect(awaitWorkerLaunchProviderStarted(attempt!, { timeoutMs: 10_000, pollIntervalMs: 5 }))
      .resolves.toBe(true);
    const started = JSON.parse(await readFile(attempt!.startedPath, 'utf8')) as StartedRecord;
    startedRecord = started;
    const capturedGroup = captureOwnedProcessGroup(started.pid);
    if (
      capturedGroup
      && capturedGroup.pid !== process.pid
      && capturedGroup.pid === capturedGroup.processGroupId
      && capturedGroup.processGroupId === started.process_group_id
      && capturedGroup.processStartIdentity === started.process_start_identity
    ) {
      ownedLaunchGroup = capturedGroup;
      launchGroups.push(capturedGroup);
    }
    expect(started.pid).toBeGreaterThan(0);
    expect(started.process_start_identity).toEqual(expect.any(String));
    expect(started.process_group_id).toBeGreaterThan(0);
    expect(existsSync(providerMarker)).toBe(true);
    expect(isProcessAlive(started.pid)).toBe(true);
    await expect(observeWorkerLaunchProvider(attempt!)).resolves.toBe('alive');

    const config = {
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: panes.serverIdentity,
      task: 'shutdown interruption',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: workerName,
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        pane_id: panes.workerPaneId,
        worker_cli: 'claude',
        launch_attempt_id: attempt.attempt_id,
        launch_descriptor: {
          schema_version: 1,
          provider: 'claude',
          model: null,
          binary: process.execPath,
          args: ['-e', providerScript],
        },
        working_dir: cwd,
        team_state_root: stateRoot,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${sessionName}:0`,
      tmux_window_owned: false,
      next_task_id: 1,
      leader_cwd: cwd,
      team_state_root: stateRoot,
      leader_pane_id: panes.leaderPaneId,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      lifecycle_state: 'active',
      state_revision: 0,
    };
    await persistFixtureConfigAndManifest(stateRoot, configPath, config);
    const binding = createTeamInstanceBinding({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });
    await withTeamInstanceLifecycleLock(cwd, teamName, () => activateTeamInstanceUnderLock(binding));

    const childResultPath = join(fixtureRoot, 'shutdown-child-result.json');
    const childScriptPath = join(fixtureRoot, 'shutdown-owner.mjs');
    const runtimeModuleUrl = pathToFileURL(join(REPO_ROOT, 'src', 'team', 'runtime-v2.ts')).href;
    await writeFile(childScriptPath, [
      "import { writeFile } from 'node:fs/promises';",
      `import { shutdownTeamV2 } from ${JSON.stringify(runtimeModuleUrl)};`,
      `const resultPath = ${JSON.stringify(childResultPath)};`,
      `try {`,
      `  const result = await shutdownTeamV2(${JSON.stringify(teamName)}, ${JSON.stringify(cwd)}, { instanceId: ${JSON.stringify(TEAM_INSTANCE_ID)}, timeoutMs: 8_000 });`,
      `  await writeFile(resultPath, JSON.stringify({ ok: true, result }));`,
      `} catch (error) {`,
      `  await writeFile(resultPath, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));`,
      `  process.exitCode = 1;`,
      `}`,
      '',
    ].join('\n'), 'utf8');
    child = spawn(process.execPath, ['--import', 'tsx', childScriptPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OMC_TEST_TEAM_NAME: teamName,
        OMC_TEST_CWD: cwd,
        OMC_TEST_INSTANCE_ID: TEAM_INSTANCE_ID,
      },
      stdio: 'ignore',
    });
    const childPid = child!.pid;
    if (!childPid) throw new Error('shutdown_owner_pid_missing');
    const childProcessStartIdentity = currentProcessStartIdentity(childPid);
    expect(childProcessStartIdentity).not.toBeNull();

    const fencedConfig = await waitForShutdownFence(configPath, childPid, TEAM_INSTANCE_ID, 5_000);
    const shutdownAttempt = fencedConfig.shutdown_attempt as Record<string, unknown>;
    expect(shutdownAttempt.pid).toBe(childPid);
    expect(shutdownAttempt.process_started_at).toBe(childProcessStartIdentity);
    expect(shutdownAttempt.instance_id).toBe(TEAM_INSTANCE_ID);
    expect(shutdownAttempt.nonce).toEqual(expect.any(String));
    expect(String(shutdownAttempt.nonce)).not.toMatch(/^all-dead-expiry:/);
    expect(child!.exitCode).toBeNull();
    expect(await observeWorkerLaunchProvider(attempt!)).toBe('alive');
    await expect(waitForPaneLiveness(panes.serverIdentity.socket_path, panes.workerPaneId, 'alive', 2_000)).resolves.toBe(true);

    // Interrupt only the owner process; its provider and tmux panes remain
    // live until the parent proves takeover and performs the retry.
    expect(child!.kill('SIGKILL')).toBe(true);
    await expect(waitForChildExit(child!, 4_000)).resolves.toMatchObject({ signal: 'SIGKILL' });
    expect(existsSync(childResultPath)).toBe(false);
    expect(await observeWorkerLaunchProvider(attempt!)).toBe('alive');
    await expect(waitForPaneLiveness(panes.serverIdentity.socket_path, panes.workerPaneId, 'alive', 2_000)).resolves.toBe(true);
    await expect(waitForTmuxServerMatching(panes.serverIdentity, 2_000)).resolves.toBeUndefined();

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, cwd, {
      instanceId: TEAM_INSTANCE_ID,
      force: true,
      timeoutMs: 0,
    })).resolves.toEqual({ outcome: 'cleaned' });
    const bootstrapResult = await waitBounded(bootstrap!, 5_000);
    expect(bootstrapResult).toMatchObject({ outcome: 'ran' });
    expect(startedRecord && isProcessAlive(startedRecord.pid)).toBe(false);
    expect(startedRecord?.process_group_id).toBeDefined();
    expect(processGroupIsAbsent(startedRecord!.process_group_id!)).toBe(true);
    await expect(waitForPaneLiveness(panes.serverIdentity.socket_path, panes.workerPaneId, 'dead', 2_000)).resolves.toBe(true);
    await expect(waitForPaneLiveness(panes.serverIdentity.socket_path, panes.leaderPaneId, 'alive', 2_000)).resolves.toBe(true);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(stateRoot)).toBe(false);

    const cleanupPath = absPath(cwd, TeamPaths.teamInstanceCleanupReceipt(
      binding.workspace_hash,
      teamName,
      TEAM_INSTANCE_ID,
    ));
    const reservationPath = absPath(cwd, TeamPaths.teamInstanceReservation(
      binding.workspace_hash,
      teamName,
    ));
    const cleanupReceipt = JSON.parse(await readFile(cleanupPath, 'utf8')) as Record<string, unknown>;
    expect(cleanupReceipt).toMatchObject({
      kind: 'team-instance-cleanup',
      instance_id: TEAM_INSTANCE_ID,
      phase: 'completed',
    });
    expect(existsSync(reservationPath)).toBe(false);

    await reserveTeamInstance({ teamName, cwd, instanceId: REPLACEMENT_INSTANCE_ID });
    const replacementConfig = {
      ...config,
      instance_id: REPLACEMENT_INSTANCE_ID,
      worker_count: 0,
      workers: [],
      state_revision: 0,
      lifecycle_state: 'active',
      leader_pane_id: panes.leaderPaneId,
    };
    await mkdir(stateRoot, { recursive: true });
    await writeFile(configPath, JSON.stringify(replacementConfig, null, 2), 'utf8');
    const replacementBinding = createTeamInstanceBinding({
      teamName,
      cwd,
      instanceId: REPLACEMENT_INSTANCE_ID,
    });
    await withTeamInstanceLifecycleLock(cwd, teamName, () =>
      activateTeamInstanceUnderLock(replacementBinding),
    );
    const replacementConfigBytes = await readFile(configPath, 'utf8');
    const replacementReservationPath = absPath(cwd, TeamPaths.teamInstanceReservation(
      replacementBinding.workspace_hash,
      teamName,
    ));
    const replacementReservationBytes = await readFile(replacementReservationPath, 'utf8');

    // A stale retry carries A's completed external receipt. It must not
    // inspect, rewrite, or delete the replacement B incarnation.
    await expect(shutdownTeamV2(teamName, cwd, {
      instanceId: TEAM_INSTANCE_ID,
      force: true,
      timeoutMs: 0,
    })).resolves.toEqual({ outcome: 'cleaned' });
    await expect(readFile(configPath, 'utf8')).resolves.toBe(replacementConfigBytes);
    await expect(readFile(replacementReservationPath, 'utf8')).resolves.toBe(replacementReservationBytes);
  });

  it('does not clean a reused private tmux server or its unrelated provider', async () => {
    const teamNameA = 'shutdown-incarnation-a';
    const teamNameB = 'shutdown-incarnation-b';
    const workerName = 'worker-1';
    const runtimeCliPath = process.env.OMC_RUNTIME_CLI_PATH!;
    const stateRootA = join(getOmcRoot(cwd), 'state', 'team', teamNameA);
    const stateRootB = join(getOmcRoot(cwd), 'state', 'team', teamNameB);
    const configPathA = join(stateRootA, 'config.json');
    const configPathB = join(stateRootB, 'config.json');
    const manifestPathB = join(stateRootB, 'manifest.json');
    const providerAStopPath = join(cwd, 'provider-a-stop');
    const providerAMarker = join(cwd, 'provider-a-started.json');
    const providerBStopPath = join(cwd, 'provider-b-stop');
    const providerBMarker = join(cwd, 'provider-b-started.json');

    const panesA = await createPrivateTmuxSession(cwd, sessionName, tmuxSocketPath);
    if (panesA.serverProcessGroup) tmuxServerGroups.push(panesA.serverProcessGroup);
    await expect(waitForPaneLiveness(panesA.serverIdentity.socket_path, panesA.leaderPaneId, 'alive', 2_000)).resolves.toBe(true);
    await expect(waitForPaneLiveness(panesA.serverIdentity.socket_path, panesA.workerPaneId, 'alive', 2_000)).resolves.toBe(true);

    await reserveTeamInstance({ teamName: teamNameA, cwd, instanceId: INCARNATION_A_INSTANCE_ID });
    const attemptA = await prepareWorkerLaunchAttempt({
      cwd,
      teamName: teamNameA,
      workerName,
      paneId: panesA.workerPaneId,
      instanceId: INCARNATION_A_INSTANCE_ID,
      provider: 'claude',
      runtimeCliPath,
      context: { kind: 'initial' },
    });
    launchAttempts.push(attemptA);
    const providerAScript = [
      "const fs=require('node:fs')",
      `const stopPath=${JSON.stringify(providerAStopPath)}`,
      `const markerPath=${JSON.stringify(providerAMarker)}`,
      'fs.writeFileSync(markerPath,JSON.stringify({pid:process.pid}))',
      'const timer=setInterval(()=>{if(fs.existsSync(stopPath)){clearInterval(timer);process.exit(0)}},10)',
    ].join(';');
    const bootstrapA = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      attemptA,
      [process.execPath, '-e', providerAScript],
      cwd,
    ));
    launchBootstraps.push(bootstrapA);
    await expect(awaitWorkerLaunchAcknowledgement(attemptA, { timeoutMs: 2_000, pollIntervalMs: 5 }))
      .resolves.toEqual({ ok: true });
    await expect(awaitWorkerLaunchProviderStarted(attemptA, { timeoutMs: 10_000, pollIntervalMs: 5 }))
      .resolves.toBe(true);
    const startedA = JSON.parse(await readFile(attemptA.startedPath, 'utf8')) as StartedRecord;
    const capturedGroupA = captureOwnedProcessGroup(startedA.pid);
    if (
      capturedGroupA
      && capturedGroupA.pid !== process.pid
      && capturedGroupA.pid === capturedGroupA.processGroupId
      && capturedGroupA.processGroupId === startedA.process_group_id
      && capturedGroupA.processStartIdentity === startedA.process_start_identity
    ) {
      launchGroups.push(capturedGroupA);
    }
    expect(existsSync(providerAMarker)).toBe(true);
    expect(isProcessAlive(startedA.pid)).toBe(true);
    await expect(isWorkerLaunchAttemptAccepted(attemptA)).resolves.toBe(true);
    await expect(isWorkerLaunchAttemptCurrent(attemptA)).resolves.toBe(true);
    await expect(observeWorkerLaunchProvider(attemptA)).resolves.toBe('alive');

    // Stop A through the provider's own protocol. This leaves an accepted,
    // current launch with a producer-written, cleanup-verified receipt.
    await writeFile(providerAStopPath, 'stop', 'utf8');
    await expect(bootstrapA).resolves.toMatchObject({ outcome: 'ran' });
    const terminalA = JSON.parse(await readFile(`${attemptA.startedPath}.terminal`, 'utf8')) as Record<string, unknown>;
    expect(terminalA).toMatchObject({
      kind: 'worker_launch_provider_terminal',
      attempt_id: attemptA.attempt_id,
      instance_id: INCARNATION_A_INSTANCE_ID,
      pid: startedA.pid,
      process_start_identity: startedA.process_start_identity,
      outcome: 'exit',
      cleanup_verified: true,
    });
    expect(isProcessAlive(startedA.pid)).toBe(false);
    expect(startedA.process_group_id).toBeGreaterThan(0);
    expect(processGroupIsAbsent(startedA.process_group_id!)).toBe(true);
    await expect(isWorkerLaunchAttemptCurrent(attemptA)).resolves.toBe(true);
    await expect(observeWorkerLaunchProvider(attemptA)).resolves.toBe('dead');
    await expect(terminateWorkerLaunchProvider(attemptA, 2_000)).resolves.toBe(true);

    const configA = {
      name: teamNameA,
      instance_id: INCARNATION_A_INSTANCE_ID,
      tmux_server_identity: panesA.serverIdentity,
      task: 'tmux server incarnation A',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: workerName,
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        pane_id: panesA.workerPaneId,
        worker_cli: 'claude',
        launch_attempt_id: attemptA.attempt_id,
        launch_descriptor: {
          schema_version: 1,
          provider: 'claude',
          model: null,
          binary: process.execPath,
          args: ['-e', providerAScript],
        },
        working_dir: cwd,
        team_state_root: stateRootA,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${sessionName}:0`,
      tmux_window_owned: false,
      next_task_id: 1,
      leader_cwd: cwd,
      team_state_root: stateRootA,
      leader_pane_id: panesA.leaderPaneId,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      lifecycle_state: 'active',
      state_revision: 0,
    };
    await persistFixtureConfigAndManifest(stateRootA, configPathA, configA);
    const manifestA = JSON.parse(await readFile(join(stateRootA, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifestA.tmux_server_identity).toEqual(panesA.serverIdentity);
    const bindingA = createTeamInstanceBinding({
      teamName: teamNameA,
      cwd,
      instanceId: INCARNATION_A_INSTANCE_ID,
    });
    await withTeamInstanceLifecycleLock(cwd, teamNameA, () =>
      activateTeamInstanceUnderLock(bindingA),
    );

    // Kill only server A, and require positive death before allowing a new
    // server to claim the same socket path.
    await tmuxCmdAsync(
      ['-S', tmuxSocketPath, 'kill-server'],
      { timeout: 5_000, stripTmux: true },
    );
    await expect(waitForTmuxServerDead(panesA.serverIdentity, 5_000)).resolves.toBeUndefined();

    const panesB = await createPrivateTmuxSession(cwd, sessionName, tmuxSocketPath);
    if (panesB.serverProcessGroup) tmuxServerGroups.push(panesB.serverProcessGroup);
    expect(panesB.serverIdentity).not.toEqual(panesA.serverIdentity);
    expect(panesB.leaderPaneId).toBe(panesA.leaderPaneId);
    expect(panesB.workerPaneId).toBe(panesA.workerPaneId);
    await expect(waitForPaneLiveness(panesB.serverIdentity.socket_path, panesB.leaderPaneId, 'alive', 2_000)).resolves.toBe(true);
    await expect(waitForPaneLiveness(panesB.serverIdentity.socket_path, panesB.workerPaneId, 'alive', 2_000)).resolves.toBe(true);

    await reserveTeamInstance({ teamName: teamNameB, cwd, instanceId: INCARNATION_B_INSTANCE_ID });
    const attemptB = await prepareWorkerLaunchAttempt({
      cwd,
      teamName: teamNameB,
      workerName,
      paneId: panesB.workerPaneId,
      instanceId: INCARNATION_B_INSTANCE_ID,
      provider: 'claude',
      runtimeCliPath,
      context: { kind: 'initial' },
    });
    launchAttempts.push(attemptB);
    const providerBScript = [
      "const fs=require('node:fs')",
      `const stopPath=${JSON.stringify(providerBStopPath)}`,
      `const markerPath=${JSON.stringify(providerBMarker)}`,
      'fs.writeFileSync(markerPath,JSON.stringify({pid:process.pid}))',
      'const timer=setInterval(()=>{if(fs.existsSync(stopPath)){clearInterval(timer);process.exit(0)}},10)',
    ].join(';');
    const bootstrapB = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      attemptB,
      [process.execPath, '-e', providerBScript],
      cwd,
    ));
    launchBootstraps.push(bootstrapB);
    await expect(awaitWorkerLaunchAcknowledgement(attemptB, { timeoutMs: 2_000, pollIntervalMs: 5 }))
      .resolves.toEqual({ ok: true });
    await expect(awaitWorkerLaunchProviderStarted(attemptB, { timeoutMs: 10_000, pollIntervalMs: 5 }))
      .resolves.toBe(true);
    const startedB = JSON.parse(await readFile(attemptB.startedPath, 'utf8')) as StartedRecord;
    const capturedGroupB = captureOwnedProcessGroup(startedB.pid);
    if (
      capturedGroupB
      && capturedGroupB.pid !== process.pid
      && capturedGroupB.pid === capturedGroupB.processGroupId
      && capturedGroupB.processGroupId === startedB.process_group_id
      && capturedGroupB.processStartIdentity === startedB.process_start_identity
    ) {
      launchGroups.push(capturedGroupB);
    }
    expect(existsSync(providerBMarker)).toBe(true);
    expect(isProcessAlive(startedB.pid)).toBe(true);
    expect(startedB.process_group_id).toBeGreaterThan(0);
    await expect(observeWorkerLaunchProvider(attemptB)).resolves.toBe('alive');

    const configB = {
      name: teamNameB,
      instance_id: INCARNATION_B_INSTANCE_ID,
      tmux_server_identity: panesB.serverIdentity,
      task: 'tmux server incarnation B',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: workerName,
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        pane_id: panesB.workerPaneId,
        worker_cli: 'claude',
        launch_attempt_id: attemptB.attempt_id,
        launch_descriptor: {
          schema_version: 1,
          provider: 'claude',
          model: null,
          binary: process.execPath,
          args: ['-e', providerBScript],
        },
        working_dir: cwd,
        team_state_root: stateRootB,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${sessionName}:0`,
      tmux_window_owned: false,
      next_task_id: 1,
      leader_cwd: cwd,
      team_state_root: stateRootB,
      leader_pane_id: panesB.leaderPaneId,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      lifecycle_state: 'active',
      state_revision: 0,
    };
    await persistFixtureConfigAndManifest(stateRootB, configPathB, configB);
    const manifestB = JSON.parse(await readFile(manifestPathB, 'utf8')) as Record<string, unknown>;
    expect(manifestB.tmux_server_identity).toEqual(panesB.serverIdentity);
    const bindingB = createTeamInstanceBinding({
      teamName: teamNameB,
      cwd,
      instanceId: INCARNATION_B_INSTANCE_ID,
    });
    await withTeamInstanceLifecycleLock(cwd, teamNameB, () =>
      activateTeamInstanceUnderLock(bindingB),
    );

    const reservationPathB = absPath(cwd, TeamPaths.teamInstanceReservation(
      bindingB.workspace_hash,
      teamNameB,
    ));
    const authoritativeBPaths = [configPathB, manifestPathB, reservationPathB];
    const authoritativeBBefore = await Promise.all(authoritativeBPaths.map(path => readFile(path, 'utf8')));

    const staleAdoption = await adoptWorkerPaneOwnership({
      provider: 'tmux',
      providerTarget: `${sessionName}:0`,
      paneId: panesB.workerPaneId,
      leaderPaneId: panesB.leaderPaneId,
      reservedPaneIds: [],
      tmuxServerIdentity: panesA.serverIdentity,
    });
    expect(staleAdoption.ok).toBe(false);
    if (!staleAdoption.ok) {
      expect(staleAdoption.reason).toContain('tmux_server_identity');
    }

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamNameA, cwd, {
      instanceId: INCARNATION_A_INSTANCE_ID,
      force: true,
      timeoutMs: 0,
    })).resolves.toEqual({ outcome: 'cleaned' });

    // A's positively dead server proves only A's pane is absent. The new B
    // server and its same-numbered pane/provider remain authoritative.
    await expect(waitForPaneLiveness(panesB.serverIdentity.socket_path, panesB.workerPaneId, 'alive', 2_000)).resolves.toBe(true);
    await expect(observeWorkerLaunchProvider(attemptB)).resolves.toBe('alive');
    expect(existsSync(configPathB)).toBe(true);
    expect(existsSync(stateRootB)).toBe(true);
    await expect(Promise.all(authoritativeBPaths.map(path => readFile(path, 'utf8'))))
      .resolves.toEqual(authoritativeBBefore);

    expect(existsSync(configPathA)).toBe(false);
    expect(existsSync(stateRootA)).toBe(false);
    const cleanupPathA = absPath(cwd, TeamPaths.teamInstanceCleanupReceipt(
      bindingA.workspace_hash,
      teamNameA,
      INCARNATION_A_INSTANCE_ID,
    ));
    await expect(readFile(cleanupPathA, 'utf8').then(value => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({
        kind: 'team-instance-cleanup',
        instance_id: INCARNATION_A_INSTANCE_ID,
        phase: 'completed',
      });
    const reservationPathA = absPath(cwd, TeamPaths.teamInstanceReservation(
      bindingA.workspace_hash,
      teamNameA,
    ));
    expect(existsSync(reservationPathA)).toBe(false);

    await writeFile(providerBStopPath, 'stop', 'utf8');
    await expect(bootstrapB).resolves.toMatchObject({ outcome: 'ran' });
    await expect(observeWorkerLaunchProvider(attemptB)).resolves.toBe('dead');
  });
});
