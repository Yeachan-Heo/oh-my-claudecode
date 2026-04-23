import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import type { CliAgentType } from '../model-contract.js';

const tmuxUtilsMocks = vi.hoisted(() => ({
  tmuxExec: vi.fn(),
  tmuxSpawn: vi.fn(),
}));

const modelContractMocks = vi.hoisted(() => ({
  buildWorkerArgv: vi.fn(),
  getWorkerEnv: vi.fn(),
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
  isWorkerAlive: vi.fn(),
  killWorkerPanes: vi.fn(),
  buildWorkerStartCommand: vi.fn(() => 'start-worker'),
  waitForPaneReady: vi.fn(),
  waitForPaneReadyStatus: vi.fn(),
}));

vi.mock('../../cli/tmux-utils.js', () => ({
  tmuxExec: tmuxUtilsMocks.tmuxExec,
  tmuxSpawn: tmuxUtilsMocks.tmuxSpawn,
}));

vi.mock('../model-contract.js', () => ({
  buildWorkerArgv: modelContractMocks.buildWorkerArgv,
  getWorkerEnv: modelContractMocks.getWorkerEnv,
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
  isWorkerAlive: tmuxSessionMocks.isWorkerAlive,
  killWorkerPanes: tmuxSessionMocks.killWorkerPanes,
  buildWorkerStartCommand: tmuxSessionMocks.buildWorkerStartCommand,
  waitForPaneReady: tmuxSessionMocks.waitForPaneReady,
  waitForPaneReadyStatus: tmuxSessionMocks.waitForPaneReadyStatus,
}));

import { scaleUp } from '../scaling.js';

describe('scaleUp launch config', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-scaling-launch-config-'));

    vi.clearAllMocks();

    monitorMocks.withScalingLock.mockImplementation(async (
      _teamName: string,
      _leaderCwd: string,
      fn: () => Promise<unknown>,
    ) => fn());
    teamOpsMocks.teamReadConfig.mockResolvedValue({
      name: 'demo-team',
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: 'demo-session:0',
      next_task_id: 2,
      next_worker_index: 1,
      leader_pane_id: '%0',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      team_state_root: `${resolve(cwd)}/.omc/state`,
    });
    modelContractMocks.getWorkerEnv.mockImplementation((teamName: string, workerName: string, agentType: string) => ({
      OMC_TEAM_WORKER: `${teamName}/${workerName}`,
      OMC_TEAM_NAME: teamName,
      OMC_WORKER_AGENT_TYPE: agentType,
    }));
    tmuxUtilsMocks.tmuxSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'split-window') {
        return { status: 0, stdout: '%12\n', stderr: '' };
      }
      if (args[0] === 'display-message') {
        return { status: 0, stdout: '4321\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    tmuxSessionMocks.waitForPaneReady.mockResolvedValue(undefined);
    tmuxSessionMocks.waitForPaneReadyStatus.mockResolvedValue({ ready: true });
  });

  afterEach(async () => {
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ['codex', ['/usr/bin/codex', '--dangerously-bypass-approvals-and-sandbox']],
    ['gemini', ['/usr/bin/gemini', '--approval-mode', 'yolo']],
    ['copilot', ['/usr/bin/copilot', '--allow-all', '--no-ask-user']],
  ] as const)('uses model-contract launch argv for %s scale-up workers', async (
    agentType: CliAgentType,
    workerArgv: readonly string[],
  ) => {
    modelContractMocks.buildWorkerArgv.mockReturnValue(workerArgv);

    const result = await scaleUp(
      'demo-team',
      1,
      agentType,
      [{ subject: 'demo', description: 'demo task' }],
      cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv,
    );

    expect(result).toMatchObject({ ok: true, newWorkerCount: 1, nextWorkerIndex: 2 });
    expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(agentType, {
      teamName: 'demo-team',
      workerName: 'worker-1',
      cwd: resolve(cwd),
    });
    expect(tmuxSessionMocks.buildWorkerStartCommand).toHaveBeenCalledWith(expect.objectContaining({
      teamName: 'demo-team',
      workerName: 'worker-1',
      launchBinary: workerArgv[0],
      launchArgs: workerArgv.slice(1),
      cwd: resolve(cwd),
      envVars: expect.objectContaining({
        OMC_TEAM_WORKER: 'demo-team/worker-1',
        OMC_TEAM_NAME: 'demo-team',
        OMC_WORKER_AGENT_TYPE: agentType,
        OMC_TEAM_STATE_ROOT: `${resolve(cwd)}/.omc/state`,
        OMC_TEAM_LEADER_CWD: resolve(cwd),
      }),
    }));
    expect(teamOpsMocks.teamWriteWorkerIdentity).toHaveBeenCalledWith(
      'demo-team',
      'worker-1',
      expect.objectContaining({ worker_cli: agentType }),
      resolve(cwd),
    );
    expect(monitorMocks.saveTeamConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        workers: [expect.objectContaining({ worker_cli: agentType })],
      }),
      resolve(cwd),
    );
  });
});
