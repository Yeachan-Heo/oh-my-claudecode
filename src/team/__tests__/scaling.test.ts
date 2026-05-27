import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
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

import { scaleUp } from '../scaling.js';
import type { TeamConfig } from '../types.js';

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

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-scaling-duplicate-'));
    vi.clearAllMocks();

    monitorMocks.withScalingLock.mockImplementation(async (
      _teamName: string,
      _leaderCwd: string,
      fn: () => Promise<unknown>,
    ) => fn());
    monitorMocks.saveTeamConfig.mockImplementation(async (nextConfig: TeamConfig) => {
      config = nextConfig;
    });

    teamOpsMocks.teamReadConfig.mockImplementation(async () => config);
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
});
