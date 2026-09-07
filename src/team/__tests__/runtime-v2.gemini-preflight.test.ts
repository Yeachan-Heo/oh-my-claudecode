import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ABSOLUTE_MAX_WORKERS } from '../types.js';

const mocks = vi.hoisted(() => ({
  createTeamSession: vi.fn(),
  spawnWorkerInPane: vi.fn(),
  spawnOwnedWorkerInPane: vi.fn(),
  deliverStartupInbox: vi.fn(),
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

vi.mock('../../cli/tmux-utils.js', () => ({
  tmuxExecAsync: mocks.tmuxExecAsync,
}));

vi.mock('../tmux-session.js', async importOriginal => ({
  ...await importOriginal<typeof import('../tmux-session.js')>(),
  createTeamSession: mocks.createTeamSession,
  spawnWorkerInPane: mocks.spawnWorkerInPane,
  spawnOwnedWorkerInPane: mocks.spawnOwnedWorkerInPane,
  deliverStartupInbox: mocks.deliverStartupInbox,
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
  let home = '';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'provider-preflight-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('OMC_STATE_DIR', undefined);
    vi.resetModules();
    mocks.createTeamSession.mockClear();
    mocks.spawnWorkerInPane.mockClear();
    mocks.spawnOwnedWorkerInPane.mockClear();
    mocks.waitForPaneReady.mockClear();
    mocks.applyMainVerticalLayout.mockClear();
    mocks.tmuxExecAsync.mockClear();
    mocks.queueInboxInstruction.mockClear();
    modelContractMocks.buildWorkerArgv.mockClear();
    modelContractMocks.resolveValidatedBinaryPath.mockClear().mockImplementation((agentType?: string) => {
      if (agentType === 'gemini') throw new Error('Resolved CLI binary \'gemini\' to untrusted location: /tmp/gemini');
      return `/usr/bin/${agentType ?? 'claude'}`;
    });
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
    mocks.deliverStartupInbox.mockImplementation(async (context: {
      attempt: { attempt_id: string; team_name: string; worker_name: string };
    }) => {
      const workerDir = join(cwd, '.omc', 'state', 'team', context.attempt.team_name, 'workers', context.attempt.worker_name);
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(workerDir, 'status.json'), JSON.stringify({
        state: 'working',
        current_task_id: '1',
        updated_at: new Date().toISOString(),
        launch_attempt_id: context.attempt.attempt_id,
      }));
      return { ok: true, kind: 'attempted_unconfirmed' };
    });
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
    vi.unstubAllEnvs();
    if (cwd) await rm(cwd, { recursive: true, force: true });
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('rejects an invalid worker count before provider preflight or state creation', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'invalid-worker-count-'));
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'invalid-worker-count-team',
      workerCount: 0,
      agentTypes: ['gemini'],
      tasks: [],
      cwd,
      pluginConfig: {},
    })).rejects.toThrow(`Invalid worker count "0". Expected 1-${ABSOLUTE_MAX_WORKERS}.`);

    expect(modelContractMocks.resolveValidatedBinaryPath).not.toHaveBeenCalled();
    expect(mocks.createTeamSession).not.toHaveBeenCalled();
    await expect(import('node:fs/promises').then(fs => fs.access(join(cwd, '.omc', 'state', 'team', 'invalid-worker-count-team'))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('starts a gemini-only team without unused claude (has task: %s)', async (hasTask) => {
    cwd = await mkdtemp(join(tmpdir(), 'unused-default-claude-'));
    modelContractMocks.resolveValidatedBinaryPath.mockImplementation((agentType?: string) => {
      if (agentType === 'claude') throw new Error('CLI binary not found: claude');
      return `/usr/bin/${agentType ?? 'claude'}`;
    });
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'gemini-only-team',
      workerCount: 1,
      agentTypes: ['gemini'],
      tasks: hasTask ? [{ subject: 'Implement feature', description: 'Implement feature', role: 'executor' }] : [],
      cwd,
      pluginConfig: {},
    })).resolves.toBeDefined();

    expect(modelContractMocks.resolveValidatedBinaryPath).toHaveBeenCalledWith('gemini');
    expect(modelContractMocks.resolveValidatedBinaryPath).not.toHaveBeenCalledWith('claude');
    expect(mocks.createTeamSession).toHaveBeenCalled();
    if (hasTask) {
      expect(mocks.spawnOwnedWorkerInPane.mock.calls[0]?.[2]).toMatchObject({ provider: 'gemini' });
    }
  });

  it('does not preflight an unused configured external provider', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'unused-configured-provider-'));
    modelContractMocks.resolveValidatedBinaryPath.mockImplementation((agentType?: string) => {
      if (agentType === 'gemini') throw new Error('CLI binary not found: gemini');
      return `/usr/bin/${agentType ?? 'claude'}`;
    });
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'codex-only-team',
      workerCount: 1,
      agentTypes: ['codex'],
      tasks: [{ subject: 'Implement feature', description: 'Implement feature', role: 'executor' }],
      cwd,
      pluginConfig: {
        team: { roleRouting: { writer: { provider: 'gemini' } } },
      } as any,
    })).resolves.toBeDefined();

    expect(modelContractMocks.resolveValidatedBinaryPath).toHaveBeenCalledWith('codex');
    expect(modelContractMocks.resolveValidatedBinaryPath).not.toHaveBeenCalledWith('gemini');
    expect(mocks.createTeamSession).toHaveBeenCalled();
  });

  it('uses the first explicit-owner task for startup before later unowned work', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'owner-before-unowned-preflight-'));
    modelContractMocks.resolveValidatedBinaryPath.mockImplementation((agentType?: string) => {
      if (agentType === 'gemini') throw new Error('CLI binary not found: gemini');
      if (agentType === 'codex') return '/usr/bin/codex';
      throw new Error(`CLI binary not found: ${agentType}`);
    });
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'owner-before-unowned-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [
        {
          subject: 'Implement feature',
          description: 'Implement the requested feature',
          owner: 'worker-1',
          role: 'executor',
        },
        {
          subject: 'Review feature',
          description: 'Review the implementation',
          role: 'code-reviewer',
        },
      ],
      cwd,
      pluginConfig: {
        team: {
          roleRouting: {
            executor: { provider: 'codex' },
            'code-reviewer': { provider: 'gemini' },
          },
        },
      } as any,
    });

    expect(modelContractMocks.resolveValidatedBinaryPath).toHaveBeenCalledExactlyOnceWith('codex');
    expect(modelContractMocks.resolveValidatedBinaryPath).not.toHaveBeenCalledWith('gemini');
    expect(mocks.spawnOwnedWorkerInPane.mock.calls[0]?.[2]).toMatchObject({ provider: 'codex' });
    expect(runtime.config.workers[0]).toMatchObject({
      worker_cli: 'codex',
      assigned_tasks: ['1'],
    });
  });

  it('does not require a declared provider replaced by an explicit role route', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'overridden-provider-'));
    modelContractMocks.resolveValidatedBinaryPath.mockImplementation((agentType?: string) => {
      if (agentType !== 'codex') throw new Error(`CLI binary not found: ${agentType}`);
      return '/usr/bin/codex';
    });
    const { startTeamV2 } = await import('../runtime-v2.js');
    await expect(startTeamV2({
      teamName: 'role-override-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Implement feature', description: 'Implement feature', role: 'executor' }],
      cwd,
      pluginConfig: { team: { roleRouting: { executor: { provider: 'codex' } } } },
    })).resolves.toBeDefined();
    expect(modelContractMocks.resolveValidatedBinaryPath).toHaveBeenCalledExactlyOnceWith('codex');
    expect(mocks.spawnOwnedWorkerInPane.mock.calls[0]?.[2]).toMatchObject({ provider: 'codex' });
  });

  it.each([
    ["untrusted absolute", "Resolved CLI binary 'gemini' to untrusted location: /tmp/gemini"],
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
    await expect(import('node:fs/promises').then(fs => fs.access(join(cwd, '.omc', 'state', 'team', 'issue2675-team'))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('fails a routed-only provider before state or session side effects', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'routed-provider-preflight-'));
    modelContractMocks.resolveValidatedBinaryPath.mockImplementation((agentType?: string) => {
      if (agentType === 'gemini') throw new Error("Resolved CLI binary 'gemini' to untrusted location: /tmp/shadow/gemini");
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
    })).rejects.toThrow("cli_binary_preflight_failed:gemini:Resolved CLI binary 'gemini' to untrusted location");
    expect(mocks.createTeamSession).not.toHaveBeenCalled();
    expect(mocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
    await expect(import('node:fs/promises').then(fs => fs.access(join(cwd, '.omc', 'state', 'team', 'routed-preflight-team'))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

});
