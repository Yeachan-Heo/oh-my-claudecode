import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

// The team shutdown loop reads the process tree of each worker pane before the first request to exit goes out (a worker that
// follows the request exits during the wait, and its pane's root with it), reads it once more before the launch fence is taken, a
// third time at the fence itself (the attempt is current and accepted and its retirement is recorded) right before the provider of
// the worker is terminated, and signals only after the fence is held and the provider is gone (opt-in
// through OMC_TEAM_KILL_PANE_TREE, checked inside the two tree functions, which are mocks here, and before the first and the third read). The
// launch records are real: the cases cover the call sites and their order around the requests and the fence, not the tree walk
// (see tmux-session.kill-pane-tree.test.ts).

const tmuxUtilsMocks = vi.hoisted(() => ({
  tmuxExecAsync: vi.fn(),
  tmuxCmdAsync: vi.fn(),
}));
const paneState = vi.hoisted(() => ({ killed: false, rootGone: false, events: [] as string[] }));
const tmuxSessionMocks = vi.hoisted(() => ({
  observeTmuxServerIdentity: vi.fn(async () => 'matching' as const),
  // The pane counts as alive until the shutdown loop kills it (or its root exits: rootGone).
  getOwnedWorkerLiveness: vi.fn(async (): Promise<'alive' | 'dead' | 'unknown'> => (paneState.killed || paneState.rootGone ? 'dead' : 'alive')),
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
    paneState.rootGone = false;
    paneState.events.length = 0;
    tmuxUtilsMocks.tmuxExecAsync.mockReset();
    tmuxUtilsMocks.tmuxCmdAsync.mockReset();
    for (const mock of Object.values(tmuxSessionMocks)) mock.mockClear();
    // mockClear leaves the queue of mockImplementationOnce and mockRejectedValueOnce: an answer a test did not use must not reach the next one
    tmuxSessionMocks.capturePaneProcessTree.mockReset();
    tmuxSessionMocks.terminatePaneProcessTree.mockReset();
    tmuxSessionMocks.getOwnedWorkerLiveness.mockImplementation(async () => (paneState.killed || paneState.rootGone ? 'dead' : 'alive'));
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

  /**
   * Runs `body` with a real provider whose launch attempt is accepted, so the shutdown loop reaches the cleanup callback and its fence;
   * the provider is stopped and reaped afterwards. `body` gets the team root and the pid and process group of the provider.
   */
  async function withAcceptedProvider(
    teamName: string,
    body: (teamRoot: string, provider: { pid: number }, attempt: WorkerLaunchAttempt) => Promise<void>,
  ): Promise<void> {
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
      const teamRoot = await writeTeam(teamName, attempt.attempt_id);
      await body(teamRoot, { pid: providerPid }, attempt);
      await bootstrap;
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
  }

  const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

  it('reads the tree before the request to exit and again twice while the provider runs, and signals after the provider is terminated, before the pane is killed', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    const teamName = 'pane-tree-accepted-team';
    await withAcceptedProvider(teamName, async (teamRoot, provider) => {
      const requestFile = join(teamRoot, 'workers', 'worker-1', 'shutdown-request.json');
      const requestWrittenAtCapture: boolean[] = [];
      let providerAliveAtCapture: boolean | undefined;
      let providerAliveAtTerminate: boolean | undefined;
      tmuxSessionMocks.capturePaneProcessTree.mockImplementation(async () => {
        paneState.events.push('capture');
        requestWrittenAtCapture.push(await exists(requestFile));
        providerAliveAtCapture = isProcessAlive(provider.pid);
        return FIXTURE_TREE;
      });
      tmuxSessionMocks.terminatePaneProcessTree.mockImplementation(async () => {
        paneState.events.push('terminate');
        providerAliveAtTerminate = isProcessAlive(provider.pid);
      });

      const { shutdownTeamV2 } = await import('../runtime-v2.js');
      await shutdownTeamV2(teamName, cwd, { timeoutMs: 0, force: true });

      expect(paneState.events).toEqual(['capture', 'capture', 'capture', 'terminate', 'terminate', 'terminate', 'kill-pane']);
      expect(tmuxSessionMocks.capturePaneProcessTree).toHaveBeenCalledTimes(3);
      for (const nth of [1, 2, 3]) expect(tmuxSessionMocks.capturePaneProcessTree).toHaveBeenNthCalledWith(nth, ownProcessTmuxIdentity(), '%2');
      // the first read comes before the request to exit, the second and the third after it; all while the provider runs
      expect(requestWrittenAtCapture).toEqual([false, true, true]);
      expect(providerAliveAtCapture).toBe(true);
      expect(tmuxSessionMocks.terminatePaneProcessTree).toHaveBeenCalledTimes(3);
      for (const nth of [1, 2, 3]) expect(tmuxSessionMocks.terminatePaneProcessTree).toHaveBeenNthCalledWith(nth, FIXTURE_TREE);
      // The order that matters: the trees are read while the provider is alive and signalled once it is gone.
      expect(providerAliveAtTerminate).toBe(false);
    });
  }, 60_000);

  it('a failure of the read before the requests does not hold up the shutdown: the read before the launch fence still signals', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    await withAcceptedProvider('pane-tree-early-failure-team', async () => {
      tmuxSessionMocks.capturePaneProcessTree
        .mockRejectedValueOnce(new Error('tmux went away'))
        .mockImplementation(async () => FIXTURE_TREE);
      const { shutdownTeamV2 } = await import('../runtime-v2.js');
      await shutdownTeamV2('pane-tree-early-failure-team', cwd, { timeoutMs: 0, force: true });
      expect(tmuxSessionMocks.capturePaneProcessTree).toHaveBeenCalledTimes(3);
      expect(tmuxSessionMocks.terminatePaneProcessTree.mock.calls.map((call) => call[0])).toEqual([null, FIXTURE_TREE, FIXTURE_TREE]);
    });
  }, 60_000);

  // A descendant the worker starts after the read before the launch fence (the reads were taken, then the shutdown waited for the lock of
  // the launch attempt, say) is in neither of them, and is reparented once the provider is terminated, so a read taken after that does
  // not find it either: the read at the fence, with the provider still alive, is the one that names it.
  it('signals a descendant started after the read before the fence: it is read at the fence, before the provider is terminated', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    const startedLater = { panePid: 4_000_000, pids: [4_000_001, 4_000_002], startIdentities: new Map([[4_000_001, 'start-4000001'], [4_000_002, 'start-4000002']]) };
    await withAcceptedProvider('pane-tree-fence-team', async (_teamRoot, provider, attempt) => {
      const retiredAtCapture: boolean[] = [];
      const providerAliveAtCapture: boolean[] = [];
      let providerAliveAtTerminate: boolean | undefined;
      tmuxSessionMocks.capturePaneProcessTree.mockImplementation(async () => {
        paneState.events.push('capture');
        // the retirement is recorded under the fence, right before the provider is terminated
        const retired = await exists(`${attempt.decisionPath}.retired`);
        retiredAtCapture.push(retired);
        providerAliveAtCapture.push(isProcessAlive(provider.pid));
        return retired ? startedLater : FIXTURE_TREE;
      });
      tmuxSessionMocks.terminatePaneProcessTree.mockImplementation(async () => {
        paneState.events.push('terminate');
        providerAliveAtTerminate = isProcessAlive(provider.pid);
      });
      const { shutdownTeamV2 } = await import('../runtime-v2.js');
      await shutdownTeamV2('pane-tree-fence-team', cwd, { timeoutMs: 0, force: true });

      expect(retiredAtCapture).toEqual([false, false, true]);
      expect(providerAliveAtCapture).toEqual([true, true, true]);
      expect(tmuxSessionMocks.terminatePaneProcessTree.mock.calls.map((call) => call[0])).toEqual([FIXTURE_TREE, FIXTURE_TREE, startedLater]);
      expect(providerAliveAtTerminate).toBe(false);
      expect(paneState.events).toEqual(['capture', 'capture', 'capture', 'terminate', 'terminate', 'terminate', 'kill-pane']);
    });
  }, 60_000);

  it('a failed read at the fence does not hold up the shutdown: the earlier trees are signalled and the pane is killed', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    await withAcceptedProvider('pane-tree-fence-failure-team', async () => {
      tmuxSessionMocks.capturePaneProcessTree
        .mockImplementationOnce(async () => FIXTURE_TREE)
        .mockImplementationOnce(async () => FIXTURE_TREE)
        .mockRejectedValueOnce(new Error('tmux went away'));
      const { shutdownTeamV2 } = await import('../runtime-v2.js');
      await expect(shutdownTeamV2('pane-tree-fence-failure-team', cwd, { timeoutMs: 0, force: true })).resolves.toMatchObject({ outcome: 'cleaned' });
      expect(tmuxSessionMocks.capturePaneProcessTree).toHaveBeenCalledTimes(3);
      expect(tmuxSessionMocks.terminatePaneProcessTree.mock.calls.map((call) => call[0])).toEqual([FIXTURE_TREE, FIXTURE_TREE]);
      expect(tmuxSessionMocks.killOwnedWorkerPane).toHaveBeenCalledTimes(1);
    });
  }, 60_000);

  it('without OMC_TEAM_KILL_PANE_TREE nothing is read before the requests: the one read is the one before the fence', async () => {
    await withAcceptedProvider('pane-tree-off-team', async (teamRoot) => {
      const requestFile = join(teamRoot, 'workers', 'worker-1', 'shutdown-request.json');
      const requestWrittenAtCapture: boolean[] = [];
      tmuxSessionMocks.capturePaneProcessTree.mockImplementation(async () => {
        requestWrittenAtCapture.push(await exists(requestFile));
        return FIXTURE_TREE;
      });
      const { shutdownTeamV2 } = await import('../runtime-v2.js');
      await shutdownTeamV2('pane-tree-off-team', cwd, { timeoutMs: 0, force: true });
      expect(requestWrittenAtCapture).toEqual([true]);
      expect(tmuxSessionMocks.terminatePaneProcessTree.mock.calls.map((call) => call[0])).toEqual([null, FIXTURE_TREE]);
    });
  }, 60_000);

  // The pane's root exits while the leader waits: its worker followed the request to exit (or the wait ends by its deadline and the
  // root is gone anyway). A read taken after the wait finds a dead pane and no tree, but the read before the requests has it.
  it.each<[string, { timeoutMs: number; force?: boolean }, boolean]>([
    ['ordinary shutdown, the worker acknowledges and exits', { timeoutMs: 8_000 }, true],
    ['forced shutdown, the worker exits and never acknowledges (the wait ends at its deadline)', { timeoutMs: 100, force: true }, false],
    ['ordinary shutdown, the worker exits and the acknowledgement never comes (the wait ends at its deadline)', { timeoutMs: 100 }, false],
  ])('signals the tree read before the requests when the pane root exits during the wait: %s', async (_what, options, acknowledges) => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    const teamName = `pane-tree-exit-${acknowledges ? 'ack' : options.force ? 'force' : 'deadline'}`;
    await withAcceptedProvider(teamName, async (teamRoot) => {
      const workerDir = join(teamRoot, 'workers', 'worker-1');
      // the first read sees the live pane; once the root has exited the pane is dead and a later read returns no tree
      tmuxSessionMocks.capturePaneProcessTree.mockImplementation(async () => {
        paneState.events.push('capture');
        return paneState.rootGone ? null : FIXTURE_TREE;
      });
      const { shutdownTeamV2 } = await import('../runtime-v2.js');
      const shutdown = shutdownTeamV2(teamName, cwd, options);
      await vi.waitFor(async () => expect(await exists(join(workerDir, 'shutdown-request.json'))).toBe(true), { timeout: 10_000, interval: 10 });
      paneState.rootGone = true;
      if (acknowledges) {
        await writeJson(cwd, join(workerDir, 'shutdown-ack.json'), { status: 'accept', reason: 'ok', updated_at: new Date().toISOString() });
      }
      await shutdown;

      expect(paneState.events).toEqual(['capture', 'terminate', 'terminate']);
      expect(tmuxSessionMocks.terminatePaneProcessTree.mock.calls.map((call) => call[0])).toEqual([FIXTURE_TREE, null]);
      expect(tmuxSessionMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
    });
  }, 60_000);
});
