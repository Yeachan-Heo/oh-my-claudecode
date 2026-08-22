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
    withWorkerLaunchAttemptFence: vi.fn(async (_attempt, fn) => ({ ok: true, value: await fn() })),
}));
const modelContractMocks = vi.hoisted(() => ({
    buildWorkerArgv: vi.fn((agentType, config) => [config?.resolvedBinaryPath ?? agentType ?? 'claude']),
    resolveValidatedBinaryPath: vi.fn((agentType) => {
        if (agentType === 'gemini')
            throw new Error('Resolved CLI binary \'gemini\' to untrusted location: /tmp/gemini');
        return `/usr/bin/${agentType ?? 'claude'}`;
    }),
    clearResolvedPathCache: vi.fn(),
    getContract: vi.fn((agentType) => ({ binary: agentType ?? 'claude' })),
    getWorkerEnv: vi.fn(() => ({ OMC_TEAM_WORKER: 'issue2675-team/worker-1' })),
    isPromptModeAgent: vi.fn(() => false),
    getPromptModeArgs: vi.fn(() => []),
    resolveClaudeWorkerModel: vi.fn(() => undefined),
    buildValidatedWorkerLaunchDescriptor: vi.fn((agentType, config, appendedArgs = []) => {
        const [binary, ...args] = modelContractMocks.buildWorkerArgv(agentType, config);
        return { schema_version: 1, provider: agentType, model: config.model ?? null, binary, args: [...args, ...appendedArgs] };
    }),
    validateWorkerLaunchDescriptor: vi.fn((value) => value),
}));
vi.mock('../worker-launch-ack.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, withWorkerLaunchAttemptFence: launchMocks.withWorkerLaunchAttemptFence };
});
vi.mock('../../cli/tmux-utils.js', () => ({
    tmuxExecAsync: mocks.tmuxExecAsync,
}));
vi.mock('../tmux-session.js', async (importOriginal) => ({
    ...await importOriginal(),
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
    buildValidatedWorkerLaunchDescriptor: modelContractMocks.buildValidatedWorkerLaunchDescriptor,
    validateWorkerLaunchDescriptor: modelContractMocks.validateWorkerLaunchDescriptor,
    // gemini is supported on all platforms, so the preflight headless guard is a no-op here.
    assertHeadlessSupported: () => { },
    isHeadlessSupportedOnPlatform: () => true,
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
        mocks.spawnOwnedWorkerInPane.mockImplementation(async (sessionName, ownership, config) => {
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
        mocks.tmuxExecAsync.mockImplementation(async (args) => {
            if (args[0] === 'split-window') {
                return { stdout: '%2\n', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });
        mocks.queueInboxInstruction.mockResolvedValue({ ok: true, reason: 'transport_direct', transport: 'transport_direct' });
    });
    afterEach(async () => {
        if (cwd)
            await rm(cwd, { recursive: true, force: true });
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
            },
        })).rejects.toThrow(`cli_binary_preflight_failed:gemini:${reason}`);
        expect(mocks.createTeamSession).not.toHaveBeenCalled();
        expect(mocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
        expect(modelContractMocks.buildWorkerArgv).not.toHaveBeenCalled();
    });
    it('fails a routed-only provider before state or session side effects', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'routed-provider-preflight-'));
        modelContractMocks.resolveValidatedBinaryPath.mockImplementation((agentType) => {
            if (agentType === 'gemini')
                throw new Error("Resolved CLI binary 'gemini' to untrusted location: /tmp/shadow/gemini");
            return `/usr/bin/${agentType ?? 'claude'}`;
        });
        const { startTeamV2 } = await import('../runtime-v2.js');
        await expect(startTeamV2({
            teamName: 'routed-preflight-team',
            workerCount: 1,
            agentTypes: ['claude'],
            tasks: [{ subject: 'Review code', description: 'Review code', role: 'executor' }],
            cwd,
            pluginConfig: { team: { roleRouting: { executor: { provider: 'gemini' } } } },
        })).rejects.toThrow("cli_binary_preflight_failed:gemini:Resolved CLI binary 'gemini' to untrusted location");
        expect(mocks.createTeamSession).not.toHaveBeenCalled();
        expect(mocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
        await expect(import('node:fs/promises').then(fs => fs.access(join(cwd, '.omc', 'state', 'team', 'routed-preflight-team'))))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });
});
//# sourceMappingURL=runtime-v2.gemini-preflight.test.js.map