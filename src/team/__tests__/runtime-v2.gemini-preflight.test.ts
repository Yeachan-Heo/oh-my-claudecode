import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
  createTeamSession: vi.fn(),
  spawnWorkerInPane: vi.fn(),
  spawnOwnedWorkerInPane: vi.fn(),
  sendToWorker: vi.fn(),
  waitForPaneReady: vi.fn(),
  applyMainVerticalLayout: vi.fn(),
  tmuxExecAsync: vi.fn(),
  queueInboxInstruction: vi.fn(),
  workerPaneBelongsToProviderTarget: vi.fn(async () => true),
}));

const launchMocks = vi.hoisted(() => ({
  withWorkerLaunchAttemptFence: vi.fn(async (_attempt: unknown, fn: () => Promise<unknown>) => ({ ok: true as const, value: await fn() })),
}));

const overlayMocks = vi.hoisted(() => ({
  writeWorkerOverlay: vi.fn(async (params: { cwd: string; teamName: string; workerName: string }) =>
    join(params.cwd, '.omc', 'state', 'team', params.teamName, 'workers', params.workerName, 'AGENTS.md')),
}));

const modelContractMocks = vi.hoisted(() => ({
  buildWorkerArgv: vi.fn((agentType?: string, config?: { resolvedBinaryPath?: string }) => [config?.resolvedBinaryPath ?? agentType ?? 'claude']),
  resolveValidatedBinaryPath: vi.fn((agentType?: string) => {
    if (agentType === 'gemini') throw new Error('Resolved CLI binary \'gemini\' to untrusted location: /tmp/gemini');
    return `/usr/bin/${agentType ?? 'claude'}`;
  }),
  clearResolvedPathCache: vi.fn(),
  getContract: vi.fn((agentType?: string) => ({ binary: agentType ?? 'claude' })),
  getWorkerEnv: vi.fn(() => ({ OMC_TEAM_WORKER: 'issue2675-team/worker-1' })),
  isPromptModeAgent: vi.fn(() => false),
  getPromptModeArgs: vi.fn(() => []),
  resolveClaudeWorkerModel: vi.fn(() => undefined),
  normalizeExternalModelsDefaults: vi.fn((defaults: unknown) => defaults),
  resolveExternalModelsDefaults: vi.fn((defaults: unknown) => defaults),
  resolveDefaultWorkerModel: vi.fn(() => undefined),
  buildValidatedWorkerLaunchDescriptor: vi.fn((agentType: string, config: { model?: string; resolvedBinaryPath?: string }, appendedArgs: string[] = []) => {
    const [binary, ...args] = modelContractMocks.buildWorkerArgv(agentType, config);
    return { schema_version: 1, provider: agentType, model: config.model ?? null, binary, args: [...args, ...appendedArgs] };
  }),
  validateWorkerLaunchDescriptor: vi.fn((value: unknown) => value),
}));

vi.mock('../worker-launch-ack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worker-launch-ack.js')>();
  return { ...actual, withWorkerLaunchAttemptFence: launchMocks.withWorkerLaunchAttemptFence };
});

vi.mock('../worker-bootstrap.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../worker-bootstrap.js')>(),
  writeWorkerOverlay: overlayMocks.writeWorkerOverlay,
}));

vi.mock('../../cli/tmux-utils.js', () => ({
  tmuxExecAsync: mocks.tmuxExecAsync,
}));

vi.mock('../tmux-session.js', async importOriginal => ({
  ...await importOriginal<typeof import('../tmux-session.js')>(),
  createTeamSession: mocks.createTeamSession,
  spawnWorkerInPane: mocks.spawnWorkerInPane,
  spawnOwnedWorkerInPane: mocks.spawnOwnedWorkerInPane,
  sendToWorker: mocks.sendToWorker,
  waitForPaneReady: mocks.waitForPaneReady,
  paneHasActiveTask: vi.fn(() => false),
  paneLooksReady: vi.fn(() => true),
  applyMainVerticalLayout: mocks.applyMainVerticalLayout,
  workerPaneBelongsToProviderTarget: mocks.workerPaneBelongsToProviderTarget,
}));

vi.mock('../model-contract.js', () => ({
  buildWorkerArgv: modelContractMocks.buildWorkerArgv,
  resolveValidatedBinaryPath: modelContractMocks.resolveValidatedBinaryPath,
  clearResolvedPathCache: modelContractMocks.clearResolvedPathCache,
  getContract: modelContractMocks.getContract,
  getWorkerEnv: modelContractMocks.getWorkerEnv,
  isPromptModeAgent: modelContractMocks.isPromptModeAgent,
  getPromptModeArgs: modelContractMocks.getPromptModeArgs,
  resolveClaudeWorkerModel: modelContractMocks.resolveClaudeWorkerModel,
  normalizeExternalModelsDefaults: modelContractMocks.normalizeExternalModelsDefaults,
  resolveExternalModelsDefaults: modelContractMocks.resolveExternalModelsDefaults,
  resolveDefaultWorkerModel: modelContractMocks.resolveDefaultWorkerModel,
  buildValidatedWorkerLaunchDescriptor: modelContractMocks.buildValidatedWorkerLaunchDescriptor,
  validateWorkerLaunchDescriptor: modelContractMocks.validateWorkerLaunchDescriptor,
  // gemini is supported on all platforms, so the preflight headless guard is a no-op here.
  assertHeadlessSupported: () => {},
  isHeadlessSupportedOnPlatform: () => true,
}));

vi.mock('../mcp-comm.js', () => ({
  queueInboxInstruction: mocks.queueInboxInstruction,
}));

describe('runtime-v2 Gemini preflight routing', () => {
  let cwd = '';

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    modelContractMocks.resolveValidatedBinaryPath.mockImplementation((agentType?: string) => {
      if (agentType === 'gemini') throw new Error('Resolved CLI binary \'gemini\' to untrusted location: /tmp/gemini');
      return `/usr/bin/${agentType ?? 'claude'}`;
    });
    overlayMocks.writeWorkerOverlay.mockClear();
    mocks.createTeamSession.mockResolvedValue({
      sessionName: 'issue2675-session',
      leaderPaneId: '%1',
      workerPaneIds: [],
      sessionMode: 'split-pane',
    });
    mocks.spawnWorkerInPane.mockResolvedValue(undefined);
    mocks.spawnOwnedWorkerInPane.mockImplementation(async (sessionName: string, ownership: { paneId: string }, config: { teamName: string; workerName: string; provider: string }) => {
      await mocks.spawnWorkerInPane(sessionName, ownership.paneId, config);
      return {
        ownership,
        provider: config.provider,
        attempt: {
          attempt_id: '11111111-1111-4111-8111-111111111111',
          team_name: config.teamName,
          worker_name: config.workerName,
          pane_id: ownership.paneId,
        },
      };
    });
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

  it.each([
    ["untrusted absolute", "Resolved CLI binary 'gemini' to untrusted location: /tmp/shadow/gemini"],
    ["relative", "Resolved CLI binary 'gemini' to relative path: ./gemini"],
    ["missing", "CLI binary not found: gemini"],
  ])('fails before launch for a %s provider path', async (_case, reason) => {
    cwd = await mkdtemp(join(tmpdir(), 'issue2675-repro-'));
    modelContractMocks.resolveValidatedBinaryPath.mockImplementationOnce(() => { throw new Error(reason); });
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'issue2675-team',
      workerCount: 1,
      agentTypes: ['gemini'],
      tasks: [{ subject: 'Review code', description: 'Review code', role: 'executor' }],
      cwd,
      pluginConfig: {
        team: { roleRouting: { executor: { provider: 'gemini' } } },
      } as any,
    })).rejects.toThrow(`cli_binary_preflight_failed:gemini:${reason}`);

    expect(mocks.createTeamSession).not.toHaveBeenCalled();
    expect(mocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
    expect(modelContractMocks.buildWorkerArgv).not.toHaveBeenCalled();
  });
  it('fails a routed-only missing provider before state or session side effects', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'routed-provider-preflight-'));
    modelContractMocks.resolveValidatedBinaryPath.mockImplementation((agentType?: string) => {
      if (agentType === 'gemini') throw new Error("CLI binary 'gemini' not found in PATH");
      return `/usr/bin/${agentType ?? 'claude'}`;
    });
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'routed-preflight-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Review code', description: 'Review code', role: 'executor' }],
      cwd,
      pluginConfig: { team: { roleRouting: { executor: { provider: 'gemini' } } } } as any,
    })).rejects.toThrow("cli_binary_preflight_failed:gemini:CLI binary 'gemini' not found in PATH");
    expect(mocks.createTeamSession).not.toHaveBeenCalled();
    expect(mocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
    await expect(import('node:fs/promises').then(fs => fs.access(join(cwd, '.omc', 'state', 'team', 'routed-preflight-team'))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['gemini', 'codex'],
    ['claude', 'gemini'],
  ] as const)(
    'does not preflight an unavailable %s route when %s was explicitly selected',
    async (routeProvider, explicitProvider) => {
      cwd = await mkdtemp(join(tmpdir(), 'explicit-provider-preflight-'));
      modelContractMocks.resolveValidatedBinaryPath.mockClear();
      mocks.createTeamSession.mockClear();
      modelContractMocks.resolveValidatedBinaryPath.mockImplementation((agentType?: string) => {
        if (agentType === routeProvider) throw new Error(`CLI binary '${routeProvider}' not found in PATH`);
        return `/usr/bin/${agentType ?? 'claude'}`;
      });
      const { startTeamV2 } = await import('../runtime-v2.js');

      const startupError = await startTeamV2({
        teamName: 'explicit-provider-team',
        workerCount: 1,
        agentTypes: [explicitProvider],
        workerProviderExplicit: [true],
        tasks: [{ subject: 'Review code', description: 'Review code', role: 'executor' }],
        cwd,
        pluginConfig: {
          team: { roleRouting: { executor: { provider: routeProvider } } },
        } as any,
      }).then(() => null, error => error as Error);
      if (startupError) expect(startupError.message).toBe('stale_state_revision');

      expect(modelContractMocks.resolveValidatedBinaryPath).toHaveBeenCalledWith(explicitProvider);
      expect(modelContractMocks.resolveValidatedBinaryPath).not.toHaveBeenCalledWith(routeProvider);
      expect(mocks.createTeamSession).toHaveBeenCalled();
      expect(overlayMocks.writeWorkerOverlay).toHaveBeenCalledWith(
        expect.objectContaining({ agentType: explicitProvider }),
      );
    },
  );

  it('validates the complete launch descriptor before filesystem or session effects', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'descriptor-preparation-'));
    modelContractMocks.buildValidatedWorkerLaunchDescriptor.mockImplementationOnce(() => {
      throw new Error('invalid prepared descriptor');
    });
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'descriptor-preparation-team',
      workerCount: 1,
      agentTypes: ['claude'],
      workerProviderExplicit: [true],
      tasks: [{ subject: 'Run task', description: 'Run task' }],
      cwd,
    })).rejects.toThrow('invalid prepared descriptor');

    expect(mocks.createTeamSession).not.toHaveBeenCalled();
    await expect(import('node:fs/promises').then(fs => fs.access(
      join(cwd, '.omc', 'state', 'team', 'descriptor-preparation-team'),
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

});
