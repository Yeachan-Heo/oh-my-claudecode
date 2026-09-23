import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { absPath, teamStateRoot, TeamPaths } from '../state-paths.js';
import { activateTeamInstanceUnderLock, createTeamInstanceBinding, reserveTeamInstanceUnderLock, withTeamInstanceLifecycleLock, } from '../team-instance.js';
const TEAM_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
async function activateFixtureInstance(teamName, cwd, instanceId = TEAM_INSTANCE_ID) {
    const binding = createTeamInstanceBinding({ teamName, cwd, instanceId });
    await withTeamInstanceLifecycleLock(binding.cwd, binding.team_name, async () => {
        await reserveTeamInstanceUnderLock({ teamName, cwd, instanceId });
        await mkdir(binding.state_root, { recursive: true });
        await writeFile(absPath(binding.cwd, TeamPaths.config(teamName)), JSON.stringify({
            name: teamName,
            instance_id: instanceId,
            tmux_session: 'demo-session:0',
            tmux_server_identity: tmuxSessionMocks.tmuxServerIdentity,
            leader_cwd: binding.cwd,
            team_state_root: binding.state_root,
        }));
        await activateTeamInstanceUnderLock(binding);
    });
}
const modelContractMocks = vi.hoisted(() => ({
    buildWorkerArgv: vi.fn(),
    getWorkerEnv: vi.fn(),
    resolveDefaultWorkerModel: vi.fn(),
    validateWorkerLaunchDescriptor: vi.fn((value) => value),
    clearResolvedPathCache: vi.fn(),
    resolveValidatedBinaryPath: vi.fn((agentType) => `/usr/bin/${agentType}`),
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
    currentConfig: null,
}));
const tmuxSessionMocks = vi.hoisted(() => {
    const tmuxServerIdentity = {
        socket_path: '/tmp/omc-test-tmux.sock',
        server_pid: 4242,
        process_started_at: process.platform === 'darwin'
            ? 'darwin:1700000000:123456'
            : 'linux:01234567-89ab-cdef-0123-456789abcdef:424242',
    };
    const getWorkerLiveness = vi.fn(async (_paneId) => 'dead');
    return {
        tmuxServerIdentity,
        sanitizeName: vi.fn((name) => name),
        isWorkerAlive: vi.fn(),
        getWorkerLiveness,
        getOwnedWorkerLiveness: vi.fn(async (ownership) => {
            if (ownership.provider === 'tmux' && !ownership.tmuxServerIdentity)
                return 'unknown';
            return getWorkerLiveness(ownership.paneId);
        }),
        killWorkerPanes: vi.fn(),
        workerPaneBelongsToOwnedProviderTarget: vi.fn(async (input) => input.provider !== 'tmux' || Boolean(input.tmuxServerIdentity)),
        splitTeamWorkerPaneWithEvidence: vi.fn(async (splitTarget, direction, _cwd, provider, identity) => ({
            commandSucceeded: true,
            provider,
            splitTarget,
            direction,
            rawOutput: provider === 'tmux' ? '%12\n' : 'cmux-worker-1\n',
            stderr: '',
            paneId: provider === 'tmux' ? '%12' : 'cmux-worker-1',
            ...(provider === 'tmux' ? { tmuxServerIdentity: identity ?? tmuxServerIdentity } : {}),
        })),
        adoptWorkerPaneOwnership: vi.fn(async (input) => ({
            ok: true,
            ownership: {
                provider: input.provider ?? 'tmux',
                providerTarget: input.providerTarget,
                paneId: input.paneId,
                splitTarget: '',
                leaderPaneId: input.leaderPaneId,
                reservedPaneIds: [],
                source: 'adopted',
                ...(input.provider !== 'cmux'
                    ? { tmuxServerIdentity: input.tmuxServerIdentity ?? tmuxServerIdentity }
                    : {}),
            },
        })),
        spawnOwnedWorkerInPane: vi.fn(async (_session, ownership, cfg) => ({
            ownership,
            provider: cfg.provider,
            attempt: { attempt_id: `attempt-${ownership.paneId}`, instance_id: cfg.instanceId, currentPath: '/tmp/current', decisionPath: '/tmp/decision', startedPath: '/tmp/started' },
        })),
        killOwnedWorkerPane: vi.fn(),
        waitForPaneReady: vi.fn(),
    };
});
const gitWorktreeMocks = vi.hoisted(() => ({
    ensureWorkerWorktree: vi.fn(),
    installWorktreeRootAgents: vi.fn(),
    removeWorkerWorktree: vi.fn(),
    restoreWorktreeRootAgents: vi.fn(),
    checkWorkerWorktreeRemovalSafety: vi.fn(),
    prepareWorkerWorktreeForRemoval: vi.fn(),
}));
const workerLaunchMocks = vi.hoisted(() => ({
    loadWorkerLaunchAttempt: vi.fn(async () => ({ attempt_id: 'attempt-loaded', currentPath: '/tmp/current', decisionPath: '/tmp/decision', startedPath: '/tmp/started' })),
    isWorkerLaunchAttemptAccepted: vi.fn(async () => true),
    retireWorkerLaunchAttempt: vi.fn(async () => true),
    terminateWorkerLaunchProvider: vi.fn(async () => true),
    retireAndCleanupCurrentWorkerLaunchAttempt: vi.fn(async (_attempt, _reason, cleanup) => cleanup()),
}));
vi.mock('../model-contract.js', () => ({
    buildWorkerArgv: modelContractMocks.buildWorkerArgv,
    clearResolvedPathCache: modelContractMocks.clearResolvedPathCache,
    resolveValidatedBinaryPath: modelContractMocks.resolveValidatedBinaryPath,
    getWorkerEnv: modelContractMocks.getWorkerEnv,
    resolveDefaultWorkerModel: modelContractMocks.resolveDefaultWorkerModel,
    validateWorkerLaunchDescriptor: modelContractMocks.validateWorkerLaunchDescriptor,
    assertHeadlessSupported: () => { },
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
    isWorkerAlive: tmuxSessionMocks.isWorkerAlive,
    getWorkerLiveness: tmuxSessionMocks.getWorkerLiveness,
    getOwnedWorkerLiveness: tmuxSessionMocks.getOwnedWorkerLiveness,
    killWorkerPanes: tmuxSessionMocks.killWorkerPanes,
    workerPaneBelongsToOwnedProviderTarget: tmuxSessionMocks.workerPaneBelongsToOwnedProviderTarget,
    splitTeamWorkerPaneWithEvidence: tmuxSessionMocks.splitTeamWorkerPaneWithEvidence,
    adoptWorkerPaneOwnership: tmuxSessionMocks.adoptWorkerPaneOwnership,
    spawnOwnedWorkerInPane: tmuxSessionMocks.spawnOwnedWorkerInPane,
    killOwnedWorkerPane: tmuxSessionMocks.killOwnedWorkerPane,
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
vi.mock('../runtime-owner-client.js', () => ({ resolveRuntimeCliPath: () => '/runtime-cli.js' }));
vi.mock('../worker-launch-ack.js', () => workerLaunchMocks);
import { scaleDown, scaleUp } from '../scaling.js';
describe('scaleUp launch config', () => {
    let cwd;
    let config;
    let previousStateDir;
    const launchMetadata = {
        worker_cli: 'codex',
        launch_attempt_id: 'attempt-1',
        launch_descriptor: { schema_version: 1, provider: 'codex', model: null,
            binary: '/usr/bin/codex', args: [] },
    };
    function makeConfig(overrides = {}) {
        const base = {
            name: 'demo-team',
            instance_id: TEAM_INSTANCE_ID,
            tmux_server_identity: tmuxSessionMocks.tmuxServerIdentity,
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
            team_state_root: teamStateRoot(cwd, 'demo-team'),
        };
        return { ...base, ...overrides };
    }
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-scaling-launch-config-'));
        previousStateDir = process.env.OMC_STATE_DIR;
        process.env.OMC_STATE_DIR = join(await realpath(cwd), '.omc-state');
        vi.clearAllMocks();
        workerLaunchMocks.retireAndCleanupCurrentWorkerLaunchAttempt.mockImplementation(async (_attempt, _reason, cleanup) => cleanup());
        monitorMocks.currentConfig = null;
        tmuxSessionMocks.getWorkerLiveness.mockReset();
        tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('dead');
        tmuxSessionMocks.getOwnedWorkerLiveness.mockClear();
        tmuxSessionMocks.getOwnedWorkerLiveness.mockImplementation(async (ownership) => {
            if (ownership.provider === 'tmux' && !ownership.tmuxServerIdentity)
                return 'unknown';
            return tmuxSessionMocks.getWorkerLiveness(ownership.paneId);
        });
        tmuxSessionMocks.workerPaneBelongsToOwnedProviderTarget.mockReset();
        tmuxSessionMocks.workerPaneBelongsToOwnedProviderTarget.mockResolvedValue(true);
        tmuxSessionMocks.splitTeamWorkerPaneWithEvidence.mockReset();
        tmuxSessionMocks.splitTeamWorkerPaneWithEvidence.mockImplementation(async (splitTarget, direction, _cwd, provider, identity) => ({
            commandSucceeded: true,
            provider,
            splitTarget,
            direction,
            rawOutput: provider === 'tmux' ? '%12\n' : 'cmux-worker-1\n',
            stderr: '',
            paneId: provider === 'tmux' ? '%12' : 'cmux-worker-1',
            ...(provider === 'tmux' ? { tmuxServerIdentity: identity ?? tmuxSessionMocks.tmuxServerIdentity } : {}),
        }));
        tmuxSessionMocks.adoptWorkerPaneOwnership.mockReset();
        tmuxSessionMocks.adoptWorkerPaneOwnership.mockImplementation(async (input) => ({
            ok: true,
            ownership: {
                provider: input.provider ?? 'tmux',
                providerTarget: input.providerTarget,
                paneId: input.paneId,
                splitTarget: '',
                leaderPaneId: input.leaderPaneId,
                reservedPaneIds: [],
                source: 'adopted',
                ...(input.provider !== 'cmux'
                    ? { tmuxServerIdentity: input.tmuxServerIdentity ?? tmuxSessionMocks.tmuxServerIdentity }
                    : {}),
            },
        }));
        monitorMocks.withScalingLock.mockImplementation(async (_teamName, _leaderCwd, fn) => fn());
        monitorMocks.migrateTeamConfigRevision.mockImplementation(async () => {
            const config = await teamOpsMocks.teamReadConfig();
            monitorMocks.currentConfig = config;
            return config ? { config, stateRevision: config.state_revision ?? 0 } : null;
        });
        monitorMocks.readRevisionedTeamConfig.mockImplementation(async () => monitorMocks.currentConfig
            ? { config: monitorMocks.currentConfig, stateRevision: monitorMocks.currentConfig.state_revision ?? 0 } : null);
        monitorMocks.saveTeamConfigAtRevision.mockImplementation(async (next, expectedRevision) => {
            if (!monitorMocks.currentConfig || (monitorMocks.currentConfig.state_revision ?? 0) !== expectedRevision)
                return false;
            monitorMocks.currentConfig = next;
            return true;
        });
        config = makeConfig();
        teamOpsMocks.teamReadConfig.mockImplementation(async () => config);
        modelContractMocks.getWorkerEnv.mockImplementation((teamName, workerName, agentType) => ({
            OMC_TEAM_WORKER: `${teamName}/${workerName}`,
            OMC_TEAM_NAME: teamName,
            OMC_WORKER_AGENT_TYPE: agentType,
        }));
        tmuxSessionMocks.waitForPaneReady.mockResolvedValue(undefined);
        gitWorktreeMocks.ensureWorkerWorktree.mockReset();
        gitWorktreeMocks.installWorktreeRootAgents.mockReset();
        gitWorktreeMocks.installWorktreeRootAgents.mockReturnValue(undefined);
        gitWorktreeMocks.removeWorkerWorktree.mockReset();
        gitWorktreeMocks.restoreWorktreeRootAgents.mockReset();
        gitWorktreeMocks.restoreWorktreeRootAgents.mockReturnValue({ restored: true });
        gitWorktreeMocks.checkWorkerWorktreeRemovalSafety.mockReset();
        gitWorktreeMocks.prepareWorkerWorktreeForRemoval.mockReset();
        await activateFixtureInstance('demo-team', cwd);
    });
    afterEach(async () => {
        if (cwd) {
            await rm(cwd, { recursive: true, force: true });
        }
        if (previousStateDir === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = previousStateDir;
    });
    it.each([
        ['codex', ['/usr/bin/codex', 'exec', '--dangerously-bypass-approvals-and-sandbox']],
        ['gemini', ['/usr/bin/gemini', '--approval-mode', 'yolo']],
    ])('uses model-contract launch argv for %s scale-up workers', async (agentType, workerArgv) => {
        modelContractMocks.buildWorkerArgv.mockReturnValue(workerArgv);
        const result = await scaleUp('demo-team', 1, agentType, [{ subject: 'demo', description: 'demo task' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: true, newWorkerCount: 1, nextWorkerIndex: 2 });
        expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(agentType, {
            teamName: 'demo-team',
            workerName: 'worker-1',
            cwd: resolve(cwd),
            resolvedBinaryPath: workerArgv[0],
        });
        expect(tmuxSessionMocks.spawnOwnedWorkerInPane).toHaveBeenCalledWith('demo-session:0', expect.objectContaining({ paneId: '%12', providerTarget: 'demo-session:0' }), expect.objectContaining({
            teamName: 'demo-team',
            workerName: 'worker-1',
            instanceId: TEAM_INSTANCE_ID,
            launchBinary: workerArgv[0],
            launchArgs: workerArgv.slice(1),
            provider: agentType,
            envVars: expect.objectContaining({
                OMC_TEAM_WORKER: 'demo-team/worker-1',
                OMC_TEAM_NAME: 'demo-team',
                OMC_WORKER_AGENT_TYPE: agentType,
                OMC_TEAM_STATE_ROOT: teamStateRoot(cwd, 'demo-team'),
                OMC_TEAM_LEADER_CWD: resolve(cwd),
            }),
        }));
        const reservation = monitorMocks.saveTeamConfigAtRevision.mock.calls
            .map(([candidate]) => candidate)
            .find(candidate => candidate.workers.some(worker => worker.name === 'worker-1' && worker.operational_state === 'starting'));
        expect(reservation).toBeDefined();
        expect(reservation.active_scale_up).toEqual(expect.objectContaining({ phase: 'effects' }));
        expect(reservation.workers[0]).toMatchObject({ worker_cli: agentType, operational_state: 'starting',
            launch_descriptor: { schema_version: 1, provider: agentType, model: null,
                binary: workerArgv[0], args: workerArgv.slice(1) } });
        const splitIndex = tmuxSessionMocks.splitTeamWorkerPaneWithEvidence.mock.invocationCallOrder[0] ?? -1;
        expect(splitIndex).toBeGreaterThanOrEqual(0);
        expect(monitorMocks.saveTeamConfigAtRevision.mock.invocationCallOrder.find((_, index) => {
            const candidate = monitorMocks.saveTeamConfigAtRevision.mock.calls[index]?.[0];
            return candidate.workers.some(worker => worker.name === 'worker-1' && worker.operational_state === 'starting');
        })).toBeLessThan(splitIndex);
    });
    it('passes the immutable team defaults to scale-up resolution', async () => {
        modelContractMocks.resolveDefaultWorkerModel.mockReturnValue('composer-2.5');
        modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/cursor', '--model', 'composer-2.5']);
        config = makeConfig({
            external_models_defaults: { cursorModel: 'composer-2.5' },
        });
        const result = await scaleUp('demo-team', 1, 'cursor', [{ subject: 'demo', description: 'demo task' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: true });
        expect(modelContractMocks.resolveDefaultWorkerModel).toHaveBeenCalledWith('cursor', {}, { cursorModel: 'composer-2.5' });
        expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith('cursor', expect.objectContaining({ model: 'composer-2.5' }));
    });
    it('preserves Claude model environment when external defaults are empty', async () => {
        modelContractMocks.resolveDefaultWorkerModel.mockReturnValue('claude-env-model');
        modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/claude', '--model', 'claude-env-model']);
        config = makeConfig({ external_models_defaults: {} });
        const env = {
            OMC_TEAM_SCALING_ENABLED: '1',
            ANTHROPIC_MODEL: 'claude-env-model',
        };
        const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd, env);
        expect(result).toMatchObject({ ok: true });
        expect(modelContractMocks.resolveDefaultWorkerModel).toHaveBeenCalledWith('claude', env, {});
        expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith('claude', expect.objectContaining({ model: 'claude-env-model' }));
    });
    it('does not apply the implicit Claude snapshot to an explicitly typed external worker', async () => {
        modelContractMocks.resolveDefaultWorkerModel.mockReturnValue('codex-config-model');
        modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/codex', '--model', 'codex-config-model']);
        config = makeConfig({
            resolved_routing: {
                executor: { primary: { provider: 'claude', model: '', agent: 'executor' }, fallback: { provider: 'claude', model: '', agent: 'executor' } },
            },
            resolved_routing_roles: [],
        });
        const result = await scaleUp('demo-team', 1, 'codex', [{ subject: 'demo', description: 'demo task', owner: 'worker-1', role: 'executor' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: true });
        expect(modelContractMocks.resolveDefaultWorkerModel).toHaveBeenCalledWith('codex', expect.anything(), undefined);
        expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith('codex', expect.objectContaining({ model: 'codex-config-model' }));
    });
    it('preserves an external configured route when an older team has no routing-role metadata', async () => {
        modelContractMocks.resolveDefaultWorkerModel.mockReturnValue('gemini-config-model');
        modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/gemini', '--model', 'gemini-snapshot-model']);
        config = makeConfig({
            resolved_routing: {
                executor: {
                    primary: { provider: 'gemini', model: 'gemini-snapshot-model', agent: 'executor' },
                    fallback: { provider: 'claude', model: '', agent: 'executor' },
                },
            },
            resolved_routing_roles: undefined,
        });
        const result = await scaleUp('demo-team', 1, 'codex', [{ subject: 'demo', description: 'demo task', owner: 'worker-1', role: 'executor' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: true });
        expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith('gemini', expect.objectContaining({ model: 'gemini-snapshot-model' }));
    });
    it('preserves a Claude configured route when an older team has no routing-role metadata', async () => {
        modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/claude', '--model', 'legacy-claude-model']);
        config = makeConfig({
            resolved_routing: {
                executor: {
                    primary: { provider: 'claude', model: 'legacy-claude-model', agent: 'executor' },
                    fallback: { provider: 'claude', model: 'legacy-claude-model', agent: 'executor' },
                },
            },
            resolved_routing_roles: undefined,
        });
        const result = await scaleUp('demo-team', 1, 'codex', [{ subject: 'demo', description: 'demo task', owner: 'worker-1', role: 'executor' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: true });
        expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith('claude', expect.objectContaining({ model: 'legacy-claude-model' }));
    });
    it('keeps the caller provider when the owned task has no explicit role', async () => {
        modelContractMocks.resolveDefaultWorkerModel.mockReturnValue('codex-config-model');
        modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/codex', '--model', 'codex-config-model']);
        config = makeConfig({
            resolved_routing: {
                executor: {
                    primary: { provider: 'gemini', model: 'gemini-snapshot-model', agent: 'executor' },
                    fallback: { provider: 'claude', model: '', agent: 'executor' },
                },
            },
            resolved_routing_roles: ['executor'],
        });
        const result = await scaleUp('demo-team', 1, 'codex', [{ subject: 'implement the executor task', description: 'write code', owner: 'worker-1' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: true });
        expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith('codex', expect.objectContaining({ model: 'codex-config-model' }));
    });
    it('does not adopt a newly introduced environment default after an empty snapshot', async () => {
        modelContractMocks.resolveDefaultWorkerModel.mockReturnValue(undefined);
        modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/cursor']);
        config = makeConfig({ external_models_defaults: {} });
        const result = await scaleUp('demo-team', 1, 'cursor', [{ subject: 'demo', description: 'demo task' }], cwd, {
            OMC_TEAM_SCALING_ENABLED: '1',
            OMC_CURSOR_DEFAULT_MODEL: 'introduced-after-start',
        });
        expect(result).toMatchObject({ ok: true });
        expect(modelContractMocks.resolveDefaultWorkerModel).toHaveBeenCalledWith('cursor', {}, {});
        expect(modelContractMocks.buildWorkerArgv.mock.calls[0]?.[1]).not.toHaveProperty('model');
    });
    it.each([
        ["relative", "Resolved CLI binary 'codex' to relative path"],
        ["untrusted", "Resolved CLI binary 'codex' to untrusted location: /tmp/shadow/codex"],
        ["missing", "CLI binary 'codex' not found in PATH"],
    ])('fails %s scale-up provider preflight before worker side effects', async (_case, reason) => {
        modelContractMocks.resolveValidatedBinaryPath.mockImplementationOnce(() => { throw new Error(reason); });
        const result = await scaleUp('demo-team', 1, 'codex', [{ subject: 'demo', description: 'demo task' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toEqual({ ok: false, error: `Failed strict provider preflight for worker-1 (codex): ${reason}` });
        expect(tmuxSessionMocks.splitTeamWorkerPaneWithEvidence).not.toHaveBeenCalled();
        expect(gitWorktreeMocks.ensureWorkerWorktree).not.toHaveBeenCalled();
        expect(teamOpsMocks.teamWriteWorkerIdentity).not.toHaveBeenCalled();
        expect(existsSync(join(resolve(cwd), '.omc', 'state', 'team', 'demo-team', 'workers', 'worker-1'))).toBe(false);
    });
    it('rejects scale-up before external effects when recovery is already reserved', async () => {
        config = makeConfig({ state_revision: 4, next_worker_index: 2,
            active_recovery: { request_id: 'request-1', recovery_id: 'recovery-1', worker_name: 'worker-1', owner_epoch: 1,
                owner_nonce: 'owner-1', phase: 'reserved', state_revision: 4, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
        const result = await scaleUp('demo-team', 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toEqual({ ok: false, error: 'team_mutation_busy' });
        expect(tmuxSessionMocks.splitTeamWorkerPaneWithEvidence).not.toHaveBeenCalled();
    });
    it('rejects scale-down while an unverifiable scale-up reservation is active', async () => {
        config = makeConfig({ state_revision: 4, worker_count: 2, next_worker_index: 3,
            workers: [
                { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%1' },
                { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [], pane_id: '%2' },
            ],
            active_scale_up: {
                operation_id: 'scale-up-1', phase: 'effects', pid: 999_999, instance_id: TEAM_INSTANCE_ID,
                process_started_at: 'malformed', state_revision: 4, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            },
        });
        const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-2'] }, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toEqual({ ok: false, error: 'team_mutation_busy' });
        expect(tmuxSessionMocks.killWorkerPanes).not.toHaveBeenCalled();
    });
    it('rolls back a pending worktree when scale-up fails before worker config is saved', async () => {
        modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/codex']);
        config = makeConfig({
            agent_type: 'codex',
            team_state_root: teamStateRoot(cwd, 'demo-team'),
            worktree_mode: 'named',
        });
        gitWorktreeMocks.ensureWorkerWorktree.mockReturnValue({
            path: join(resolve(cwd), '.omc', 'team', 'demo-team', 'worktrees', 'worker-1'),
            branch: 'omc-team/demo-team/worker-1',
            workerName: 'worker-1',
            teamName: 'demo-team',
            createdAt: new Date().toISOString(),
            repoRoot: resolve(cwd),
            mode: 'named',
            detached: false,
            created: true,
            reused: false,
        });
        tmuxSessionMocks.spawnOwnedWorkerInPane.mockRejectedValueOnce(new Error('boom'));
        tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('dead');
        const result = await scaleUp('demo-team', 1, 'codex', [{ subject: 'demo', description: 'demo task' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: false });
        expect(gitWorktreeMocks.removeWorkerWorktree).toHaveBeenCalledWith('demo-team', 'worker-1', resolve(cwd));
    });
    it('rolls back a pending worktree when root overlay installation fails', async () => {
        modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/codex']);
        config = makeConfig({
            agent_type: 'codex',
            team_state_root: teamStateRoot(cwd, 'demo-team'),
            worktree_mode: 'named',
        });
        gitWorktreeMocks.ensureWorkerWorktree.mockReturnValue({
            path: join(resolve(cwd), '.omc', 'team', 'demo-team', 'worktrees', 'worker-1'),
            branch: 'omc-team/demo-team/worker-1',
            workerName: 'worker-1',
            teamName: 'demo-team',
            createdAt: new Date().toISOString(),
            repoRoot: resolve(cwd),
            mode: 'named',
            detached: false,
            created: true,
            reused: false,
        });
        gitWorktreeMocks.installWorktreeRootAgents.mockImplementationOnce(() => {
            throw new Error('agents_dirty');
        });
        const result = await scaleUp('demo-team', 1, 'codex', [{ subject: 'demo', description: 'demo task' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Failed to install worker overlay') });
        expect(gitWorktreeMocks.removeWorkerWorktree).toHaveBeenCalledWith('demo-team', 'worker-1', resolve(cwd));
        expect(tmuxSessionMocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
    });
    it('restores managed overlays for reused worktrees during scale-down without deleting them', async () => {
        const config = {
            name: 'demo-team',
            instance_id: TEAM_INSTANCE_ID,
            tmux_server_identity: tmuxSessionMocks.tmuxServerIdentity,
            task: 'demo',
            agent_type: 'codex',
            worker_launch_mode: 'interactive',
            worker_count: 2,
            max_workers: 20,
            workers: [
                { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1', worktree_path: join(resolve(cwd), 'reuse'), worktree_created: false, ...launchMetadata },
                { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [], pane_id: '%2' },
            ],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            next_task_id: 2,
            next_worker_index: 3,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            team_state_root: teamStateRoot(cwd, 'demo-team'),
        };
        teamOpsMocks.teamReadConfig.mockResolvedValue(config);
        teamOpsMocks.teamReadWorkerStatus.mockResolvedValue({ state: 'idle', updated_at: new Date().toISOString() });
        tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('dead');
        const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-1'], drainTimeoutMs: 0 }, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: true, removedWorkers: ['worker-1'], newWorkerCount: 1 });
        expect(gitWorktreeMocks.prepareWorkerWorktreeForRemoval).toHaveBeenCalledWith('demo-team', 'worker-1', resolve(cwd), join(resolve(cwd), 'reuse'));
        expect(gitWorktreeMocks.removeWorkerWorktree).not.toHaveBeenCalled();
        expect(workerLaunchMocks.retireAndCleanupCurrentWorkerLaunchAttempt).toHaveBeenCalledWith(expect.objectContaining({ attempt_id: 'attempt-loaded' }), 'scale_down', expect.any(Function));
        expect(tmuxSessionMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
    });
    it('preserves pane and state when scale-down launch ownership is not accepted', async () => {
        const current = makeConfig({
            worker_count: 2,
            next_worker_index: 3,
            workers: [
                { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1', ...launchMetadata },
                { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [], pane_id: '%2' },
            ],
        });
        teamOpsMocks.teamReadConfig.mockResolvedValue(current);
        teamOpsMocks.teamReadWorkerStatus.mockResolvedValue({ state: 'idle', updated_at: new Date().toISOString() });
        tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('dead');
        workerLaunchMocks.retireAndCleanupCurrentWorkerLaunchAttempt.mockResolvedValueOnce(false);
        const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-1'], drainTimeoutMs: 0 }, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: false, error: 'provider_cleanup_unverified:worker-1' });
        expect(workerLaunchMocks.retireAndCleanupCurrentWorkerLaunchAttempt).toHaveBeenCalled();
        expect(tmuxSessionMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
        expect(monitorMocks.currentConfig?.workers.map(worker => worker.name)).toEqual(['worker-1', 'worker-2']);
    });
    it('keeps reused worktree worker tracked if post-drain cleanup safety fails', async () => {
        const config = {
            name: 'demo-team',
            instance_id: TEAM_INSTANCE_ID,
            tmux_server_identity: tmuxSessionMocks.tmuxServerIdentity,
            task: 'demo',
            agent_type: 'codex',
            worker_launch_mode: 'interactive',
            worker_count: 2,
            max_workers: 20,
            workers: [
                { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1', worktree_path: join(resolve(cwd), 'reuse'), worktree_created: false, ...launchMetadata },
                { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [], pane_id: '%2' },
            ],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            next_task_id: 2,
            next_worker_index: 3,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            team_state_root: teamStateRoot(cwd, 'demo-team'),
        };
        teamOpsMocks.teamReadConfig.mockResolvedValue(config);
        teamOpsMocks.teamReadWorkerStatus.mockResolvedValue({ state: 'idle', updated_at: new Date().toISOString() });
        tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('dead');
        gitWorktreeMocks.prepareWorkerWorktreeForRemoval.mockImplementationOnce(() => {
            throw new Error('worktree_dirty: preserving dirty worker worktree');
        });
        const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-1'], drainTimeoutMs: 0 }, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining('worktree_dirty') });
        expect(gitWorktreeMocks.prepareWorkerWorktreeForRemoval).toHaveBeenCalledWith('demo-team', 'worker-1', resolve(cwd), join(resolve(cwd), 'reuse'));
        expect(monitorMocks.saveTeamConfig).not.toHaveBeenCalled();
    });
    it('preserves worktree and config when target pane remains alive after kill request', async () => {
        const config = {
            name: 'demo-team',
            instance_id: TEAM_INSTANCE_ID,
            tmux_server_identity: tmuxSessionMocks.tmuxServerIdentity,
            task: 'demo',
            agent_type: 'codex',
            worker_launch_mode: 'interactive',
            worker_count: 2,
            max_workers: 20,
            workers: [
                { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1', worktree_path: join(resolve(cwd), 'created'), worktree_created: true, ...launchMetadata },
                { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [], pane_id: '%2' },
            ],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            next_task_id: 2,
            next_worker_index: 3,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            team_state_root: teamStateRoot(cwd, 'demo-team'),
        };
        teamOpsMocks.teamReadConfig.mockResolvedValue(config);
        teamOpsMocks.teamReadWorkerStatus.mockResolvedValue({ state: 'idle', updated_at: new Date().toISOString() });
        tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('alive');
        const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-1'], drainTimeoutMs: 0 }, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining('pane_still_alive') });
        expect(tmuxSessionMocks.killOwnedWorkerPane).toHaveBeenCalled();
        expect(gitWorktreeMocks.removeWorkerWorktree).not.toHaveBeenCalled();
        expect(monitorMocks.saveTeamConfig).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=scaling-launch-config.test.js.map