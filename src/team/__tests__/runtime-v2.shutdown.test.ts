import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWorkerWorktree } from '../git-worktree.js';
import {
  awaitWorkerLaunchAcknowledgement,
  awaitWorkerLaunchProviderStarted,
  buildWorkerLaunchBootstrapSpec,
  prepareWorkerLaunchAttempt,
  runWorkerLaunchBootstrap,
  terminateWorkerLaunchProvider,
  type WorkerLaunchAttempt,
} from '../worker-launch-ack.js';
import { currentProcessStartIdentity } from '../team-owner-epoch.js';
import { createTeamInstanceBinding, reserveTeamInstance } from '../team-instance.js';
import * as teamInstanceModule from '../team-instance.js';
import { resolveRuntimeCliPath } from '../runtime-owner-client.js';
import { absPath, TeamPaths, teamStateRoot } from '../state-paths.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';

const TEAM_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const REPLACEMENT_INSTANCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type WorkerLivenessInput = Parameters<typeof import('../tmux-session.js').getWorkerLiveness>[0];
type WorkerLiveness = Awaited<ReturnType<typeof import('../tmux-session.js').getWorkerLiveness>>;
type OwnedWorkerLivenessInput = Parameters<typeof import('../tmux-session.js').getOwnedWorkerLiveness>[0];

async function reserveFixtureInstance(teamName: string, cwd: string, instanceId = TEAM_INSTANCE_ID): Promise<void> {
  await reserveTeamInstance({ teamName, cwd, instanceId });
}

function fixtureTeamRoot(cwd: string, teamName: string): string {
  return teamStateRoot(cwd, teamName);
}

const tmuxMocks = vi.hoisted(() => {
  const tmuxServerIdentity = {
    socket_path: '/tmp/omc-test-tmux.sock',
    server_pid: 4242,
    process_started_at: process.platform === 'darwin'
      ? 'darwin:1700000000:123456'
      : 'linux:01234567-89ab-cdef-0123-456789abcdef:424242',
  };
  const getWorkerLiveness = vi.fn(async (_paneId: WorkerLivenessInput): Promise<WorkerLiveness> => 'dead');
  return {
    tmuxServerIdentity,
    killWorkerPanes: vi.fn(async () => undefined),
    killTeamSession: vi.fn(async () => true),
    resolveSplitPaneWorkerPaneIds: vi.fn(async (_session: string | undefined, paneIds: string[]) => paneIds),
    isWorkerAlive: vi.fn(async () => false),
    getWorkerLiveness,
    getOwnedWorkerLiveness: vi.fn(async (ownership: OwnedWorkerLivenessInput): Promise<WorkerLiveness> => {
      if (ownership.provider === 'tmux' && !ownership.tmuxServerIdentity) return 'unknown';
      return getWorkerLiveness(ownership.paneId);
    }),
    observeTmuxServerIdentity: vi.fn(async () => 'matching' as const),
    adoptWorkerPaneOwnership: vi.fn(async (input: {
      provider: string;
      providerTarget: string;
      paneId: string;
      tmuxServerIdentity?: typeof tmuxServerIdentity;
    }) => ({
      ok: true as const,
      ownership: {
        provider: input.provider,
        providerTarget: input.providerTarget,
        paneId: input.paneId,
        splitTarget: '',
        leaderPaneId: '',
        reservedPaneIds: [],
        source: 'adopted' as const,
        ...(input.provider === 'tmux' ? { tmuxServerIdentity: input.tmuxServerIdentity ?? tmuxServerIdentity } : {}),
      },
    })),
    killOwnedWorkerPane: vi.fn(async () => undefined),
    verifyTeamTargetOwnership: vi.fn(async (): Promise<{ kind: 'owned' | 'unavailable' | 'foreign' | 'provider_mismatch' }> => ({ kind: 'owned' })),
    observeTeamSessionTargetPresence: vi.fn(async (): Promise<{ kind: 'owned' | 'absent' | 'present_unowned' | 'unknown' }> => ({ kind: 'owned' })),
  };
});

vi.mock('../tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tmux-session.js')>();
  return {
    ...actual,
    killWorkerPanes: tmuxMocks.killWorkerPanes,
    killTeamSession: tmuxMocks.killTeamSession,
    resolveSplitPaneWorkerPaneIds: tmuxMocks.resolveSplitPaneWorkerPaneIds,
    isWorkerAlive: tmuxMocks.isWorkerAlive,
    getWorkerLiveness: tmuxMocks.getWorkerLiveness,
    getOwnedWorkerLiveness: tmuxMocks.getOwnedWorkerLiveness,
    observeTmuxServerIdentity: tmuxMocks.observeTmuxServerIdentity,
    adoptWorkerPaneOwnership: tmuxMocks.adoptWorkerPaneOwnership,
    killOwnedWorkerPane: tmuxMocks.killOwnedWorkerPane,
    verifyTeamTargetOwnership: tmuxMocks.verifyTeamTargetOwnership,
    observeTeamSessionTargetPresence: tmuxMocks.observeTeamSessionTargetPresence,
  };




});

const activeLaunches: Array<{ attempt: WorkerLaunchAttempt; bootstrap: Promise<unknown> }> = [];

async function prepareAcceptedLaunch(cwd: string, teamName: string, workerName: string, paneId: string): Promise<WorkerLaunchAttempt> {
  const attempt = await prepareWorkerLaunchAttempt({
    cwd,
    teamName,
    workerName,
    paneId,
    instanceId: TEAM_INSTANCE_ID,
    provider: 'claude',
    runtimeCliPath: resolveRuntimeCliPath(),
    context: { kind: 'initial' },
  });
  const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
    attempt,
    [process.execPath, '-e', 'setInterval(()=>{},1000)'],
    cwd,
  ));
  activeLaunches.push({ attempt, bootstrap });
  const acknowledgement = await awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 2_000, pollIntervalMs: 5 });
  if (!acknowledgement.ok) {
    throw new Error(`fixture_launch_ack_failed:${workerName}`);
  }
  if (!(await awaitWorkerLaunchProviderStarted(attempt, { timeoutMs: 10_000, pollIntervalMs: 5 }))) {
    throw new Error(`fixture_provider_start_failed:${workerName}`);
  }
  return attempt;
}

describe('shutdownTeamV2 detached worktree cleanup', () => {
  let repoDir: string;
  let previousOmcStateDir: string | undefined;

  beforeEach(() => {
    previousOmcStateDir = process.env.OMC_STATE_DIR;
    tmuxMocks.killWorkerPanes.mockClear();
    tmuxMocks.killTeamSession.mockClear();
    tmuxMocks.resolveSplitPaneWorkerPaneIds.mockClear();
    tmuxMocks.resolveSplitPaneWorkerPaneIds.mockImplementation(async (_session: string | undefined, paneIds: string[]) => paneIds);
    tmuxMocks.isWorkerAlive.mockReset();
    tmuxMocks.isWorkerAlive.mockResolvedValue(false);
    tmuxMocks.getWorkerLiveness.mockReset();
    tmuxMocks.getWorkerLiveness.mockResolvedValue('dead');
    tmuxMocks.getOwnedWorkerLiveness.mockClear();
    tmuxMocks.getOwnedWorkerLiveness.mockImplementation(async (ownership: OwnedWorkerLivenessInput): Promise<WorkerLiveness> => {
      if (ownership.provider === 'tmux' && !ownership.tmuxServerIdentity) return 'unknown';
      return tmuxMocks.getWorkerLiveness(ownership.paneId);
    });
    tmuxMocks.observeTmuxServerIdentity.mockReset();
    tmuxMocks.observeTmuxServerIdentity.mockResolvedValue('matching');
    tmuxMocks.adoptWorkerPaneOwnership.mockImplementation(async (input: {
      provider: string;
      providerTarget: string;
      paneId: string;
      tmuxServerIdentity?: typeof tmuxMocks.tmuxServerIdentity;
    }) => ({
      ok: true as const,
      ownership: {
        provider: input.provider,
        providerTarget: input.providerTarget,
        paneId: input.paneId,
        splitTarget: '',
        leaderPaneId: '',
        reservedPaneIds: [],
        source: 'adopted' as const,
        ...(input.provider === 'tmux'
          ? { tmuxServerIdentity: input.tmuxServerIdentity ?? tmuxMocks.tmuxServerIdentity }
          : {}),
      },
    }));
    tmuxMocks.killOwnedWorkerPane.mockResolvedValue(undefined);
    tmuxMocks.verifyTeamTargetOwnership.mockResolvedValue({ kind: 'owned' });
    tmuxMocks.observeTeamSessionTargetPresence.mockReset();
    tmuxMocks.observeTeamSessionTargetPresence.mockResolvedValue({ kind: 'owned' });
    repoDir = mkdtempSync(join(tmpdir(), 'omc-runtime-v2-shutdown-'));
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'README.md'), '# test\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
    process.env.OMC_STATE_DIR = join(repoDir, '.omc-state');
  });

  afterEach(async () => {
    for (const { attempt, bootstrap } of activeLaunches.splice(0)) {
      await terminateWorkerLaunchProvider(attempt, 2_000).catch(() => false);
      await bootstrap.catch(() => undefined);
    }
    if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = previousOmcStateDir;
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('removes dormant team-created worktrees during normal shutdown', async () => {
    const teamName = 'shutdown-team';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');

    const worktree = createWorkerWorktree(teamName, 'worker1', repoDir);
    expect(existsSync(worktree.path)).toBe(true);

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(existsSync(worktree.path)).toBe(false);
    expect(existsSync(teamRoot)).toBe(false);
  });
  it('keeps team state when dirty worktrees are preserved during shutdown', async () => {
    const teamName = 'shutdown-dirty-team';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');

    const worktree = createWorkerWorktree(teamName, 'worker-dirty', repoDir);
    writeFileSync(join(worktree.path, 'dirty.txt'), 'dirty', 'utf-8');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(teamRoot)).toBe(true);
  });




  it('keeps worktrees and team state when config is missing but clean metadata exists', async () => {
    const teamName = 'shutdown-missing-config-clean-metadata';
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    const worktree = createWorkerWorktree(teamName, 'worker-clean', repoDir);
    expect(existsSync(teamRoot)).toBe(true);
    expect(existsSync(join(teamRoot, 'worktrees.json'))).toBe(true);

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(teamRoot)).toBe(true);
    expect(existsSync(join(teamRoot, 'worktrees.json'))).toBe(true);
  });

  it('keeps team state when config is missing but worktree root AGENTS backup exists', async () => {
    const teamName = 'shutdown-backup-only-team';
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    const backupPath = join(teamRoot, 'workers', 'worker-1', 'worktree-root-agents.json');
    mkdirSync(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
    writeFileSync(backupPath, JSON.stringify({
      worktreePath: join(getOmcRoot(repoDir), 'team', teamName, 'worktrees', 'worker-1'),
      hadOriginal: true,
      originalContent: 'original',
      installedContent: 'managed',
      installedAt: new Date().toISOString(),
    }), 'utf-8');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(existsSync(teamRoot)).toBe(true);
    expect(existsSync(backupPath)).toBe(true);
  });

  it('keeps team state when config is missing but worktree metadata is corrupt', async () => {
    const teamName = 'shutdown-corrupt-metadata-team';
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    writeFileSync(join(teamRoot, 'worktrees.json'), '{not-json', 'utf-8');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(existsSync(teamRoot)).toBe(true);
    expect(existsSync(join(teamRoot, 'worktrees.json'))).toBe(true);
  });

  it('uses the canonical team state root in worktree shutdown ack instructions', async () => {
    const teamName = 'shutdown-worktree-ack-team';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });

    const worktree = createWorkerWorktree(teamName, 'worker-wt', repoDir);
    writeFileSync(join(worktree.path, 'dirty.txt'), 'dirty', 'utf-8');

    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-wt',
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        working_dir: worktree.path,
        team_state_root: teamRoot,
        worktree_path: worktree.path,
        worktree_created: true,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    const inbox = readFileSync(join(teamRoot, 'workers', 'worker-wt', 'inbox.md'), 'utf-8');
    expect(inbox).toContain('$OMC_TEAM_STATE_ROOT/workers/worker-wt/shutdown-ack.json');
    expect(inbox).not.toContain(`Write your ack to: .omc/state/team/${teamName}`);
  });

  it('keeps worktrees and team state when a worker pane remains alive after shutdown kill', async () => {
    const teamName = 'shutdown-live-pane-team';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    const worktree = createWorkerWorktree(teamName, 'worker-live', repoDir);
    const launchAttempt = await prepareAcceptedLaunch(repoDir, teamName, 'worker-live', '%42');
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-live',
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        pane_id: '%42',
        worker_cli: 'claude',
        launch_attempt_id: launchAttempt.attempt_id,
        launch_descriptor: { schema_version: 1, provider: 'claude', model: null, binary: '/bin/echo', args: [] },
        working_dir: worktree.path,
        team_state_root: teamRoot,
        worktree_path: worktree.path,
        worktree_created: true,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');
    tmuxMocks.getWorkerLiveness.mockResolvedValue('alive');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 })).resolves.toEqual({
      outcome: 'preserved', reason: 'worker_panes_alive', workers: ['worker-live'],
    });

    expect(tmuxMocks.killTeamSession).not.toHaveBeenCalled();
    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(teamRoot)).toBe(true);
    expect(existsSync(launchAttempt.currentPath)).toBe(true);
    expect(existsSync(`${launchAttempt.decisionPath}.retired.cleanup-complete`)).toBe(false);
  });



  it('keeps worktrees and team state when pane liveness probe is unknown after shutdown kill', async () => {
    const teamName = 'shutdown-unknown-pane-team';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    const worktree = createWorkerWorktree(teamName, 'worker-unknown', repoDir);
    const launchAttempt = await prepareAcceptedLaunch(repoDir, teamName, 'worker-unknown', '%44');
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-unknown',
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        pane_id: '%44',
        worker_cli: 'claude',
        launch_attempt_id: launchAttempt.attempt_id,
        launch_descriptor: { schema_version: 1, provider: 'claude', model: null, binary: '/bin/echo', args: [] },
        working_dir: worktree.path,
        team_state_root: teamRoot,
        worktree_path: worktree.path,
        worktree_created: true,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');
    tmuxMocks.getWorkerLiveness.mockResolvedValue('unknown');

    const binding = createTeamInstanceBinding({
      teamName,
      cwd: repoDir,
      instanceId: TEAM_INSTANCE_ID,
    });
    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 })).resolves.toEqual({
      outcome: 'preserved', reason: 'worker_pane_liveness_unknown', workers: ['worker-unknown'],
    });

    expect(tmuxMocks.killTeamSession).not.toHaveBeenCalled();
    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(teamRoot)).toBe(true);
    expect(existsSync(absPath(repoDir, TeamPaths.teamInstanceReservation(
      binding.workspace_hash,
      teamName,
    )))).toBe(true);
    expect(existsSync(absPath(repoDir, TeamPaths.teamInstanceCleanupReceipt(
      binding.workspace_hash,
      teamName,
      TEAM_INSTANCE_ID,
    )))).toBe(false);
  });

  it('keeps worktrees and team state when tmux cleanup fails before liveness is proven', async () => {
    const teamName = 'shutdown-kill-fails-team';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    const worktree = createWorkerWorktree(teamName, 'worker-kill-fails', repoDir);
    const launchAttempt = await prepareAcceptedLaunch(repoDir, teamName, 'worker-kill-fails', '%43');
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-kill-fails',
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        pane_id: '%43',
        worker_cli: 'claude',
        launch_attempt_id: launchAttempt.attempt_id,
        launch_descriptor: { schema_version: 1, provider: 'claude', model: null, binary: '/bin/echo', args: [] },
        working_dir: worktree.path,
        team_state_root: teamRoot,
        worktree_path: worktree.path,
        worktree_created: true,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: '%1',
      tmux_window_owned: true,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');
    tmuxMocks.killTeamSession.mockResolvedValueOnce(false);

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 })).resolves.toEqual({
      outcome: 'failed', reason: 'tmux_cleanup_failed', detail: 'tmux cleanup unverified',
    });

    expect(tmuxMocks.killTeamSession).toHaveBeenCalledWith(`${teamName}:0`, [], '%1', {
      sessionMode: 'dedicated-window',
      tmuxServerIdentity: tmuxMocks.tmuxServerIdentity,
    });
    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(teamRoot)).toBe(true);
  });

  it('retries dedicated-window shutdown after the original window is already gone', async () => {
    const teamName = 'shutdown-window-absent-retry';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: '%1',
      tmux_window_owned: true,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');
    tmuxMocks.observeTeamSessionTargetPresence.mockResolvedValue({ kind: 'absent' });
    tmuxMocks.verifyTeamTargetOwnership.mockResolvedValue({ kind: 'unavailable' });

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, {
      timeoutMs: 0,
      force: true,
      instanceId: TEAM_INSTANCE_ID,
    })).resolves.toEqual({ outcome: 'cleaned' });

    expect(tmuxMocks.observeTeamSessionTargetPresence).toHaveBeenCalledWith({
      sessionName: `${teamName}:0`,
      sessionMode: 'dedicated-window',
      leaderPaneId: '%1',
      tmuxServerIdentity: tmuxMocks.tmuxServerIdentity,
    });
    expect(tmuxMocks.killTeamSession).toHaveBeenCalledWith(`${teamName}:0`, [], '%1', {
      sessionMode: 'dedicated-window',
      tmuxServerIdentity: tmuxMocks.tmuxServerIdentity,
    });
    expect(existsSync(join(teamRoot, 'config.json'))).toBe(false);
  });

  it('preserves dedicated-window shutdown when the window remains without the leader pane', async () => {
    const teamName = 'shutdown-window-unowned';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: '%1',
      tmux_window_owned: true,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');
    tmuxMocks.observeTeamSessionTargetPresence.mockResolvedValue({ kind: 'present_unowned' });

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, {
      timeoutMs: 0,
      force: true,
      instanceId: TEAM_INSTANCE_ID,
    })).resolves.toEqual({
      outcome: 'preserved',
      reason: 'provider_cleanup_unverified',
      workers: ['leader-fixed'],
    });

    expect(tmuxMocks.killTeamSession).not.toHaveBeenCalled();
    expect(existsSync(join(teamRoot, 'config.json'))).toBe(true);
  });



  it.each([false, true])('blocks %s force shutdown before effects while recovery is active', async force => {
    const teamName = force ? 'shutdown-active-force' : 'shutdown-active-normal';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 1, max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%77' }],
      created_at: new Date().toISOString(), tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 4,
      active_recovery: { request_id: 'request-active', recovery_id: 'recovery-active', worker_name: 'worker-1',
        owner_epoch: 2, owner_nonce: 'owner', phase: 'active', state_revision: 4,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      next_task_id: 1,
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0, force }))
      .rejects.toThrow('shutdown_blocked:active_recovery:recovery-active');
    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(tmuxMocks.killTeamSession).not.toHaveBeenCalled();
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('active');
  });

  it('does not commit shutdown lifecycle or kill panes when manifest projection fails', async () => {
    const teamName = 'shutdown-projection-failure';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 1, max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%77' }],
      created_at: new Date().toISOString(), tmux_session: `${teamName}:0`, lifecycle_state: 'active',
      state_revision: 4, next_task_id: 1,
    }));
    mkdirSync(join(teamRoot, 'manifest.json'));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0, force: true }))
      .rejects.toThrow('invalid_persisted_state');
    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(tmuxMocks.killTeamSession).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ lifecycle_state: 'active', state_revision: 4 });
  });

  it('blocks shutdown before effects while a scale-down reservation is active', async () => {
    const teamName = 'shutdown-active-scale-down';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    const now = new Date().toISOString();
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 2, max_workers: 20,
      workers: [
        { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%77' },
        { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [], pane_id: '%78' },
      ],
      created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 4,
      active_scale_down: { operation_id: 'scale-down-active', phase: 'draining', pid: process.pid,
        process_started_at: 'test-process-start', workers: [{ name: 'worker-2', pane_id: '%78' }],
        state_revision: 4, created_at: now, updated_at: now },
      next_task_id: 1,
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0, force: true }))
      .rejects.toThrow('shutdown_blocked:active_scale_down:scale-down-active');
    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(tmuxMocks.killTeamSession).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('active');
  });

  it('restores active lifecycle when a worker rejects normal shutdown before pane cleanup', async () => {
    const teamName = 'shutdown-worker-rejected';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    const workerRoot = join(teamRoot, 'workers', 'worker-1');
    mkdirSync(workerRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 1, max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%77' }],
      created_at: new Date().toISOString(), tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 4,
      next_task_id: 1,
    }));
    writeFileSync(join(workerRoot, 'shutdown-ack.json'), JSON.stringify({
      status: 'reject', reason: 'still working', updated_at: '2099-01-01T00:00:00.000Z',
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 25 }))
      .rejects.toThrow('shutdown_rejected:worker-1:still working');

    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(tmuxMocks.killTeamSession).not.toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(persisted.lifecycle_state).toBe('active');
    expect(persisted.state_revision).toBe(6);
    expect(persisted.active_recovery).toBeUndefined();
  });

  it('does not roll back a shutdown fence owned by another concurrent invocation', async () => {
    const teamName = 'shutdown-concurrent-owner';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    const workerRoot = join(teamRoot, 'workers', 'worker-1');
    mkdirSync(workerRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    const now = new Date().toISOString();
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 1, max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%77' }],
      created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'shutting_down', state_revision: 5,
      shutdown_attempt: { nonce: 'force-owner', instance_id: TEAM_INSTANCE_ID, pid: process.pid, process_started_at: currentProcessStartIdentity(), state_revision: 5, created_at: now },
      next_task_id: 1,
    }));
    writeFileSync(join(workerRoot, 'shutdown-ack.json'), JSON.stringify({
      status: 'reject', reason: 'still working', updated_at: '2099-01-01T00:00:00.000Z',
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 25 }))
      .rejects.toThrow('shutdown_in_progress');

    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(tmuxMocks.killTeamSession).not.toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(persisted.lifecycle_state).toBe('shutting_down');
    expect(persisted.state_revision).toBe(5);
    expect(persisted.shutdown_attempt.nonce).toBe('force-owner');
  });

  it('leaves an active team recoverable when the normal shutdown gate blocks', async () => {
    const teamName = 'shutdown-gate-blocked';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    const tasksRoot = join(teamRoot, 'tasks');
    mkdirSync(tasksRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 1, max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: ['1'], pane_id: '%77' }],
      created_at: new Date().toISOString(), tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 4,
      next_task_id: 2,
    }));
    writeFileSync(join(tasksRoot, 'task-1.json'), JSON.stringify({
      id: '1', subject: 'pending', description: 'must finish first', status: 'pending',
      owner: 'worker-1', blocked_by: [], depends_on: [], created_at: new Date().toISOString(), version: 1,
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 }))
      .rejects.toThrow('shutdown_gate_blocked:pending=1,blocked=0,in_progress=0,failed=0');

    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(tmuxMocks.killTeamSession).not.toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(persisted.lifecycle_state).toBe('active');
    expect(persisted.state_revision).toBe(4);
    expect(persisted.active_recovery).toBeUndefined();
  });

  it('commits the stopped fence when the post-cleanup Ralph summary cannot read tasks', async () => {
    const teamName = 'shutdown-ralph-summary-failure';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    const tasksRoot = join(teamRoot, 'tasks');
    const worktree = createWorkerWorktree(teamName, 'worker-1', repoDir);
    writeFileSync(join(worktree.path, 'dirty.txt'), 'preserve for fence inspection\n', 'utf8');
    mkdirSync(tasksRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    const taskPath = join(tasksRoot, 'task-1.json');
    const launchAttempt = await prepareAcceptedLaunch(repoDir, teamName, 'worker-1', '%42');
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-1',
        index: 1,
        role: 'executor',
        assigned_tasks: ['1'],
        pane_id: '%42',
        worker_cli: 'claude',
        launch_attempt_id: launchAttempt.attempt_id,
        launch_descriptor: { schema_version: 1, provider: 'claude', model: null, binary: '/bin/echo', args: [] },
        working_dir: worktree.path,
        worktree_path: worktree.path,
        worktree_created: true,
        team_state_root: teamRoot,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: '%1',
      lifecycle_state: 'active',
      state_revision: 4,
      next_task_id: 2,
    }));
    writeFileSync(taskPath, JSON.stringify({
      id: '1',
      subject: 'complete',
      description: 'completed before shutdown',
      status: 'completed',
      version: 1,
      created_at: new Date().toISOString(),
    }));
    tmuxMocks.getWorkerLiveness
      .mockResolvedValueOnce('alive')
      .mockResolvedValueOnce('alive')
      .mockResolvedValueOnce('dead');
    tmuxMocks.killOwnedWorkerPane.mockImplementationOnce(async () => {
      writeFileSync(taskPath, '{corrupt task after pane cleanup', 'utf8');
    });

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0, ralph: true }))
      .resolves.toEqual({ outcome: 'preserved', reason: 'worktrees_preserved', workers: [] });

    const stoppedConfig = JSON.parse(readFileSync(configPath, 'utf8')) as {
      lifecycle_state?: string;
      shutdown_attempt?: unknown;
    };
    expect(stoppedConfig.lifecycle_state).toBe('stopped');
    expect(stoppedConfig.shutdown_attempt).toBeUndefined();
    expect(readFileSync(join(teamRoot, 'events.jsonl'), 'utf8'))
      .toContain('ralph_cleanup_summary_unavailable');
  });
  it('rejects a stale expected instance before any shutdown effects', async () => {
    const teamName = 'shutdown-stale-instance';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%88' }],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      lifecycle_state: 'active',
      state_revision: 1,
      next_task_id: 1,
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, {
      timeoutMs: 0,
      force: true,
      instanceId: REPLACEMENT_INSTANCE_ID,
    })).rejects.toThrow('team_instance_mismatch');

    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(tmuxMocks.killTeamSession).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      instance_id: TEAM_INSTANCE_ID,
      lifecycle_state: 'active',
      state_revision: 1,
    });
  });

  it('adopts an interrupted ordinary shutdown only after positive owner death', async () => {
    const teamName = 'shutdown-dead-owner';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      tmux_window_owned: false,
      lifecycle_state: 'shutting_down',
      state_revision: 1,
      shutdown_attempt: {
        nonce: 'ordinary-interrupted',
        instance_id: TEAM_INSTANCE_ID,
        pid: 999999,
        // Must be a platform-shaped identity: isProcessIdentityDead() refuses to
        // treat a malformed identity as positive proof of death, so the tmux
        // server identity shape (`linux:<bootId>:<pid>`) would keep this
        // interrupted attempt "live" and block adoption.
        process_started_at: process.platform === 'darwin'
          ? 'darwin:1700000000:123456'
          : 'linux:424242',
        state_revision: 1,
        created_at: new Date().toISOString(),
      },
      next_task_id: 1,
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, {
      timeoutMs: 0,
      force: true,
      instanceId: TEAM_INSTANCE_ID,
    })).resolves.toEqual({ outcome: 'cleaned' });

    expect(existsSync(configPath)).toBe(false);
  });

  it('keeps a queued second shutdown behind final instance disposal', async () => {
    const teamName = 'shutdown-final-boundary';
    await reserveFixtureInstance(teamName, repoDir);
    const teamRoot = fixtureTeamRoot(repoDir, teamName);
    mkdirSync(teamRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: teamName,
      tmux_window_owned: true,
      lifecycle_state: 'active',
      state_revision: 1,
      next_task_id: 1,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    }));

    const originalDispose = teamInstanceModule.disposeTeamInstanceUnderLock;
    let releaseDispose!: () => void;
    let enteredDispose!: () => void;
    const disposeEntered = new Promise<void>(resolveEntered => { enteredDispose = resolveEntered; });
    const disposeGate = new Promise<void>(resolveGate => { releaseDispose = resolveGate; });
    let disposeReleased = false;
    let firstCompletion: Promise<unknown> | undefined;
    const disposeSpy = vi.spyOn(teamInstanceModule, 'disposeTeamInstanceUnderLock')
      .mockImplementation(async (...args) => {
        enteredDispose();
        await disposeGate;
        return originalDispose(...args);
      });
    try {
      const { shutdownTeamV2 } = await import('../runtime-v2.js');
      const first = shutdownTeamV2(teamName, repoDir, { force: true, timeoutMs: 0, instanceId: TEAM_INSTANCE_ID });
      const firstSettled = first.then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      );
      firstCompletion = firstSettled;
      const gateOrEarlyExit = await Promise.race([
        disposeEntered.then(() => ({ status: 'entered' as const })),
        firstSettled,
        new Promise<{ status: 'timeout' }>(resolve => setTimeout(() => resolve({ status: 'timeout' }), 2_000)),
      ]);
      if (gateOrEarlyExit.status === 'resolved') {
        throw new Error(`first shutdown completed before final disposal: ${JSON.stringify(gateOrEarlyExit.value)}`);
      }
      if (gateOrEarlyExit.status === 'rejected') throw gateOrEarlyExit.error;
      if (gateOrEarlyExit.status === 'timeout') throw new Error('final disposal gate was not reached');

      let secondSettled = false;
      const second = shutdownTeamV2(teamName, repoDir, { force: true, timeoutMs: 0, instanceId: TEAM_INSTANCE_ID })
        .finally(() => { secondSettled = true; });
      await new Promise(resolveTick => setTimeout(resolveTick, 10));
      expect(secondSettled).toBe(false);

      disposeReleased = true;
      releaseDispose();
      await expect(first).resolves.toEqual({ outcome: 'cleaned' });
      await expect(second).resolves.toEqual({ outcome: 'cleaned' });
      expect(existsSync(configPath)).toBe(false);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (!disposeReleased) {
        disposeReleased = true;
        releaseDispose();
      }
      await firstCompletion?.catch(() => undefined);
      disposeSpy.mockRestore();
    }
  });
});
