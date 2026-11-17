import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isProcessAlive } from '../../platform/process-utils.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { resolveRuntimeCliPath } from '../runtime-owner-client.js';
import { reserveTeamInstance } from '../team-instance.js';
import { currentStrictProcessStartIdentity } from '../team-owner-epoch.js';
import {
  awaitWorkerLaunchAcknowledgement,
  awaitWorkerLaunchProviderStarted,
  buildWorkerLaunchBootstrapSpec,
  prepareWorkerLaunchAttempt,
  runWorkerLaunchBootstrap,
  terminateWorkerLaunchProvider,
  withWorkerLaunchAttemptFence,
  type WorkerLaunchAttempt,
} from '../worker-launch-ack.js';

// The team shutdown loop reads the process tree of a worker pane before the provider of the worker is terminated and signals it
// only after the launch fence (current and accepted attempt) is held and the provider is gone (opt-in through
// OMC_TEAM_KILL_PANE_TREE, checked inside the two tree functions, which are mocks here). The launch records are real: the cases
// cover the call sites and their order around the fence, not the tree walk (see tmux-session.kill-pane-tree.test.ts).

const tmuxUtilsMocks = vi.hoisted(() => ({
  tmuxExecAsync: vi.fn(),
  tmuxCmdAsync: vi.fn(),
}));
const paneState = vi.hoisted(() => ({ killed: false, events: [] as string[] }));
const tmuxSessionMocks = vi.hoisted(() => ({
  observeTmuxServerIdentity: vi.fn(async () => 'matching' as const),
  // The pane counts as alive until the shutdown loop kills it.
  getOwnedWorkerLiveness: vi.fn(async (): Promise<'alive' | 'dead' | 'unknown'> => (paneState.killed ? 'dead' : 'alive')),
  observeTeamSessionTargetPresence: vi.fn(async () => ({ kind: 'owned' as const })),
  workerPaneBelongsToOwnedProviderTarget: vi.fn(async () => true),
  killOwnedWorkerPane: vi.fn(async () => {
    paneState.events.push('kill-pane');
    paneState.killed = true;
  }),
  capturePaneProcessTree: vi.fn<(identity: unknown, paneId: string) => Promise<unknown>>(async () => null),
  terminatePaneProcessTree: vi.fn<(tree: unknown) => Promise<void>>(async () => undefined),
  killTeamSession: vi.fn(async () => true),
}));

const TEAM_INSTANCE_ID = '55555555-5555-4555-8555-555555555555';
const FIXTURE_TREE = { panePid: 4_000_000, pids: [4_000_001], startIdentities: new Map([[4_000_001, 'start-4000001']]) };

vi.mock('../../cli/tmux-utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
  return {
    ...actual,
    tmuxExecAsync: tmuxUtilsMocks.tmuxExecAsync,
    tmuxCmdAsync: tmuxUtilsMocks.tmuxCmdAsync,
  };
});

vi.mock('../tmux-session.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../tmux-session.js')>();
  return {
    ...actual,
    observeTmuxServerIdentity: tmuxSessionMocks.observeTmuxServerIdentity,
    getOwnedWorkerLiveness: tmuxSessionMocks.getOwnedWorkerLiveness,
    observeTeamSessionTargetPresence: tmuxSessionMocks.observeTeamSessionTargetPresence,
    workerPaneBelongsToOwnedProviderTarget: tmuxSessionMocks.workerPaneBelongsToOwnedProviderTarget,
    killOwnedWorkerPane: tmuxSessionMocks.killOwnedWorkerPane,
    capturePaneProcessTree: tmuxSessionMocks.capturePaneProcessTree,
    terminatePaneProcessTree: tmuxSessionMocks.terminatePaneProcessTree,
    killTeamSession: tmuxSessionMocks.killTeamSession,
  };
});

async function writeJson(cwd: string, relativePath: string, value: unknown): Promise<void> {
  const fullPath = isAbsolute(relativePath) ? relativePath : join(cwd, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(value, null, 2), 'utf-8');
}

/** The identity of this very process: the adoption of a pane proves the "server" against the process table. */
function ownProcessTmuxIdentity() {
  return {
    socket_path: '/tmp/omc-shutdown-pane-tree-test.sock',
    server_pid: process.pid,
    process_started_at: currentStrictProcessStartIdentity(process.pid) ?? 'unavailable',
  };
}

describe.skipIf(currentStrictProcessStartIdentity(process.pid) === null)('shutdownTeamV2 worker pane process tree', () => {
  let cwd = '';
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalStateDir = process.env.OMC_STATE_DIR;
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-pane-tree-'));
    process.env.HOME = cwd;
    process.env.USERPROFILE = cwd;
    delete process.env.OMC_STATE_DIR;
    paneState.killed = false;
    paneState.events.length = 0;
    tmuxUtilsMocks.tmuxExecAsync.mockReset();
    tmuxUtilsMocks.tmuxCmdAsync.mockReset();
    for (const mock of Object.values(tmuxSessionMocks)) mock.mockClear();
    tmuxSessionMocks.getOwnedWorkerLiveness.mockImplementation(async () => (paneState.killed ? 'dead' : 'alive'));
    tmuxSessionMocks.capturePaneProcessTree.mockImplementation(async () => {
      paneState.events.push('capture');
      return FIXTURE_TREE;
    });
    tmuxSessionMocks.terminatePaneProcessTree.mockImplementation(async () => {
      paneState.events.push('terminate');
    });

    // The pane membership proof lists the panes of the team window; the identity probe answers with this process.
    tmuxUtilsMocks.tmuxExecAsync.mockImplementation(async (args: string[]) => ({
      stdout: args.includes('list-panes') ? '%1\n%2\n%3\n' : '',
      stderr: '',
    }));
    tmuxUtilsMocks.tmuxCmdAsync.mockImplementation(async (args: string[]) => ({
      stdout: args.includes('#{pid}') ? `${process.pid}\n` : '',
      stderr: '',
    }));
  });

  afterEach(async () => {
    delete process.env.OMC_TEAM_KILL_PANE_TREE;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalStateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = originalStateDir;
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
      cwd = '';
    }
  });

  const reserve = (teamName: string): Promise<unknown> => reserveTeamInstance({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });

  async function writeTeam(teamName: string, launchAttemptId: string): Promise<string> {
    const teamRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);
    await writeJson(cwd, `${teamRoot}/config.json`, {
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%2',
        worker_cli: 'claude', launch_attempt_id: launchAttemptId,
        launch_descriptor: { schema_version: 1, provider: 'claude', model: null, binary: process.execPath, args: [] },
      }],
      created_at: new Date().toISOString(),
      tmux_session: 'leader-session:0',
      tmux_server_identity: ownProcessTmuxIdentity(),
      tmux_window_owned: false,
      next_task_id: 1,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });
    return teamRoot;
  }

  function prepare(teamName: string): Promise<WorkerLaunchAttempt> {
    return prepareWorkerLaunchAttempt({
      cwd, teamName, workerName: 'worker-1', paneId: '%2', instanceId: TEAM_INSTANCE_ID,
      provider: 'claude', runtimeCliPath: resolveRuntimeCliPath(), context: { kind: 'initial' },
    });
  }

  it('a dead pane (no ownership) reads no tree and signals nothing', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    tmuxSessionMocks.getOwnedWorkerLiveness.mockImplementation(async () => 'dead');
    await reserve('pane-tree-dead-team');
    await writeTeam('pane-tree-dead-team', '66666666-6666-4666-8666-666666666666');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2('pane-tree-dead-team', cwd, { timeoutMs: 0 })).resolves.toMatchObject({
      outcome: 'preserved',
    });

    expect(tmuxSessionMocks.getOwnedWorkerLiveness).toHaveBeenCalled();
    expect(tmuxSessionMocks.capturePaneProcessTree).not.toHaveBeenCalled();
    expect(tmuxSessionMocks.terminatePaneProcessTree).not.toHaveBeenCalled();
    expect(tmuxSessionMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
  });

  it('without a launch record the tree may be read but is never signalled, and the team is preserved', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    // An attempt id with no expected-launch record: loadWorkerLaunchAttempt finds nothing, the fence cannot be taken.
    await reserve('pane-tree-no-record-team');
    await writeTeam('pane-tree-no-record-team', '66666666-6666-4666-8666-666666666666');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2('pane-tree-no-record-team', cwd, { timeoutMs: 0 })).resolves.toMatchObject({
      outcome: 'preserved',
      reason: 'provider_cleanup_unverified',
    });

    expect(tmuxSessionMocks.terminatePaneProcessTree).not.toHaveBeenCalled();
    expect(tmuxSessionMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
  });

  it('a launch attempt that was never accepted does not release the signals, and the team is preserved', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    await reserve('pane-tree-unaccepted-team');
    const attempt = await prepare('pane-tree-unaccepted-team');
    await writeTeam('pane-tree-unaccepted-team', attempt.attempt_id);

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2('pane-tree-unaccepted-team', cwd, { timeoutMs: 0 })).resolves.toMatchObject({
      outcome: 'preserved',
      reason: 'provider_cleanup_unverified',
    });

    expect(tmuxSessionMocks.terminatePaneProcessTree).not.toHaveBeenCalled();
    expect(tmuxSessionMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
  });

  it('reads the tree while the provider runs and signals it after the provider is terminated, before the pane is killed', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    const teamName = 'pane-tree-accepted-team';
    let attempt: WorkerLaunchAttempt | undefined;
    let bootstrap: Promise<unknown> | undefined;
    let providerPid = 0;
    let providerGroup: number | undefined;
    await reserve(teamName);
    try {
      attempt = await prepare(teamName);
      bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
        attempt, [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd,
      ));
      await expect(awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 2_000, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
      await expect(awaitWorkerLaunchProviderStarted(attempt, { timeoutMs: 10_000, pollIntervalMs: 5 })).resolves.toBe(true);
      const started = JSON.parse(await readFile(attempt.startedPath, 'utf-8')) as { pid: number; process_group_id?: number };
      providerPid = started.pid;
      providerGroup = started.process_group_id;
      // Publication precedes the bootstrap's final handoff checks: wait for its fence before shutting the team down.
      await expect(withWorkerLaunchAttemptFence(attempt, async () => isProcessAlive(providerPid))).resolves.toEqual({ ok: true, value: true });
      await writeTeam(teamName, attempt.attempt_id);

      let providerAliveAtCapture: boolean | undefined;
      let providerAliveAtTerminate: boolean | undefined;
      tmuxSessionMocks.capturePaneProcessTree.mockImplementation(async () => {
        paneState.events.push('capture');
        providerAliveAtCapture = isProcessAlive(providerPid);
        return FIXTURE_TREE;
      });
      tmuxSessionMocks.terminatePaneProcessTree.mockImplementation(async () => {
        paneState.events.push('terminate');
        providerAliveAtTerminate = isProcessAlive(providerPid);
      });

      const { shutdownTeamV2 } = await import('../runtime-v2.js');
      await shutdownTeamV2(teamName, cwd, { timeoutMs: 0, force: true });
      await bootstrap;

      expect(paneState.events).toEqual(['capture', 'terminate', 'kill-pane']);
      expect(tmuxSessionMocks.capturePaneProcessTree).toHaveBeenCalledTimes(1);
      expect(tmuxSessionMocks.capturePaneProcessTree).toHaveBeenCalledWith(ownProcessTmuxIdentity(), '%2');
      expect(tmuxSessionMocks.terminatePaneProcessTree).toHaveBeenCalledTimes(1);
      expect(tmuxSessionMocks.terminatePaneProcessTree).toHaveBeenCalledWith(FIXTURE_TREE);
      // The order that matters: the tree is read while the provider is alive and signalled once it is gone.
      expect(providerAliveAtCapture).toBe(true);
      expect(providerAliveAtTerminate).toBe(false);
    } finally {
      if (attempt) await terminateWorkerLaunchProvider(attempt, 2_000).catch(() => false);
      if (bootstrap) await bootstrap.catch(() => undefined);
      if (providerPid > 0) {
        await vi.waitFor(() => {
          expect(isProcessAlive(providerPid)).toBe(false);
          if (providerGroup !== undefined) {
            expect(() => process.kill(-providerGroup!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
          }
        }, { timeout: 2_000, interval: 20 });
      }
    }
  }, 60_000);
});
