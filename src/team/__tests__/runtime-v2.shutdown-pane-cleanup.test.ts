import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isProcessAlive } from '../../platform/process-utils.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { resolveRuntimeCliPath } from '../runtime-owner-client.js';
import { reserveTeamInstance } from '../team-instance.js';
import { awaitWorkerLaunchAcknowledgement, awaitWorkerLaunchProviderStarted, buildWorkerLaunchBootstrapSpec,
  prepareWorkerLaunchAttempt, runWorkerLaunchBootstrap, terminateWorkerLaunchProvider, withWorkerLaunchAttemptFence, type WorkerLaunchAttempt } from '../worker-launch-ack.js';

const tmuxUtilsMocks = vi.hoisted(() => ({
  tmuxExecAsync: vi.fn(),
  tmuxCmdAsync: vi.fn(),
}));
const tmuxSessionMocks = vi.hoisted(() => ({
  observeTmuxServerIdentity: vi.fn(async () => 'matching' as const),
  getOwnedWorkerLiveness: vi.fn(async () => 'dead' as const),
  observeTeamSessionTargetPresence: vi.fn(async () => ({ kind: 'owned' as const })),
  workerPaneBelongsToOwnedProviderTarget: vi.fn(async () => true),
  killOwnedWorkerPane: vi.fn(async () => undefined),
  killTeamSession: vi.fn(async () => true),
}));
const tmuxCalls = vi.hoisted(() => [] as string[][]);
type StartedRecord = { pid: number; process_start_identity: string; process_group_id?: number };
const TEAM_INSTANCE_ID = '44444444-4444-4444-8444-444444444444';
const FIXTURE_TMUX_SERVER_IDENTITY = {
  socket_path: '/tmp/omc-test-tmux.sock',
  server_pid: 4242,
  process_started_at: process.platform === 'darwin'
    ? 'darwin:1700000000:123456'
    : 'linux:01234567-89ab-cdef-0123-456789abcdef:424242',
};

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
    killTeamSession: tmuxSessionMocks.killTeamSession,
  };
});

async function writeJson(cwd: string, relativePath: string, value: unknown): Promise<void> {
  const fullPath = isAbsolute(relativePath) ? relativePath : join(cwd, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(value, null, 2), 'utf-8');
}

describe('shutdownTeamV2 split-pane pane cleanup', () => {
  let cwd = '';
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalStateDir = process.env.OMC_STATE_DIR;
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-pane-cleanup-'));
    process.env.HOME = cwd;
    process.env.USERPROFILE = cwd;
    delete process.env.OMC_STATE_DIR;
    tmuxCalls.length = 0;
    tmuxUtilsMocks.tmuxExecAsync.mockReset();
    tmuxUtilsMocks.tmuxCmdAsync.mockReset();
    tmuxSessionMocks.observeTmuxServerIdentity.mockReset();
    tmuxSessionMocks.observeTmuxServerIdentity.mockResolvedValue('matching');
    tmuxSessionMocks.getOwnedWorkerLiveness.mockReset();
    tmuxSessionMocks.getOwnedWorkerLiveness.mockResolvedValue('dead');
    tmuxSessionMocks.observeTeamSessionTargetPresence.mockReset();
    tmuxSessionMocks.observeTeamSessionTargetPresence.mockResolvedValue({ kind: 'owned' });
    tmuxSessionMocks.workerPaneBelongsToOwnedProviderTarget.mockReset();
    tmuxSessionMocks.workerPaneBelongsToOwnedProviderTarget.mockResolvedValue(true);
    tmuxSessionMocks.killOwnedWorkerPane.mockReset();
    tmuxSessionMocks.killOwnedWorkerPane.mockImplementation(async () => undefined);
    tmuxSessionMocks.killTeamSession.mockReset();
    tmuxSessionMocks.killTeamSession.mockResolvedValue(true);

    const run = (args: string[]) => {
      tmuxCalls.push(args);
      let stdout = '';
      if (args[0] === 'list-panes') {
        stdout = '%1\n%2\n%3\n';
      } else if (args[0] === 'display-message' && args.includes('#{pane_dead}')) {
        stdout = '1\n';
      }
      return { stdout, stderr: '' };
    };

    tmuxUtilsMocks.tmuxExecAsync.mockImplementation(async (args: string[]) => run(args));
    tmuxUtilsMocks.tmuxCmdAsync.mockImplementation(async (args: string[]) => run(args));
  });

  afterEach(async () => {
    tmuxCalls.length = 0;
    tmuxUtilsMocks.tmuxExecAsync.mockReset();
    tmuxUtilsMocks.tmuxCmdAsync.mockReset();
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

  it('preserves the owned pane and state when provider launch identity is missing', async () => {
    const teamName = 'pane-cleanup-team';
    await reserveTeamInstance({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });
    const teamRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);

    await writeJson(cwd, `${teamRoot}/config.json`, {
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 2,
      max_workers: 20,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%2' },
        { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [] },
      ],
      created_at: new Date().toISOString(),
      tmux_session: 'leader-session:0',
      tmux_server_identity: FIXTURE_TMUX_SERVER_IDENTITY,
      tmux_window_owned: false,
      next_task_id: 1,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, cwd, { timeoutMs: 0 })).resolves.toMatchObject({
      outcome: 'preserved',
    });

    const killPaneTargets = tmuxCalls
      .filter((args) => args[0] === 'kill-pane')
      .map((args) => args[2]);

    expect(killPaneTargets).toEqual([]);
    expect(tmuxCalls.some(args => args[0] === 'kill-window' || args[0] === 'kill-session')).toBe(false);
    await expect(readFile(join(teamRoot, 'config.json'), 'utf-8')).resolves.toContain('pane-cleanup-team');
  });
  it('retires and terminates the exact provider while accepting a proven-dead pane', async () => {
    const teamName = 'provider-cleanup-team';
    await reserveTeamInstance({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });
    const teamRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);
    let attempt: WorkerLaunchAttempt | undefined;
    let bootstrap: Promise<unknown> | undefined;
    let startedRecord: StartedRecord | undefined;
    try {
      attempt = await prepareWorkerLaunchAttempt({ cwd, teamName, workerName: 'worker-1', paneId: '%2',
        instanceId: TEAM_INSTANCE_ID, provider: 'claude', runtimeCliPath: resolveRuntimeCliPath(), context: { kind: 'initial' } });
      bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
        attempt, [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd,
      ));
      await expect(awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
        .resolves.toEqual({ ok: true });
      await expect(awaitWorkerLaunchProviderStarted(attempt, { timeoutMs: 10_000, pollIntervalMs: 5 }))
        .resolves.toBe(true);
      startedRecord = JSON.parse(await readFile(attempt.startedPath, 'utf-8')) as StartedRecord;
      const providerPid = startedRecord.pid;
      // Publication precedes the bootstrap's final handoff checks. Wait for
      // its fence to be released before testing shutdown of a running launch.
      await expect(withWorkerLaunchAttemptFence(attempt, async () => isProcessAlive(providerPid)))
        .resolves.toEqual({ ok: true, value: true });
      await writeJson(cwd, `${teamRoot}/config.json`, {
        name: teamName, instance_id: TEAM_INSTANCE_ID, task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive', worker_count: 1, max_workers: 20,
        workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%2',
          worker_cli: 'claude', launch_attempt_id: attempt.attempt_id,
          launch_descriptor: { schema_version: 1, provider: 'claude', model: null, binary: process.execPath, args: [] } }],
        created_at: new Date().toISOString(), tmux_session: 'leader-session:0',
        tmux_server_identity: FIXTURE_TMUX_SERVER_IDENTITY, tmux_window_owned: false,
        next_task_id: 1, leader_pane_id: '%1', hud_pane_id: null, resize_hook_name: null, resize_hook_target: null,
      });

      const { shutdownTeamV2 } = await import('../runtime-v2.js');
      await shutdownTeamV2(teamName, cwd, { timeoutMs: 0, force: true });
      const bootstrapResult = await bootstrap;
      expect(bootstrapResult, JSON.stringify(bootstrapResult)).toMatchObject({ outcome: 'ran' });
      expect(isProcessAlive(providerPid)).toBe(false);
      expect(tmuxCalls.some(args => args[0] === 'kill-pane' && args[2] === '%2')).toBe(false);
      await expect(readFile(join(teamRoot, 'config.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (attempt && !startedRecord) {
        const started = await awaitWorkerLaunchProviderStarted(attempt, { timeoutMs: 2_000, pollIntervalMs: 5 })
          .then(async present => present ? JSON.parse(await readFile(attempt!.startedPath, 'utf8')) as StartedRecord : undefined)
          .catch(() => undefined);
        if (started) startedRecord = started;
      }
      if (attempt) await terminateWorkerLaunchProvider(attempt, 2_000).catch(() => false);
      if (bootstrap) await bootstrap.catch(() => undefined);
      if (startedRecord) {
        await vi.waitFor(() => {
          expect(isProcessAlive(startedRecord!.pid)).toBe(false);
          if (startedRecord!.process_group_id !== undefined) {
            expect(() => process.kill(-startedRecord!.process_group_id!, 0))
              .toThrow(expect.objectContaining({ code: 'ESRCH' }));
          }
        }, { timeout: 2_000, interval: 20 });
      }
    }
  });

});
