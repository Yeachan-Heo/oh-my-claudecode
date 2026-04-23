import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
  createTeamSession: vi.fn(),
  spawnWorkerInPane: vi.fn(),
  sendToWorker: vi.fn(),
  waitForPaneReady: vi.fn(),
  waitForPaneReadyStatus: vi.fn(),
  applyMainVerticalLayout: vi.fn(),
  tmuxExecAsync: vi.fn(),
  queueInboxInstruction: vi.fn(),
  detectInteractiveStartupBlocker: vi.fn(() => null),
  paneHasTrustPrompt: vi.fn(() => false),
}));

const modelContractMocks = vi.hoisted(() => ({
  buildWorkerArgv: vi.fn((agentType?: string, config?: { resolvedBinaryPath?: string }) => [config?.resolvedBinaryPath ?? agentType ?? 'claude']),
  resolveValidatedBinaryPath: vi.fn((agentType?: string) => {
    if (agentType === 'gemini') throw new Error('Resolved CLI binary \'gemini\' to untrusted location: /tmp/gemini');
    return `/usr/bin/${agentType ?? 'claude'}`;
  }),
  getContract: vi.fn((agentType?: string) => ({ binary: agentType ?? 'claude' })),
  getWorkerEnv: vi.fn(() => ({ OMC_TEAM_WORKER: 'issue2675-team/worker-1' })),
  isPromptModeAgent: vi.fn(() => false),
  getPromptModeArgs: vi.fn(() => []),
  resolveClaudeWorkerModel: vi.fn(() => undefined),
}));

vi.mock('../../cli/tmux-utils.js', () => ({
  tmuxExecAsync: mocks.tmuxExecAsync,
}));

vi.mock('../tmux-session.js', () => ({
  createTeamSession: mocks.createTeamSession,
  spawnWorkerInPane: mocks.spawnWorkerInPane,
  sendToWorker: mocks.sendToWorker,
  waitForPaneReady: mocks.waitForPaneReady,
  waitForPaneReadyStatus: mocks.waitForPaneReadyStatus,
  paneHasActiveTask: vi.fn(() => false),
  paneLooksReady: vi.fn(() => true),
  applyMainVerticalLayout: mocks.applyMainVerticalLayout,
  detectInteractiveStartupBlocker: mocks.detectInteractiveStartupBlocker,
  paneHasTrustPrompt: mocks.paneHasTrustPrompt,
}));

vi.mock('../model-contract.js', () => ({
  buildWorkerArgv: modelContractMocks.buildWorkerArgv,
  resolveValidatedBinaryPath: modelContractMocks.resolveValidatedBinaryPath,
  getContract: modelContractMocks.getContract,
  getWorkerEnv: modelContractMocks.getWorkerEnv,
  isPromptModeAgent: modelContractMocks.isPromptModeAgent,
  getPromptModeArgs: modelContractMocks.getPromptModeArgs,
  resolveClaudeWorkerModel: modelContractMocks.resolveClaudeWorkerModel,
}));

vi.mock('../mcp-comm.js', () => ({
  queueInboxInstruction: mocks.queueInboxInstruction,
}));

describe('runtime-v2 Gemini preflight routing', () => {
  let cwd = '';

  beforeEach(() => {
    vi.resetModules();
    mocks.createTeamSession.mockResolvedValue({
      sessionName: 'issue2675-session',
      leaderPaneId: '%1',
      workerPaneIds: [],
      sessionMode: 'split-pane',
    });
    mocks.spawnWorkerInPane.mockResolvedValue(undefined);
    mocks.waitForPaneReady.mockResolvedValue(true);
    mocks.waitForPaneReadyStatus.mockResolvedValue({ ready: true });
    mocks.applyMainVerticalLayout.mockResolvedValue(undefined);
    mocks.tmuxExecAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'split-window') {
        return { stdout: '%2\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    mocks.queueInboxInstruction.mockResolvedValue({ ok: true, reason: 'transport_direct', transport: 'transport_direct' });
    mocks.detectInteractiveStartupBlocker.mockReturnValue(null);
    mocks.paneHasTrustPrompt.mockReturnValue(false);
  });

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it('keeps an explicitly routed gemini lane on gemini when strict preflight path probing false-negatives', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'issue2675-repro-'));
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'issue2675-team',
      workerCount: 1,
      agentTypes: ['gemini'],
      tasks: [{ subject: 'Review code', description: 'Review code', role: 'executor' }],
      cwd,
      pluginConfig: {
        team: { roleRouting: { executor: { provider: 'gemini' } } },
      } as any,
    });

    expect(runtime.config.workers[0]?.worker_cli).toBe('gemini');
    expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(
      'gemini',
      expect.objectContaining({
        teamName: 'issue2675-team',
        workerName: 'worker-1',
        resolvedBinaryPath: 'gemini',
      }),
    );
  });

  it('keeps a requested copilot lane on copilot when preflight downgrades to launch-time resolution', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'issue2675-copilot-preflight-'));
    modelContractMocks.resolveValidatedBinaryPath.mockImplementation((agentType?: string) => {
      if (agentType === 'copilot') {
        throw new Error('Resolved CLI binary \'copilot\' to untrusted location: /tmp/copilot');
      }
      return `/usr/bin/${agentType ?? 'claude'}`;
    });
    modelContractMocks.getContract.mockImplementation((agentType?: string) => ({ binary: agentType ?? 'claude' }));
    mocks.queueInboxInstruction.mockImplementation(async () => {
      const taskDir = join(cwd, '.omc', 'state', 'team', 'issue2675-team', 'tasks');
      const taskPath = join(taskDir, 'task-1.json');
      const existing = JSON.parse(await (await import('fs/promises')).readFile(taskPath, 'utf-8'));
      await (await import('fs/promises')).writeFile(taskPath, JSON.stringify({
        ...existing,
        status: 'in_progress',
        owner: 'worker-1',
      }, null, 2), 'utf-8');
      return { ok: true, reason: 'transport_direct', transport: 'transport_direct' } as const;
    });

    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'issue2675-team',
      workerCount: 1,
      agentTypes: ['copilot'],
      tasks: [{ subject: 'Implement task', description: 'Verify copilot preflight fallback' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.worker_cli).toBe('copilot');
    expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(
      'copilot',
      expect.objectContaining({
        teamName: 'issue2675-team',
        workerName: 'worker-1',
        resolvedBinaryPath: 'copilot',
      }),
    );
  });
});
