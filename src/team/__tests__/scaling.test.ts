import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const tmuxUtilsMocks = vi.hoisted(() => ({
  tmuxExec: vi.fn(),
  tmuxSpawn: vi.fn(),
}));

const modelContractMocks = vi.hoisted(() => ({
  buildWorkerArgv: vi.fn(),
  getWorkerEnv: vi.fn(),
  resolveClaudeWorkerModel: vi.fn(),
  validateWorkerLaunchDescriptor: vi.fn((value: unknown) => value),
}));

const teamOpsMocks = vi.hoisted(() => ({
  teamReadConfig: vi.fn(),
  teamWriteWorkerIdentity: vi.fn(),
  teamReadWorkerStatus: vi.fn(),
  teamAppendEvent: vi.fn(),
  writeAtomic: vi.fn(),
}));

const monitorMocks = vi.hoisted(() => ({
  withScalingLock: vi.fn(),
  saveTeamConfig: vi.fn(),
  migrateTeamConfigRevision: vi.fn(),
  readRevisionedTeamConfig: vi.fn(),
  saveTeamConfigAtRevision: vi.fn(),
}));

const processIdentityMocks = vi.hoisted(() => ({
  currentProcessStartIdentity: vi.fn(),
  isProcessIdentityDead: vi.fn(),
}));

function currentPlatformProcessIdentity(pid: number): string {
  if (process.platform === 'linux') return `linux:${pid}`;
  if (process.platform === 'win32') return `win32:${pid}`;
  if (process.platform === 'darwin') return `darwin:${pid}:0`;
  return `${process.platform}:identity-${pid}`;
}

vi.mock('../team-owner-epoch.js', () => ({
  currentProcessStartIdentity: processIdentityMocks.currentProcessStartIdentity,
  isProcessIdentityDead: processIdentityMocks.isProcessIdentityDead,
  isValidProcessStartIdentity: (value: unknown) => typeof value === 'string' && /^(linux|darwin|win32):/.test(value),
}));

const tmuxSessionMocks = vi.hoisted(() => ({
  sanitizeName: vi.fn((name: string) => name),
  getWorkerLiveness: vi.fn(),
  killWorkerPanes: vi.fn(),
  buildWorkerStartCommand: vi.fn(() => 'start-worker'),
  waitForPaneReady: vi.fn(),
}));

const gitWorktreeMocks = vi.hoisted(() => ({
  ensureWorkerWorktree: vi.fn(),
  installWorktreeRootAgents: vi.fn(),
  removeWorkerWorktree: vi.fn(),
  restoreWorktreeRootAgents: vi.fn(),
  checkWorkerWorktreeRemovalSafety: vi.fn(),
  prepareWorkerWorktreeForRemoval: vi.fn(),
}));

vi.mock('../../cli/tmux-utils.js', () => ({
  tmuxExec: tmuxUtilsMocks.tmuxExec,
  tmuxSpawn: tmuxUtilsMocks.tmuxSpawn,
}));

vi.mock('../model-contract.js', () => ({
  buildWorkerArgv: modelContractMocks.buildWorkerArgv,
  getWorkerEnv: modelContractMocks.getWorkerEnv,
  resolveClaudeWorkerModel: modelContractMocks.resolveClaudeWorkerModel,
  validateWorkerLaunchDescriptor: modelContractMocks.validateWorkerLaunchDescriptor,
  assertHeadlessSupported: () => {},
  isHeadlessSupportedOnPlatform: () => true,
}));

vi.mock('../team-ops.js', () => ({
  teamReadConfig: teamOpsMocks.teamReadConfig,
  teamWriteWorkerIdentity: teamOpsMocks.teamWriteWorkerIdentity,
  teamReadWorkerStatus: teamOpsMocks.teamReadWorkerStatus,
  teamAppendEvent: teamOpsMocks.teamAppendEvent,
  writeAtomic: teamOpsMocks.writeAtomic,
}));

vi.mock('../monitor.js', () => ({
  withScalingLock: monitorMocks.withScalingLock,
  saveTeamConfig: monitorMocks.saveTeamConfig,
  migrateTeamConfigRevision: monitorMocks.migrateTeamConfigRevision,
  readRevisionedTeamConfig: monitorMocks.readRevisionedTeamConfig,
  saveTeamConfigAtRevision: monitorMocks.saveTeamConfigAtRevision,
}));

vi.mock('../tmux-session.js', () => ({
  sanitizeName: tmuxSessionMocks.sanitizeName,
  getWorkerLiveness: tmuxSessionMocks.getWorkerLiveness,
  killWorkerPanes: tmuxSessionMocks.killWorkerPanes,
  buildWorkerStartCommand: tmuxSessionMocks.buildWorkerStartCommand,
  waitForPaneReady: tmuxSessionMocks.waitForPaneReady,
}));

vi.mock('../git-worktree.js', () => ({
  ensureWorkerWorktree: gitWorktreeMocks.ensureWorkerWorktree,
  installWorktreeRootAgents: gitWorktreeMocks.installWorktreeRootAgents,
  removeWorkerWorktree: gitWorktreeMocks.removeWorkerWorktree,
  restoreWorktreeRootAgents: gitWorktreeMocks.restoreWorktreeRootAgents,
  checkWorkerWorktreeRemovalSafety: gitWorktreeMocks.checkWorkerWorktreeRemovalSafety,
  prepareWorkerWorktreeForRemoval: gitWorktreeMocks.prepareWorkerWorktreeForRemoval,
}));

import { scaleDown, scaleUp } from '../scaling.js';
import type { TeamConfig, TeamScaleUpAttempt } from '../types.js';
import { absPath, TeamPaths } from '../state-paths.js';

describe('scaleUp duplicate worker guard', () => {
  let cwd: string;
  let config: TeamConfig;

  function makeConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
    const base: TeamConfig = {
      name: 'demo-team',
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%1' }],
      created_at: new Date().toISOString(),
      tmux_session: 'demo-session:0',
      next_task_id: 2,
      next_worker_index: 1,
      leader_pane_id: '%0',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      team_state_root: `${resolve(cwd)}/.omc/state/team/demo-team`,
    };
    return { ...base, ...overrides };
  }

  function setActiveScaleUpFence(
    pid: number,
    processStartedAt: string,
    phase: TeamScaleUpAttempt['phase'] = 'reserved',
  ): void {
    config.active_scale_up = {
      operation_id: 'abandoned-scale-up', phase, pid, process_started_at: processStartedAt,
      state_revision: config.state_revision ?? 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
  }

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-scaling-duplicate-'));
    vi.clearAllMocks();
    processIdentityMocks.currentProcessStartIdentity.mockImplementation((pid = process.pid) => currentPlatformProcessIdentity(pid));
    processIdentityMocks.isProcessIdentityDead.mockReturnValue(false);

    monitorMocks.withScalingLock.mockImplementation(async (
      _teamName: string,
      _leaderCwd: string,
      fn: () => Promise<unknown>,
    ) => fn());
    monitorMocks.saveTeamConfig.mockImplementation(async (nextConfig: TeamConfig) => {
      config = nextConfig;
    });

    teamOpsMocks.teamReadConfig.mockImplementation(async () => config);
    monitorMocks.migrateTeamConfigRevision.mockImplementation(async () => ({ config, stateRevision: config.state_revision ?? 0 }));
    monitorMocks.readRevisionedTeamConfig.mockImplementation(async () => ({ config, stateRevision: config.state_revision ?? 0 }));
    monitorMocks.saveTeamConfigAtRevision.mockImplementation(async (nextConfig: TeamConfig, expectedRevision: number) => {
      if ((config.state_revision ?? 0) !== expectedRevision) return false;
      config = nextConfig;
      return true;
    });
    teamOpsMocks.teamWriteWorkerIdentity.mockResolvedValue(undefined);
    teamOpsMocks.teamAppendEvent.mockResolvedValue(undefined);

    modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/claude']);
    modelContractMocks.getWorkerEnv.mockImplementation((teamName: string, workerName: string, agentType: string) => ({
      OMC_TEAM_WORKER: `${teamName}/${workerName}`,
      OMC_TEAM_NAME: teamName,
      OMC_WORKER_AGENT_TYPE: agentType,
    }));

    tmuxUtilsMocks.tmuxSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'display-message' && args.includes('#{session_name}:#{window_index}')) {
        return { status: 0, stdout: 'demo-session:0\n', stderr: '' };
      }
      if (args[0] === 'split-window') {
        return { status: 0, stdout: '%12\n', stderr: '' };
      }
      if (args[0] === 'display-message' && args.includes('#{pane_pid}')) {
        return { status: 0, stdout: '4321\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    tmuxSessionMocks.waitForPaneReady.mockResolvedValue(undefined);
    config = makeConfig();
  });

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it('skips past colliding worker names when next_worker_index is stale without touching real tmux', async () => {
    const result = await scaleUp(
      'demo-team',
      1,
      'claude',
      [{ subject: 'demo', description: 'demo task' }],
      cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv,
    );

    expect(result).toMatchObject({ ok: true, newWorkerCount: 2, nextWorkerIndex: 3 });
    expect(config.next_worker_index).toBe(3);
    expect(config.workers.map((worker) => worker.name)).toEqual(['worker-1', 'worker-2']);
    expect(tmuxUtilsMocks.tmuxSpawn).toHaveBeenCalledWith([
      'split-window', '-v', '-t', '%1', '-d', '-P', '-F', '#{pane_id}', '-c', resolve(cwd), 'start-worker',
    ]);
  });

  it('keeps the active scale-up fence revision aligned through normal worker reservation and commit', async () => {
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'disabled' });
    const snapshots: TeamConfig[] = [];
    monitorMocks.saveTeamConfigAtRevision.mockImplementation(async (nextConfig: TeamConfig, expectedRevision: number) => {
      if ((config.state_revision ?? 0) !== expectedRevision) return false;
      if (nextConfig.active_scale_up?.state_revision !== undefined
        && nextConfig.active_scale_up.state_revision !== nextConfig.state_revision) {
        throw new Error('invalid_persisted_state');
      }
      snapshots.push(structuredClone(nextConfig));
      config = nextConfig;
      return true;
    });

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1', OMC_TEAM_SKIP_READY_WAIT: '1' } as NodeJS.ProcessEnv);

    expect(result).toMatchObject({ ok: true, newWorkerCount: 2, nextWorkerIndex: 3 });
    expect(snapshots.some(snapshot => snapshot.workers.some(worker => worker.name === 'worker-2'
      && worker.operational_state === 'starting'))).toBe(true);
    expect(snapshots.some(snapshot => snapshot.workers.some(worker => worker.name === 'worker-2'
      && worker.operational_state === 'active'))).toBe(true);
    expect(snapshots.filter(snapshot => snapshot.active_scale_up).every(snapshot =>
      snapshot.active_scale_up?.state_revision === snapshot.state_revision)).toBe(true);
    expect(snapshots.at(-1)?.active_scale_up).toBeUndefined();
  });

  it.each(['shutting_down', 'stopped'] as const)('rejects scale-up while team lifecycle is %s', async lifecycleState => {
    config = makeConfig({ state_revision: 4, lifecycle_state: lifecycleState, next_worker_index: 2 });

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, error: 'team_mutation_busy' });
    expect(tmuxUtilsMocks.tmuxSpawn.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
    expect(teamOpsMocks.teamWriteWorkerIdentity).not.toHaveBeenCalled();
  });

  it('reclaims a complete positively dead scale-up fence before worker effects', async () => {
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'disabled' });
    const abandonedPid = 812_345;
    const abandonedStart = currentPlatformProcessIdentity(abandonedPid);
    setActiveScaleUpFence(abandonedPid, abandonedStart);
    processIdentityMocks.isProcessIdentityDead.mockImplementation((fence: { pid: number; process_started_at: string }) =>
      fence.pid === abandonedPid && fence.process_started_at === abandonedStart);

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toMatchObject({ ok: true, newWorkerCount: 2 });
    expect(processIdentityMocks.isProcessIdentityDead).toHaveBeenCalledWith(expect.objectContaining({
      pid: abandonedPid, process_started_at: abandonedStart,
    }));
    const reclamation = monitorMocks.saveTeamConfigAtRevision.mock.calls[0]?.[0] as TeamConfig & { active_scale_up?: { operation_id: string } };
    expect(reclamation.active_scale_up?.operation_id).not.toBe('abandoned-scale-up');
    const splitCall = tmuxUtilsMocks.tmuxSpawn.mock.calls.findIndex(([args]) => args[0] === 'split-window');
    expect(monitorMocks.saveTeamConfigAtRevision.mock.invocationCallOrder[0]).toBeLessThan(
      tmuxUtilsMocks.tmuxSpawn.mock.invocationCallOrder[splitCall]!,
    );
  });

  it('keeps a positively dead effects attempt fenced without touching attributable worker resources', async () => {
    const abandonedPid = 812_350;
    config = makeConfig({ state_revision: 4, worker_count: 2, next_worker_index: 3, worktree_mode: 'disabled', workers: [
      { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%1', operational_state: 'active' },
      { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [], pane_id: '%abandoned', operational_state: 'starting' },
    ] });
    setActiveScaleUpFence(abandonedPid, currentPlatformProcessIdentity(abandonedPid), 'effects');
    processIdentityMocks.isProcessIdentityDead.mockReturnValue(true);

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, error: 'team_mutation_busy' });
    expect(config.active_scale_up).toMatchObject({ operation_id: 'abandoned-scale-up', phase: 'effects' });
    expect(config.workers.map(worker => worker.name)).toEqual(['worker-1', 'worker-2']);
    expect(monitorMocks.saveTeamConfigAtRevision).not.toHaveBeenCalled();
    expect(tmuxUtilsMocks.tmuxSpawn).not.toHaveBeenCalled();
    expect(tmuxUtilsMocks.tmuxExec).not.toHaveBeenCalled();
    expect(gitWorktreeMocks.removeWorkerWorktree).not.toHaveBeenCalled();
    expect(teamOpsMocks.teamWriteWorkerIdentity).not.toHaveBeenCalled();
  });

  it('keeps a positively dead failed scale-up attempt fenced without starting effects', async () => {
    const abandonedPid = 812_351;
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'disabled' });
    setActiveScaleUpFence(abandonedPid, currentPlatformProcessIdentity(abandonedPid), 'failed');
    processIdentityMocks.isProcessIdentityDead.mockReturnValue(true);

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, error: 'team_mutation_busy' });
    expect(config.active_scale_up).toMatchObject({ operation_id: 'abandoned-scale-up', phase: 'failed' });
    expect(monitorMocks.saveTeamConfigAtRevision).not.toHaveBeenCalled();
    expect(tmuxUtilsMocks.tmuxSpawn).not.toHaveBeenCalled();
    expect(tmuxUtilsMocks.tmuxExec).not.toHaveBeenCalled();
  });

  it.each([
    ['live', process.pid, currentPlatformProcessIdentity(process.pid)],
    ['malformed', 812_346, 'not-a-process-start-identity'],
    ['cross-platform', 812_347, process.platform === 'linux' ? 'win32:1' : 'linux:1'],
    ['unknown', 812_348, currentPlatformProcessIdentity(812_348)],
  ] as const)('keeps a %s scale-up fence busy without effects when ownership cannot be proved dead', async (_kind, pid, processStartedAt) => {
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'disabled' });
    setActiveScaleUpFence(pid, processStartedAt);
    processIdentityMocks.isProcessIdentityDead.mockReturnValue(false);

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, error: 'team_mutation_busy' });
    expect(processIdentityMocks.isProcessIdentityDead).toHaveBeenCalledWith(expect.objectContaining({ pid, process_started_at: processStartedAt }));
    expect(monitorMocks.saveTeamConfigAtRevision).not.toHaveBeenCalled();
    expect(tmuxUtilsMocks.tmuxSpawn.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
  });

  it('does not start worker effects when the dead-fence reclamation CAS is lost', async () => {
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'disabled' });
    const abandonedPid = 812_349;
    setActiveScaleUpFence(abandonedPid, currentPlatformProcessIdentity(abandonedPid));
    processIdentityMocks.isProcessIdentityDead.mockReturnValue(true);
    monitorMocks.saveTeamConfigAtRevision.mockResolvedValueOnce(false);

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, error: 'team_mutation_busy' });
    expect(tmuxUtilsMocks.tmuxSpawn.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
  });

  it('normalizes an effects-fence CAS exception and clears the exact reservation before effects', async () => {
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'disabled' });
    monitorMocks.saveTeamConfigAtRevision
      .mockImplementationOnce(async (nextConfig: TeamConfig) => { config = nextConfig; return true; })
      .mockRejectedValueOnce(new Error('stale_state_revision'))
      .mockImplementation(async (nextConfig: TeamConfig, expectedRevision: number) => {
        if ((config.state_revision ?? 0) !== expectedRevision) return false;
        config = nextConfig;
        return true;
      });

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, error: 'team_mutation_busy' });
    expect((config as TeamConfig & { active_scale_up?: unknown }).active_scale_up).toBeUndefined();
    expect(tmuxUtilsMocks.tmuxSpawn.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
  });

  it('rolls back scale-up effects when manifest projection fails before config commit', async () => {
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'disabled' });
    monitorMocks.saveTeamConfigAtRevision.mockImplementation(async (nextConfig: TeamConfig, expectedRevision: number) => {
      if ((config.state_revision ?? 0) !== expectedRevision) return false;
      if (nextConfig.workers.some(worker => worker.name === 'worker-2' && worker.operational_state === 'active')) {
        throw new Error('invalid_persisted_state');
      }
      config = nextConfig;
      return true;
    });
    tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('dead');

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1', OMC_TEAM_SKIP_READY_WAIT: '1' } as NodeJS.ProcessEnv);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('config commit lost its revision') });
    expect(tmuxUtilsMocks.tmuxExec).toHaveBeenCalledWith(['kill-pane', '-t', '%12'], { stdio: 'pipe' });
    expect(config.workers.map(worker => worker.name)).toEqual(['worker-1']);
    expect((config as TeamConfig & { active_scale_up?: unknown }).active_scale_up).toBeUndefined();
  });

  it('retires both active and starting reservations when a later worker fails', async () => {
    config = makeConfig({ state_revision: 4, worker_count: 0, workers: [], next_worker_index: 1,
      leader_pane_id: '%0', worktree_mode: 'disabled' });
    const snapshots: TeamConfig[] = [];
    monitorMocks.saveTeamConfigAtRevision.mockImplementation(async (nextConfig: TeamConfig, expectedRevision: number) => {
      if ((config.state_revision ?? 0) !== expectedRevision) return false;
      snapshots.push(structuredClone(nextConfig));
      config = nextConfig;
      return true;
    });
    teamOpsMocks.teamWriteWorkerIdentity.mockImplementation(async (_teamName: string, workerName: string) => {
      if (workerName === 'worker-2') throw new Error('second identity failed');
    });
    tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('dead');

    const result = await scaleUp('demo-team', 2, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1', OMC_TEAM_SKIP_READY_WAIT: '1' } as NodeJS.ProcessEnv);

    expect(result).toMatchObject({ ok: false });
    const firstReservation = snapshots.find(snapshot => snapshot.workers.length === 1
      && snapshot.workers[0]?.name === 'worker-1' && snapshot.workers[0].operational_state === 'starting');
    const secondReservation = snapshots.find(snapshot => snapshot.workers.length === 2
      && snapshot.workers[0]?.operational_state === 'active' && snapshot.workers[1]?.operational_state === 'starting');
    expect(firstReservation?.workers).toEqual([expect.objectContaining({ name: 'worker-1', operational_state: 'starting' })]);
    expect(secondReservation?.workers).toEqual([
      expect.objectContaining({ name: 'worker-1', operational_state: 'active' }),
      expect.objectContaining({ name: 'worker-2', operational_state: 'starting' }),
    ]);
    expect(config.workers).toEqual([]);
    expect(config.worker_count).toBe(0);
  });

  it('self-heals across multiple collisions', async () => {
    config = makeConfig({
      worker_count: 2,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%1' },
        { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [], pane_id: '%2' },
      ],
      next_worker_index: 1,
    });

    const result = await scaleUp(
      'demo-team',
      1,
      'claude',
      [{ subject: 'demo', description: 'demo task' }],
      cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv,
    );

    expect(result).toMatchObject({ ok: true, newWorkerCount: 3, nextWorkerIndex: 4 });
    expect(config.next_worker_index).toBe(4);
    expect(config.workers.map((worker) => worker.name)).toEqual(['worker-1', 'worker-2', 'worker-3']);
  });

  it('allows legacy session-only tmux_session configs while still validating the session before split-window', async () => {
    config = makeConfig({
      worker_count: 0,
      workers: [],
      next_worker_index: 1,
      leader_pane_id: '%0',
      tmux_session: 'demo-session',
    });
    tmuxUtilsMocks.tmuxSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'display-message' && args.includes('#{session_name}')) {
        return { status: 0, stdout: 'demo-session\n', stderr: '' };
      }
      if (args[0] === 'split-window') {
        return { status: 0, stdout: '%12\n', stderr: '' };
      }
      if (args[0] === 'display-message' && args.includes('#{pane_pid}')) {
        return { status: 0, stdout: '4321\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = await scaleUp(
      'demo-team',
      1,
      'claude',
      [{ subject: 'demo', description: 'demo task' }],
      cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv,
    );

    expect(result).toMatchObject({ ok: true, newWorkerCount: 1, nextWorkerIndex: 2 });
    expect(tmuxUtilsMocks.tmuxSpawn).toHaveBeenCalledWith([
      'display-message', '-t', '%0', '-p', '#{session_name}',
    ]);
    expect(tmuxUtilsMocks.tmuxSpawn).toHaveBeenCalledWith(expect.arrayContaining(['split-window']));
  });

  it('fails loudly before filesystem/worktree side effects when tmux_session is missing from stale config', async () => {
    config = makeConfig({
      worker_count: 0,
      workers: [],
      next_worker_index: 1,
      leader_pane_id: '%997',
      tmux_session: undefined as unknown as string,
    });

    const result = await scaleUp(
      'demo-team',
      1,
      'claude',
      [{ subject: 'demo', description: 'demo task' }],
      cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv,
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('missing configured tmux_session');
    }
    expect(tmuxUtilsMocks.tmuxSpawn).not.toHaveBeenCalledWith(expect.arrayContaining(['split-window']));
    expect(modelContractMocks.buildWorkerArgv).not.toHaveBeenCalled();
  });

  it('fails loudly before split-window when the target pane belongs to another tmux session', async () => {
    config = makeConfig({
      worker_count: 0,
      workers: [],
      next_worker_index: 1,
      leader_pane_id: '%999',
      tmux_session: 'demo-session:0',
    });
    tmuxUtilsMocks.tmuxSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'display-message' && args.includes('#{session_name}:#{window_index}')) {
        return { status: 0, stdout: 'other-session\n', stderr: '' };
      }
      if (args[0] === 'split-window') {
        throw new Error('split-window must not be called for an untrusted pane target');
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = await scaleUp(
      'demo-team',
      1,
      'claude',
      [{ subject: 'demo', description: 'demo task' }],
      cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv,
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Refusing to split tmux pane %999');
      expect(result.error).toContain('expected demo-session');
    }
    expect(tmuxUtilsMocks.tmuxSpawn).not.toHaveBeenCalledWith(expect.arrayContaining(['split-window']));
  });

  it('fails loudly before split-window when the target pane belongs to another window in the configured tmux session', async () => {
    config = makeConfig({
      worker_count: 0,
      workers: [],
      next_worker_index: 1,
      leader_pane_id: '%998',
      tmux_session: 'demo-session:0',
    });
    tmuxUtilsMocks.tmuxSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'display-message' && args.includes('#{session_name}:#{window_index}')) {
        return { status: 0, stdout: 'demo-session:1\n', stderr: '' };
      }
      if (args[0] === 'split-window') {
        throw new Error('split-window must not be called for a pane in another team window');
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = await scaleUp(
      'demo-team',
      1,
      'claude',
      [{ subject: 'demo', description: 'demo task' }],
      cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv,
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Refusing to split tmux pane %998');
      expect(result.error).toContain('expected demo-session:0');
    }
    expect(tmuxUtilsMocks.tmuxSpawn).not.toHaveBeenCalledWith(expect.arrayContaining(['split-window']));
  });

  it('rolls back spawned effects when shutdown wins the config revision', async () => {
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'named' });
    const worktreePath = join(cwd, '.omc', 'team', 'demo-team', 'worktrees', 'worker-2');
    gitWorktreeMocks.ensureWorkerWorktree.mockReturnValue({ path: worktreePath, branch: 'worker-2',
      detached: false, created: true });
    gitWorktreeMocks.installWorktreeRootAgents.mockReturnValue(undefined);
    teamOpsMocks.teamWriteWorkerIdentity.mockImplementation(async (teamName: string, workerName: string) => {
      const workerDir = absPath(cwd, TeamPaths.workerDir(teamName, workerName));
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(workerDir, 'identity.json'), '{}');
    });
    monitorMocks.saveTeamConfigAtRevision
      .mockImplementationOnce(async (nextConfig: TeamConfig) => { config = nextConfig; return true; })
      .mockImplementationOnce(async (nextConfig: TeamConfig) => { config = nextConfig; return true; })
      .mockImplementationOnce(async (nextConfig: TeamConfig) => { config = nextConfig; return true; })
      .mockImplementation(async () => {
        config = { ...config, workers: config.workers.filter(worker => worker.name !== 'worker-2'), worker_count: 1,
          lifecycle_state: 'shutting_down', state_revision: 8 };
        throw new Error('stale_state_revision');
      });
    tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('dead');

    const result = await scaleUp(
      'demo-team',
      1,
      'claude',
      [{ subject: 'demo', description: 'demo task' }],
      cwd,
      { OMC_TEAM_SCALING_ENABLED: '1', OMC_TEAM_SKIP_READY_WAIT: '1' } as NodeJS.ProcessEnv,
    );

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('config commit lost its revision');
    expect(tmuxUtilsMocks.tmuxExec).toHaveBeenCalledWith(['kill-pane', '-t', '%12'], { stdio: 'pipe' });
    expect(gitWorktreeMocks.removeWorkerWorktree).toHaveBeenCalledWith('demo-team', 'worker-2', resolve(cwd));
    expect(existsSync(absPath(cwd, TeamPaths.workerDir('demo-team', 'worker-2')))).toBe(false);
    expect(config.workers.map(worker => worker.name)).toEqual(['worker-1']);
    expect(config.lifecycle_state).toBe('shutting_down');
    expect(monitorMocks.saveTeamConfigAtRevision).toHaveBeenCalledTimes(5);
    expect(monitorMocks.saveTeamConfig).not.toHaveBeenCalled();
  });

  it('rolls back every spawned effect when worker identity publication fails', async () => {
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'named' });
    const worktreePath = join(cwd, '.omc', 'team', 'demo-team', 'worktrees', 'worker-2');
    gitWorktreeMocks.ensureWorkerWorktree.mockReturnValue({ path: worktreePath, branch: 'worker-2',
      detached: false, created: true });
    gitWorktreeMocks.installWorktreeRootAgents.mockReturnValue(undefined);
    teamOpsMocks.teamWriteWorkerIdentity.mockRejectedValue(new Error('identity write failed'));
    tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('dead');

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1', OMC_TEAM_SKIP_READY_WAIT: '1' } as NodeJS.ProcessEnv);

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('post-effect failed');
    expect(tmuxUtilsMocks.tmuxExec).toHaveBeenCalledWith(['kill-pane', '-t', '%12'], { stdio: 'pipe' });
    expect(gitWorktreeMocks.removeWorkerWorktree).toHaveBeenCalledWith('demo-team', 'worker-2', resolve(cwd));
    expect(config.workers.map(worker => worker.name)).toEqual(['worker-1']);
  });

  it('cleans the exact partial worktree and worker directory when worktree creation throws', async () => {
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'named' });
    const worktreePath = join(cwd, '.omc', 'team', 'demo-team', 'worktrees', 'worker-2');
    gitWorktreeMocks.ensureWorkerWorktree.mockImplementation(() => {
      rmSync(worktreePath, { recursive: true, force: true });
      mkdirSync(worktreePath, { recursive: true });
      throw new Error('metadata publication failed');
    });
    gitWorktreeMocks.removeWorkerWorktree.mockImplementation(() => rmSync(worktreePath, { recursive: true, force: true }));

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1', OMC_TEAM_SKIP_READY_WAIT: '1' } as NodeJS.ProcessEnv);

    expect(result).toMatchObject({ ok: false });
    expect(gitWorktreeMocks.removeWorkerWorktree).toHaveBeenCalledWith('demo-team', 'worker-2', resolve(cwd));
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(absPath(cwd, TeamPaths.workerDir('demo-team', 'worker-2')))).toBe(false);
  });

  it('records durable orphan evidence when split succeeds without an addressable pane id', async () => {
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'disabled' });
    tmuxUtilsMocks.tmuxSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'display-message') return { status: 0, stdout: 'demo-session:0\n', stderr: '' };
      if (args[0] === 'split-window') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1', OMC_TEAM_SKIP_READY_WAIT: '1' } as NodeJS.ProcessEnv);

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('rollback incomplete');
    expect(teamOpsMocks.writeAtomic).toHaveBeenCalledWith(expect.stringContaining('scaling-rollback'),
      expect.stringContaining('unaddressable_spawned_pane:<missing>'));
    expect(existsSync(absPath(cwd, TeamPaths.workerDir('demo-team', 'worker-2')))).toBe(false);
  });

  it('publishes durable orphan evidence when pane and worktree cleanup cannot be verified', async () => {
    config = makeConfig({ state_revision: 4, next_worker_index: 2, worktree_mode: 'named' });
    const worktreePath = join(cwd, '.omc', 'team', 'demo-team', 'worktrees', 'worker-2');
    await mkdir(worktreePath, { recursive: true });
    gitWorktreeMocks.ensureWorkerWorktree.mockReturnValue({ path: worktreePath, branch: 'worker-2',
      detached: false, created: true });
    gitWorktreeMocks.installWorktreeRootAgents.mockReturnValue(undefined);
    gitWorktreeMocks.removeWorkerWorktree.mockImplementation(() => { throw new Error('worktree busy'); });
    tmuxUtilsMocks.tmuxExec.mockImplementation(() => { throw new Error('pane still alive'); });
    tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('alive');
    monitorMocks.saveTeamConfigAtRevision
      .mockImplementationOnce(async (nextConfig: TeamConfig) => { config = nextConfig; return true; })
      .mockImplementationOnce(async (nextConfig: TeamConfig) => { config = nextConfig; return true; })
      .mockImplementationOnce(async (nextConfig: TeamConfig) => { config = nextConfig; return true; })
      .mockRejectedValue(new Error('stale_state_revision'));

    const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd,
      { OMC_TEAM_SCALING_ENABLED: '1', OMC_TEAM_SKIP_READY_WAIT: '1' } as NodeJS.ProcessEnv);

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('rollback incomplete');
    expect(teamOpsMocks.writeAtomic).toHaveBeenCalledWith(expect.stringContaining('scaling-rollback'),
      expect.stringContaining('cleanup_failures'));
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('revalidates the lifecycle reservation before scale-down effects when recovery appears during drain', async () => {
    config = makeConfig({
      state_revision: 4,
      worker_count: 2,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%1' },
        { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [], pane_id: '%2' },
      ],
    });
    let recoveryInjected = false;
    teamOpsMocks.teamReadWorkerStatus.mockImplementation(async () => {
      if (!recoveryInjected) {
        recoveryInjected = true;
        const revision = (config.state_revision ?? 0) + 1;
        const now = new Date().toISOString();
        config = { ...config, state_revision: revision, active_recovery: {
          request_id: 'request-race', recovery_id: 'recovery-race', worker_name: 'worker-2',
          owner_epoch: 2, owner_nonce: 'owner', phase: 'active', state_revision: revision,
          created_at: now, updated_at: now,
        } };
      }
      return { state: 'idle', updated_at: new Date().toISOString() };
    });

    const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-2'], drainTimeoutMs: 25 },
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, error: 'team_mutation_busy' });
    expect(tmuxSessionMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(config.active_recovery?.recovery_id).toBe('recovery-race');
    expect(config.active_scale_down).toMatchObject({ phase: 'failed', failure_reason: 'scale_down_fence_lost_before_effects' });
    expect(teamOpsMocks.writeAtomic).toHaveBeenCalledWith(expect.stringContaining('scaling-rollback'),
      expect.stringContaining('scale_down_fence_lost_before_effects'));
  });

  it('refuses scale-down without positive pane identity before destructive effects', async () => {
    config = makeConfig({
      state_revision: 4,
      worker_count: 2,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%1' },
        { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [] },
      ],
    });

    const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-2'], force: true },
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, error: 'scale_down_worker_liveness_unknown:missing_pane_id:worker-2' });
    expect(tmuxSessionMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(gitWorktreeMocks.removeWorkerWorktree).not.toHaveBeenCalled();
    expect(config.workers.map(worker => worker.name)).toEqual(['worker-1', 'worker-2']);
    expect(teamOpsMocks.writeAtomic).toHaveBeenCalledWith(expect.stringContaining('scaling-rollback'),
      expect.stringContaining('missing_pane_id:worker-2'));
  });

  it('publishes scale-down evidence even when durable failure marking throws after pane effects', async () => {
    config = makeConfig({
      state_revision: 4,
      worker_count: 2,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%1' },
        { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [], pane_id: '%2' },
      ],
    });
    tmuxSessionMocks.killWorkerPanes.mockRejectedValueOnce(new Error('kill failed after partial effect'));
    monitorMocks.readRevisionedTeamConfig
      .mockImplementationOnce(async () => ({ config, stateRevision: config.state_revision ?? 0 }))
      .mockRejectedValueOnce(new Error('config read unavailable'));

    const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-2'], force: true },
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, error: 'pane_cleanup_failed:kill failed after partial effect' });
    expect(teamOpsMocks.writeAtomic).toHaveBeenCalledWith(expect.stringContaining('scaling-rollback'),
      expect.stringMatching(/pane_cleanup_failed:kill failed after partial effect[\s\S]*config_mark_error[\s\S]*config read unavailable/));
  });

  it('never reclaims an incomplete active scale-down owner record', async () => {
    config = makeConfig({
      state_revision: 4,
      worker_count: 2,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%1' },
        { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [], pane_id: '%2' },
      ],
    });
    Object.assign(config, { active_scale_down: { operation_id: 'incomplete-owner', phase: 'draining',
      workers: [{ name: 'worker-2', pane_id: '%2' }], state_revision: 4,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString() } });

    const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-2'], force: true },
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, error: 'team_mutation_busy' });
    expect(tmuxSessionMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(gitWorktreeMocks.removeWorkerWorktree).not.toHaveBeenCalled();
    expect(config.workers.map(worker => worker.name)).toEqual(['worker-1', 'worker-2']);
  });

  it('never reclaims a cross-platform active scale-down owner record', async () => {
    config = makeConfig({
      state_revision: 4,
      worker_count: 2,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%1' },
        { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [], pane_id: '%2' },
      ],
      active_scale_down: {
        operation_id: 'cross-platform-owner', phase: 'draining', pid: 2_147_483_647,
        process_started_at: process.platform === 'linux' ? 'win32:123' : 'linux:123',
        workers: [{ name: 'worker-2', pane_id: '%2' }], state_revision: 4,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    });

    const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-2'], force: true },
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, error: 'team_mutation_busy' });
    expect(tmuxSessionMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(gitWorktreeMocks.removeWorkerWorktree).not.toHaveBeenCalled();
  });
});
