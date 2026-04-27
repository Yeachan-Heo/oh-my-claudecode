import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
  createTeamSession: vi.fn(),
  spawnWorkerInPane: vi.fn(),
  sendToWorker: vi.fn(),
  waitForPaneReady: vi.fn(),
  applyMainVerticalLayout: vi.fn(),
  tmuxExecAsync: vi.fn(),
  queueInboxInstruction: vi.fn(),
}));

const modelContractMocks = vi.hoisted(() => ({
  buildWorkerArgv: vi.fn((agentType?: string, config?: { resolvedBinaryPath?: string }) => [config?.resolvedBinaryPath ?? agentType ?? 'vibe']),
  resolveValidatedBinaryPath: vi.fn((agentType?: string) => {
    if (agentType === 'mistral') throw new Error("Resolved CLI binary 'vibe' to untrusted location: /tmp/vibe");
    return `/usr/bin/${agentType ?? 'claude'}`;
  }),
  getContract: vi.fn((agentType?: string) => ({ binary: agentType === 'mistral' ? 'vibe' : agentType ?? 'claude' })),
  getWorkerEnv: vi.fn(() => ({ OMC_TEAM_WORKER: 'vibe-preflight-team/worker-1' })),
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
  paneHasActiveTask: vi.fn(() => false),
  paneLooksReady: vi.fn(() => true),
  applyMainVerticalLayout: mocks.applyMainVerticalLayout,
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

describe('runtime-v2 vibe (mistral) preflight routing', () => {
  let cwd = '';

  beforeEach(() => {
    vi.resetModules();
    mocks.createTeamSession.mockResolvedValue({
      sessionName: 'vibe-preflight-session',
      leaderPaneId: '%1',
      workerPaneIds: [],
      sessionMode: 'split-pane',
    });
    mocks.spawnWorkerInPane.mockResolvedValue(undefined);
    mocks.waitForPaneReady.mockResolvedValue(true);
    mocks.applyMainVerticalLayout.mockResolvedValue(undefined);
    mocks.tmuxExecAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'split-window') {
        return { stdout: '%2\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    mocks.queueInboxInstruction.mockResolvedValue({ ok: true, reason: 'transport_direct', transport: 'transport_direct' });
  });

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it('keeps an explicitly routed mistral lane on mistral when strict preflight path probing false-negatives', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'vibe-preflight-repro-'));
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'vibe-preflight-team',
      workerCount: 1,
      agentTypes: ['mistral'],
      tasks: [{ subject: 'Review code', description: 'Review code', role: 'executor' }],
      cwd,
      pluginConfig: {
        team: { roleRouting: { executor: { provider: 'mistral' } } },
      } as any,
    });

    expect(runtime.config.workers[0]?.worker_cli).toBe('mistral');
    expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(
      'mistral',
      expect.objectContaining({
        teamName: 'vibe-preflight-team',
        workerName: 'worker-1',
      }),
    );
  });
});
