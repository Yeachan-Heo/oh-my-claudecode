import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync as createTempDir, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive } from '../../platform/process-utils.js';
import { currentStrictProcessStartIdentity } from '../team-owner-epoch.js';
const paneMocks = vi.hoisted(() => {
    const state = { liveness: new Map() };
    return {
        getWorkerLiveness: vi.fn(async (paneId) => state.liveness.get(paneId) ?? 'unknown'),
        getOwnedWorkerLiveness: vi.fn(async (ownership) => state.liveness.get(ownership.paneId) ?? 'unknown'),
        captureOwnedTeamPane: vi.fn(async () => ''),
        workerPaneBelongsToOwnedProviderTarget: vi.fn(async (input) => input.paneId !== state.blockedPane),
        observeTmuxServerIdentity: vi.fn(async () => 'matching'),
        verifyTeamTargetOwnership: vi.fn(async (target) => ({
            kind: 'owned',
            provider: target.provider,
            providerTarget: target.providerTarget,
            recipient: 'worker',
            recipientRole: 'worker',
            paneId: target.paneId,
            ...(state.serverIdentity ? { tmuxServerIdentity: state.serverIdentity } : {}),
        })),
        setPaneLiveness: (paneId, value) => { state.liveness.set(paneId, value); },
        clearPaneLiveness: () => { state.liveness.clear(); },
        blockPane: (paneId) => { state.blockedPane = paneId; },
        setServerIdentity: (identity) => {
            state.serverIdentity = identity;
        },
        splitTeamWorkerPane: vi.fn(async () => '%2'),
        splitTeamWorkerPaneWithEvidence: vi.fn(async () => ({ commandSucceeded: true, provider: 'tmux',
            splitTarget: '%0', direction: 'right', rawOutput: '%2\n', stderr: '', paneId: '%2',
            ...(state.serverIdentity ? { tmuxServerIdentity: state.serverIdentity } : {}) })),
        spawnWorkerInPane: vi.fn(async (_sessionName, _paneId, _config) => { throw new Error('spawn failed --api-key SUPERSECRET after pane creation'); }),
        spawnOwnedWorkerInPane: vi.fn(),
        killTeamPane: vi.fn(async (_paneId) => { throw new Error('pane still alive'); }),
        killOwnedWorkerPane: vi.fn(),
        applyMainVerticalLayout: vi.fn(async () => undefined),
        workerPaneBelongsToProviderTarget: vi.fn(async () => true),
        adoptWorkerPaneOwnership: vi.fn(async (input) => ({
            ok: true,
            ownership: {
                provider: input.provider,
                providerTarget: input.providerTarget,
                paneId: input.paneId,
                splitTarget: '',
                direction: 'right',
                source: 'adopted',
                evidence: { commandSucceeded: true, provider: input.provider, splitTarget: '', direction: 'right', rawOutput: '', stderr: '', paneId: input.paneId },
                ...(input.provider === 'tmux' && state.serverIdentity ? { tmuxServerIdentity: state.serverIdentity } : {}),
            },
        })),
    };
});
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => ({
    ...await importOriginal(),
    tmuxExecAsync: vi.fn(async (args) => ({
        stdout: args.includes('list-panes')
            ? '%0\n%1\n%2\n%9\n%10\n'
            : '',
        stderr: '',
    })),
    tmuxCmdAsync: vi.fn(async (args) => ({
        stdout: args.includes('#{pid}') ? `${process.pid}\n` : '',
        stderr: '',
    })),
}));
vi.mock('../tmux-session.js', async (importOriginal) => ({
    ...await importOriginal(),
    ...paneMocks,
}));
vi.mock('../model-contract.js', async (importOriginal) => ({
    ...await importOriginal(),
    getContract: vi.fn(() => ({})),
    resolveValidatedBinaryPath: vi.fn((agentType) => agentType === 'gemini' ? process.execPath : '/bin/echo'),
    buildWorkerArgv: vi.fn(() => ['/bin/echo']),
    getWorkerEnv: vi.fn(() => ({})),
}));
paneMocks.spawnOwnedWorkerInPane.mockImplementation(async (sessionName, ownership, config) => {
    await paneMocks.spawnWorkerInPane(sessionName, ownership.paneId, config);
    return { ownership };
});
paneMocks.killOwnedWorkerPane.mockImplementation(async (ownership) => {
    await paneMocks.killTeamPane(ownership.paneId);
});
import { reserveRecoveryRequest as persistRecoveryRequest } from '../recovery-request-store.js';
import { executeRecoverDeadWorkerV2Owner } from '../runtime-v2.js';
import { activateTeamInstanceUnderLock, createTeamInstanceBinding, reserveTeamInstance, withTeamInstanceLifecycleLock, } from '../team-instance.js';
import { absPath, TeamPaths } from '../state-paths.js';
import { awaitWorkerLaunchAcknowledgement, awaitWorkerLaunchProviderStarted, buildWorkerLaunchBootstrapSpec, materializeWorkerLaunchTransport, prepareWorkerLaunchAttempt, loadCurrentWorkerLaunchAttempt, readAndConsumeWorkerLaunchDescriptor, runWorkerLaunchBootstrap, retireWorkerLaunchAttempt, terminateWorkerLaunchProvider, } from '../worker-launch-ack.js';
function reserveRecoveryRequest(stateCwd, requestId, payload, recoveryId) {
    persistFixtureAuthority(payload.teamName, stateCwd);
    return persistRecoveryRequest(stateCwd, requestId, payload, recoveryId);
}
const launchMetadata = { worker_cli: 'claude',
    launch_descriptor: { schema_version: 1, provider: 'claude', model: null,
        binary: '/bin/echo', args: [] } };
const TEAM_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
function fixtureTmuxServerIdentity(stateCwd = cwd) {
    const processStartedAt = currentStrictProcessStartIdentity();
    if (!processStartedAt)
        throw new Error('fixture tmux process identity unavailable');
    const identity = {
        socket_path: join(stateCwd, '.omc-fixture-tmux.sock'),
        server_pid: process.pid,
        process_started_at: processStartedAt,
    };
    paneMocks.setServerIdentity(identity);
    return identity;
}
function fixtureManifest(config, serverIdentity, existing = {}) {
    const workers = Array.isArray(config.workers)
        ? config.workers.map((worker) => ({
            role: worker.role ?? worker.worker_cli ?? config.agent_type ?? 'worker',
            assigned_tasks: worker.assigned_tasks ?? [],
            ...worker,
        }))
        : [];
    return {
        ...existing,
        schema_version: 2,
        state_revision: config.state_revision,
        name: config.name,
        instance_id: config.instance_id,
        tmux_server_identity: serverIdentity,
        task: config.task ?? '',
        leader: { session_id: `${config.name}:0`, worker_id: 'leader-fixed', role: 'leader' },
        policy: config.policy ?? {
            display_mode: 'split_pane',
            worker_launch_mode: config.worker_launch_mode ?? 'interactive',
            dispatch_mode: 'hook_preferred_with_fallback',
            dispatch_ack_timeout_ms: 15_000,
        },
        governance: config.governance ?? {
            delegation_only: false,
            plan_approval_required: false,
            nested_teams_allowed: false,
            one_team_per_leader_session: true,
            cleanup_requires_all_workers_inactive: true,
        },
        permissions_snapshot: { approval_mode: 'default', sandbox_mode: 'workspace-write', network_access: false },
        tmux_session: config.tmux_session,
        worker_count: config.worker_count,
        workers,
        next_task_id: config.next_task_id ?? 1,
        created_at: config.created_at,
        leader_cwd: config.leader_cwd,
        team_state_root: config.team_state_root,
        leader_pane_id: config.leader_pane_id ?? null,
        hud_pane_id: config.hud_pane_id ?? null,
        resize_hook_name: config.resize_hook_name ?? null,
        resize_hook_target: config.resize_hook_target ?? null,
    };
}
function persistFixtureAuthority(teamName, stateCwd) {
    const configPath = absPath(stateCwd, TeamPaths.config(teamName));
    if (!existsSync(configPath))
        return;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const serverIdentity = fixtureTmuxServerIdentity(stateCwd);
    const manifestPath = absPath(stateCwd, TeamPaths.manifest(teamName));
    const existingManifest = existsSync(manifestPath)
        ? JSON.parse(readFileSync(manifestPath, 'utf8'))
        : {};
    config.instance_id = config.instance_id ?? TEAM_INSTANCE_ID;
    config.tmux_server_identity = serverIdentity;
    config.leader_pane_id = /^%\d+$/.test(String(config.leader_pane_id ?? ''))
        ? config.leader_pane_id
        : '%0';
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(manifestPath, JSON.stringify(fixtureManifest(config, serverIdentity, existingManifest)));
}
let cwd = '';
let previousHome;
let previousUserProfile;
let previousOmcStateDir;
beforeEach(() => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousOmcStateDir = process.env.OMC_STATE_DIR;
});
function mkdtempSync(prefix) {
    const root = createTempDir(prefix);
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.OMC_STATE_DIR;
    return root;
}
async function reservePersistedTeamInstance(teamName, cwd, instanceId = TEAM_INSTANCE_ID) {
    await reserveTeamInstance({ teamName, cwd, instanceId });
}
async function activatePersistedTeamInstance(teamName, cwd, instanceId = TEAM_INSTANCE_ID) {
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.instance_id = instanceId;
    config.tmux_server_identity = fixtureTmuxServerIdentity();
    config.leader_pane_id = /^%\d+$/.test(String(config.leader_pane_id ?? ''))
        ? config.leader_pane_id
        : '%0';
    const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
    const existingManifest = existsSync(manifestPath)
        ? JSON.parse(readFileSync(manifestPath, 'utf8'))
        : {};
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(manifestPath, JSON.stringify(fixtureManifest(config, config.tmux_server_identity, existingManifest)));
    const binding = createTeamInstanceBinding({ teamName, cwd, instanceId });
    await withTeamInstanceLifecycleLock(binding.cwd, binding.team_name, async () => {
        await activateTeamInstanceUnderLock(binding);
    });
}
afterEach(() => {
    vi.clearAllMocks();
    paneMocks.clearPaneLiveness();
    paneMocks.blockPane(undefined);
    if (cwd)
        rmSync(cwd, { recursive: true, force: true });
    if (previousHome === undefined)
        delete process.env.HOME;
    else
        process.env.HOME = previousHome;
    if (previousUserProfile === undefined)
        delete process.env.USERPROFILE;
    else
        process.env.USERPROFILE = previousUserProfile;
    if (previousOmcStateDir === undefined)
        delete process.env.OMC_STATE_DIR;
    else
        process.env.OMC_STATE_DIR = previousOmcStateDir;
});
async function expectRecoveryLockReleased(teamName, workerName, suffix) {
    const requestId = `${suffix}-followup-request`;
    const followupRecoveryId = `${suffix}-followup-recovery`;
    reserveRecoveryRequest(cwd, requestId, {
        operation: 'recover-worker',
        workspaceHash: createHash('sha256').update(cwd).digest('hex'),
        teamName,
        workerName,
        instanceId: TEAM_INSTANCE_ID,
    }, followupRecoveryId);
    let timeout;
    const followup = await Promise.race([
        executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName, requestId, instanceId: TEAM_INSTANCE_ID }),
        new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('recovery lock remained held after terminal failure')), 2_000);
        }),
    ]);
    if (timeout)
        clearTimeout(timeout);
    expect(followup).toMatchObject({
        outcome: 'failed',
        committed: false,
        error: 'team_mutation_busy',
        recoveryId: followupRecoveryId,
    });
    const config = JSON.parse(readFileSync(absPath(cwd, TeamPaths.config(teamName)), 'utf8'));
    expect(config.active_recovery?.recovery_id).not.toBe(followupRecoveryId);
}
async function attachPersistedPriorLaunch(teamName, configPath) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const worker = config.workers[0];
    const provider = worker.launch_descriptor?.provider ?? worker.worker_cli;
    const attempt = await prepareWorkerLaunchAttempt({ cwd, teamName, workerName: worker.name, paneId: '%1',
        instanceId: TEAM_INSTANCE_ID, provider, runtimeCliPath: '/runtime-cli.cjs', context: { kind: 'initial' } });
    const stopPath = join(cwd, `${teamName}-prior-provider-stop`);
    const providerScript = [
        "const fs=require('node:fs')",
        `const stopPath=${JSON.stringify(stopPath)}`,
        'const deadline=Date.now()+5000',
        'const timer=setInterval(()=>{if(fs.existsSync(stopPath)){clearInterval(timer);process.exit(0)}if(Date.now()>deadline){clearInterval(timer);process.exit(2)}},10)',
    ].join(';');
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(attempt, [process.execPath, '-e', providerScript], cwd));
    let launchCompleted = false;
    try {
        await expect(awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 1_000, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
        await expect(awaitWorkerLaunchProviderStarted(attempt, { timeoutMs: 2_000, pollIntervalMs: 5 })).resolves.toBe(true);
        writeFileSync(stopPath, 'stop');
        await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
        launchCompleted = true;
        worker.pane_id = '%1';
        worker.launch_attempt_id = attempt.attempt_id;
        writeFileSync(configPath, JSON.stringify(config));
    }
    finally {
        if (!launchCompleted) {
            writeFileSync(stopPath, 'stop');
            await bootstrap.catch(() => ({ outcome: 'provider_spawn_failed' }));
        }
    }
}
describe('recovery pane rollback evidence', () => {
    it('retains the attempt and publishes durable evidence when pane cleanup cannot be verified', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-pane-orphan-'));
        const teamName = 'orphan-team';
        const requestId = 'orphan-request';
        const recoveryId = 'orphan-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        const workerCwd = join(cwd, 'worker-worktree');
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1, working_dir: workerCwd }],
            agent_type: 'claude',
            created_at: new Date().toISOString(),
            tmux_session: `${teamName}:0`,
            lifecycle_state: 'active',
            state_revision: 1,
            leader_pane_id: '%leader',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        paneMocks.setPaneLiveness('%1', 'dead');
        paneMocks.setPaneLiveness('%2', 'alive');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).toHaveBeenCalled();
        expect(paneMocks.spawnWorkerInPane).toHaveBeenCalled();
        expect(paneMocks.spawnOwnedWorkerInPane).toHaveBeenCalledWith(`${teamName}:0`, expect.objectContaining({ paneId: '%2' }), expect.objectContaining({ cwd: workerCwd, launchStateCwd: cwd }));
        expect(paneMocks.applyMainVerticalLayout).toHaveBeenCalledWith(`${teamName}:0`, expect.objectContaining({ required: true, tmuxServerIdentity: fixtureTmuxServerIdentity() }));
        expect(paneMocks.applyMainVerticalLayout.mock.invocationCallOrder[0])
            .toBeLessThan(paneMocks.spawnOwnedWorkerInPane.mock.invocationCallOrder[0]);
        expect(paneMocks.killTeamPane).not.toHaveBeenCalled();
        const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
        const evidenceFiles = readdirSync(evidenceRoot);
        expect(evidenceFiles).toHaveLength(1);
        const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles[0]), 'utf8'));
        expect(evidence).toMatchObject({ schema_version: 1, team_name: teamName, worker_name: 'worker-1',
            request_id: requestId, recovery_id: recoveryId, pane_id: '%2', reason: 'spawn failed --api-key=<redacted> after pane creation:provider_cleanup_unverified', liveness: 'alive' });
        await expectRecoveryLockReleased(teamName, 'worker-1', 'cleanup-failure');
    });
    it('preserves the recovery pane when provider containment cannot be verified', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-provider-unverified-'));
        const teamName = 'provider-unverified-team';
        const requestId = 'provider-unverified-request';
        const recoveryId = 'provider-unverified-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1 }],
            agent_type: 'claude',
            created_at: new Date().toISOString(),
            tmux_session: `${teamName}:0`,
            lifecycle_state: 'active',
            state_revision: 1,
            leader_pane_id: '%leader',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        paneMocks.setPaneLiveness('%1', 'dead');
        paneMocks.setPaneLiveness('%2', 'alive');
        paneMocks.spawnOwnedWorkerInPane.mockImplementationOnce(async (_sessionName, ownership) => {
            const attempt = await prepareWorkerLaunchAttempt({ cwd, teamName, workerName: 'worker-1', paneId: ownership.paneId,
                instanceId: TEAM_INSTANCE_ID, provider: 'claude', runtimeCliPath: '/runtime-cli.cjs', context: { kind: 'recovery',
                    recovery_id: recoveryId, replacement_generation: 2, pane_attempt_id: 'test-pane-attempt' } });
            const expected = JSON.parse(readFileSync(attempt.expectedPath, 'utf8'));
            writeFileSync(attempt.ackPath, JSON.stringify({ ...expected, kind: 'worker_launch_ack', written_at: new Date().toISOString() }));
            await awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 1_000, pollIntervalMs: 5 });
            let reads = 0;
            return Object.defineProperty({ ownership }, 'attempt', {
                enumerable: true,
                get: () => {
                    if (reads++ === 0)
                        throw new Error('activation record failed');
                    return attempt;
                },
            });
        });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });
        expect(paneMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
        expect(paneMocks.killTeamPane).not.toHaveBeenCalled();
        const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
        const evidenceFiles = readdirSync(evidenceRoot);
        expect(evidenceFiles.length).toBeGreaterThan(0);
        const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles.at(-1)), 'utf8'));
        expect(evidence).toMatchObject({
            recovery_id: recoveryId,
            pane_id: '%2',
            reason: 'activation record failed:provider_cleanup_unverified',
            liveness: 'alive',
        });
    });
    it('reconciles an accepted initial launch pointer before treating the worker as already running', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'omc-recovery-initial-pointer-'));
        const teamName = 'initial-pointer-team';
        const requestId = 'initial-pointer-request';
        const recoveryId = 'initial-pointer-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude',
            created_at: new Date().toISOString(),
            tmux_session: `${teamName}:0`,
            lifecycle_state: 'active',
            state_revision: 1,
            leader_pane_id: '%leader',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        reserveRecoveryRequest(cwd, requestId, {
            operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'),
            teamName,
            workerName: 'worker-1',
            instanceId: TEAM_INSTANCE_ID,
        }, recoveryId);
        const launchAttempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName,
            workerName: 'worker-1',
            instanceId: TEAM_INSTANCE_ID,
            paneId: '%9',
            provider: 'claude',
            runtimeCliPath: '/runtime-cli.cjs',
            context: { kind: 'initial' },
        });
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd));
        try {
            await awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 });
            await expect(awaitWorkerLaunchProviderStarted(launchAttempt, { timeoutMs: 10_000, pollIntervalMs: 5 })).resolves.toBe(true);
            await expect(loadCurrentWorkerLaunchAttempt({
                cwd,
                teamName,
                workerName: 'worker-1',
                instanceId: TEAM_INSTANCE_ID,
                provider: 'claude',
            })).resolves.toMatchObject({ attempt_id: launchAttempt.attempt_id, pane_id: '%9', context: { kind: 'initial' } });
            paneMocks.setPaneLiveness('%9', 'alive');
            await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
                .resolves.toMatchObject({ outcome: 'already_running', committed: true, newPaneId: '%9' });
            const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
            expect(persisted.workers[0]).toMatchObject({
                pane_id: '%9',
                launch_attempt_id: launchAttempt.attempt_id,
                operational_state: 'active',
            });
            expect(paneMocks.splitTeamWorkerPaneWithEvidence).not.toHaveBeenCalled();
        }
        finally {
            await retireWorkerLaunchAttempt(launchAttempt, 'test_cleanup').catch(() => false);
            await terminateWorkerLaunchProvider(launchAttempt).catch(() => false);
            await bootstrap.catch(() => ({ outcome: 'provider_spawn_failed' }));
        }
    });
    it('cleans a dead provider with persisted launch authority and continues recovery', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-legacy-dead-pane-'));
        const teamName = 'legacy-dead-pane-team';
        const requestId = 'legacy-dead-pane-request';
        const recoveryId = 'legacy-dead-pane-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        const priorAttempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName,
            workerName: 'worker-1',
            instanceId: TEAM_INSTANCE_ID,
            paneId: '%1',
            provider: 'claude',
            runtimeCliPath: '/runtime-cli.cjs',
            context: { kind: 'initial' },
        });
        const priorBootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(priorAttempt, [process.execPath, '-e', 'setTimeout(() => process.exit(0), 500)'], cwd));
        await expect(awaitWorkerLaunchAcknowledgement(priorAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
            .resolves.toEqual({ ok: true });
        await expect(awaitWorkerLaunchProviderStarted(priorAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
            .resolves.toBe(true);
        await expect(priorBootstrap).resolves.toMatchObject({ outcome: 'ran' });
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{
                    name: 'worker-1',
                    index: 1,
                    ...launchMetadata,
                    launch_attempt_id: priorAttempt.attempt_id,
                    pane_id: '%1',
                    replacement_generation: 1,
                    working_dir: cwd,
                }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        // Saga and provider retirement observe the persisted launch's dead pane.
        // Replacement pane (%2) is alive so spawn-failure cleanup publishes orphan evidence.
        paneMocks.setPaneLiveness('%1', 'dead');
        paneMocks.setPaneLiveness('%2', 'alive');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).toHaveBeenCalled();
        expect(paneMocks.spawnOwnedWorkerInPane).toHaveBeenCalled();
        // Dead pre-upgrade pane: no ownership kill required
        expect(paneMocks.adoptWorkerPaneOwnership).not.toHaveBeenCalledWith(expect.objectContaining({ paneId: '%1' }));
        const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(persisted.active_recovery).toMatchObject({ recovery_id: recoveryId, worker_name: 'worker-1' });
    });
    it('kills a live owned pane after proving provider launch authority before replacement', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-legacy-live-pane-'));
        const teamName = 'legacy-live-pane-team';
        const requestId = 'legacy-live-pane-request';
        const recoveryId = 'legacy-live-pane-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        // Saga getLiveness reports dead even though the pane shell is live.
        // Provider retirement then kills the live owned pane; replacement uses %2.
        let legacyKillCount = 0;
        paneMocks.setPaneLiveness('%1', 'alive');
        paneMocks.setPaneLiveness('%2', 'alive');
        paneMocks.killOwnedWorkerPane.mockImplementation(async (ownership) => {
            if (ownership.paneId === '%1') {
                legacyKillCount += 1;
                paneMocks.setPaneLiveness('%1', 'dead');
            }
            // Successful owned kill of the legacy pane — do not throw
        });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });
        expect(paneMocks.adoptWorkerPaneOwnership).toHaveBeenCalledWith(expect.objectContaining({
            paneId: '%1',
            leaderPaneId: '%0',
            providerTarget: `${teamName}:0`,
        }));
        expect(paneMocks.killOwnedWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%1' }));
        expect(legacyKillCount).toBe(1);
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).toHaveBeenCalled();
    });
    it('fail-closes legacy recovery when pane liveness is unknown', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-legacy-unknown-liveness-'));
        const teamName = 'legacy-unknown-liveness-team';
        const requestId = 'legacy-unknown-liveness-request';
        const recoveryId = 'legacy-unknown-liveness-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        // A pane without launch authority is not executable recovery evidence.
        paneMocks.setPaneLiveness('%1', 'unknown');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'worker_liveness_unknown', recoveryId });
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).not.toHaveBeenCalled();
        expect(paneMocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
        expect(paneMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
        const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(persisted.workers[0].pane_id).toBe('%1');
        expect(persisted.active_recovery).toMatchObject({ recovery_id: recoveryId, worker_name: 'worker-1' });
    });
    it('does not adopt a foreign/alias pane without launch authority', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-legacy-foreign-pane-'));
        const teamName = 'legacy-foreign-pane-team';
        const requestId = 'legacy-foreign-pane-request';
        const recoveryId = 'legacy-foreign-pane-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'worker_liveness_unknown', recoveryId });
        expect(paneMocks.adoptWorkerPaneOwnership).not.toHaveBeenCalled();
        expect(paneMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).not.toHaveBeenCalled();
        const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(persisted.workers[0].pane_id).toBe('%1');
    });
    it('fail-closes recovery when owned pane kill cannot prove death', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-legacy-kill-fail-'));
        const teamName = 'legacy-kill-fail-team';
        const requestId = 'legacy-kill-fail-request';
        const recoveryId = 'legacy-kill-fail-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        const priorAttempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName,
            workerName: 'worker-1',
            instanceId: TEAM_INSTANCE_ID,
            paneId: '%1',
            provider: 'claude',
            runtimeCliPath: '/runtime-cli.cjs',
            context: { kind: 'initial' },
        });
        const priorBootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(priorAttempt, [process.execPath, '-e', 'setTimeout(() => process.exit(0), 500)'], cwd));
        await expect(awaitWorkerLaunchAcknowledgement(priorAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
            .resolves.toEqual({ ok: true });
        await expect(awaitWorkerLaunchProviderStarted(priorAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
            .resolves.toBe(true);
        await expect(priorBootstrap).resolves.toMatchObject({ outcome: 'ran' });
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{
                    name: 'worker-1',
                    index: 1,
                    ...launchMetadata,
                    launch_attempt_id: priorAttempt.attempt_id,
                    pane_id: '%1',
                    replacement_generation: 1,
                    working_dir: cwd,
                }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        paneMocks.setPaneLiveness('%1', 'alive');
        paneMocks.killOwnedWorkerPane.mockResolvedValue(undefined);
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'worker_cleanup_incomplete', recoveryId });
        expect(paneMocks.killOwnedWorkerPane).toHaveBeenCalled();
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).not.toHaveBeenCalled();
        const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(persisted.workers[0].pane_id).toBe('%1');
        expect(persisted.active_recovery).toMatchObject({ recovery_id: recoveryId });
    });
    it('terminates the dead-pane provider before allocating a replacement pane', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-old-provider-retirement-'));
        const teamName = 'old-provider-team';
        const requestId = 'old-provider-request';
        const recoveryId = 'old-provider-recovery';
        await reservePersistedTeamInstance(teamName, cwd);
        const oldAttempt = await prepareWorkerLaunchAttempt({ cwd, teamName, workerName: 'worker-1', paneId: '%1',
            instanceId: TEAM_INSTANCE_ID, provider: 'claude', runtimeCliPath: '/runtime-cli.cjs', context: { kind: 'initial' } });
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(oldAttempt, [process.execPath, '-e', 'setTimeout(()=>process.exit(0),500)'], cwd));
        await expect(awaitWorkerLaunchAcknowledgement(oldAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
            .resolves.toEqual({ ok: true });
        await expect(awaitWorkerLaunchProviderStarted(oldAttempt, { timeoutMs: 10_000, pollIntervalMs: 5 }))
            .resolves.toBe(true);
        await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
        const oldPid = JSON.parse(readFileSync(oldAttempt.startedPath, 'utf8')).pid;
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, launch_attempt_id: oldAttempt.attempt_id,
                    pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%9',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        paneMocks.setPaneLiveness('%1', 'dead');
        paneMocks.splitTeamWorkerPaneWithEvidence.mockImplementationOnce(async () => {
            expect(isProcessAlive(oldPid)).toBe(false);
            return { commandSucceeded: true, provider: 'tmux', splitTarget: '%9', direction: 'right',
                rawOutput: '', stderr: '', paneId: null, tmuxServerIdentity: fixtureTmuxServerIdentity() };
        });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', recoveryId });
        expect(isProcessAlive(oldPid)).toBe(false);
        expect(existsSync(`${oldAttempt.decisionPath}.retired`)).toBe(true);
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).toHaveBeenCalledTimes(1);
    });
    it('completes an idle Gemini recovery without requiring fabricated progress evidence', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'omc-recovery-idle-gemini-'));
        const teamName = 'idle-gemini-team';
        const requestId = 'idle-gemini-request';
        const recoveryId = 'idle-gemini-recovery';
        const inboxPath = absPath(cwd, TeamPaths.inbox(teamName, 'worker-1'));
        const providerObservedPath = join(cwd, 'provider-observed-inbox.txt');
        const providerStopPath = join(cwd, 'provider-stop');
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(inboxPath, '..'), { recursive: true });
        writeFileSync(inboxPath, 'STALE PRE-RECOVERY INBOX', 'utf8');
        const serviceDescriptor = {
            schema_version: 1,
            service_generation: 1,
            service_attempt_id: 'service-attempt',
            workspace_root: cwd,
            auto_merge_enabled: false,
            cadence_policy: 'disabled',
        };
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            worker_count: 1,
            workers: [{
                    name: 'worker-1',
                    index: 1,
                    worker_cli: 'gemini',
                    launch_descriptor: {
                        schema_version: 1,
                        provider: 'gemini',
                        model: null,
                        binary: process.execPath,
                        args: ['-e', [
                                "const fs=require('node:fs')",
                                `const stopPath=${JSON.stringify(providerStopPath)}`,
                                `fs.writeFileSync(${JSON.stringify(providerObservedPath)},fs.readFileSync(${JSON.stringify(inboxPath)},'utf8'))`,
                                'const deadline=Date.now()+10000',
                                'const timer=setInterval(()=>{if(fs.existsSync(stopPath)){clearInterval(timer);process.exit(0)}if(Date.now()>deadline){clearInterval(timer);process.exit(2)}},10)',
                            ].join(';')],
                    },
                    pane_id: '%1',
                    replacement_generation: 1,
                    working_dir: cwd,
                }],
            agent_type: 'gemini',
            created_at: new Date().toISOString(),
            tmux_session: `${teamName}:0`,
            lifecycle_state: 'active',
            state_revision: 1,
            leader_pane_id: '%0',
            service_descriptor: serviceDescriptor,
        }));
        writeFileSync(absPath(cwd, TeamPaths.manifest(teamName)), JSON.stringify({
            schema_version: 2,
            name: teamName,
            instance_id: TEAM_INSTANCE_ID,
            state_revision: 1,
            task: 'test',
            leader: { session_id: 'leader', worker_id: 'leader-fixed', role: 'leader' },
            policy: { display_mode: 'split_pane', worker_launch_mode: 'interactive', dispatch_mode: 'hook_preferred_with_fallback', dispatch_ack_timeout_ms: 15000 },
            governance: { delegation_only: false, plan_approval_required: false, nested_teams_allowed: false, one_team_per_leader_session: true, cleanup_requires_all_workers_inactive: true },
            permissions_snapshot: { approval_mode: 'default', sandbox_mode: 'workspace-write', network_access: false },
            tmux_session: `${teamName}:0`,
            worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, role: 'gemini', assigned_tasks: [], worker_cli: 'gemini' }],
            next_task_id: 1,
            created_at: new Date().toISOString(),
            leader_pane_id: '%0',
            service_descriptor: serviceDescriptor,
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, {
            operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'),
            teamName,
            workerName: 'worker-1',
            instanceId: TEAM_INSTANCE_ID,
        }, recoveryId);
        paneMocks.setPaneLiveness('%1', 'dead');
        paneMocks.setPaneLiveness('%2', 'alive');
        let bootstrapResult;
        let launchedPath = '';
        let expectedLaunchAttemptId = '';
        let launchAttemptForCleanup;
        paneMocks.spawnOwnedWorkerInPane.mockImplementationOnce(async (_sessionName, ownership, config) => {
            const attempt = await prepareWorkerLaunchAttempt({
                cwd: config.launchStateCwd,
                teamName: config.teamName,
                workerName: config.workerName,
                instanceId: config.instanceId,
                paneId: ownership.paneId,
                provider: config.provider,
                runtimeCliPath: config.launchBootstrapPath,
                context: config.launchContext,
            });
            launchAttemptForCleanup = attempt;
            const gateSpec = JSON.parse(config.envVars.OMC_RECOVERY_GATE_SPEC);
            launchedPath = `${gateSpec.runPath}.launched`;
            expectedLaunchAttemptId = attempt.attempt_id;
            expect(gateSpec).toMatchObject({
                recoveryId,
                workerName: 'worker-1',
                replacementGeneration: 2,
                paneAttemptId: config.launchContext?.pane_attempt_id,
            });
            expect(config.launchContext).toMatchObject({
                kind: 'recovery',
                recovery_id: recoveryId,
                replacement_generation: 2,
            });
            const launchEnv = {
                ...config.envVars,
                OMC_WORKER_LAUNCH_ATTEMPT_ID: attempt.attempt_id,
            };
            launchEnv.OMC_RECOVERY_GATE_SPEC = JSON.stringify({
                ...gateSpec,
                launchAttempt: attempt,
            });
            const transport = await materializeWorkerLaunchTransport({
                attempt,
                providerArgv: [config.launchBinary, ...config.launchArgs],
                cwd: config.cwd,
                providerEnv: launchEnv,
                releaseAfterSpawn: true,
                windowsDelivery: false,
            });
            const bootstrapSpec = await readAndConsumeWorkerLaunchDescriptor(transport.bootstrapDescriptorPath);
            bootstrapResult = runWorkerLaunchBootstrap(bootstrapSpec);
            const accepted = await awaitWorkerLaunchAcknowledgement(attempt, {
                timeoutMs: 2_000,
                pollIntervalMs: 5,
            });
            if (!accepted.ok)
                throw new Error(`launch acknowledgement failed: ${accepted.reason}`);
            await expect(awaitWorkerLaunchProviderStarted(attempt, { timeoutMs: 10_000, pollIntervalMs: 5 }))
                .resolves.toBe(true);
            return { ownership, provider: config.provider, attempt };
        });
        try {
            await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
                .resolves.toMatchObject({ outcome: 'recovered', committed: true, recoveryId });
            expect(bootstrapResult).toBeDefined();
            expect(existsSync(launchedPath)).toBe(true);
            expect(JSON.parse(readFileSync(launchedPath, 'utf8'))).toMatchObject({
                recovery_id: recoveryId,
                worker_name: 'worker-1',
                replacement_generation: 2,
                launch_attempt_id: expectedLaunchAttemptId,
            });
            expect(readFileSync(providerObservedPath, 'utf8')).toContain('Recovery completed for this idle worker.');
            expect(readFileSync(providerObservedPath, 'utf8')).not.toContain('STALE PRE-RECOVERY INBOX');
            const followupRequestId = 'idle-gemini-followup-request';
            const followupRecoveryId = 'idle-gemini-followup-recovery';
            reserveRecoveryRequest(cwd, followupRequestId, {
                operation: 'recover-worker',
                workspaceHash: createHash('sha256').update(cwd).digest('hex'),
                teamName,
                workerName: 'worker-1',
                instanceId: TEAM_INSTANCE_ID,
            }, followupRecoveryId);
            let lockTimeout;
            const followup = await Promise.race([
                executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: followupRequestId, instanceId: TEAM_INSTANCE_ID }),
                new Promise((_, reject) => {
                    lockTimeout = setTimeout(() => reject(new Error('recovery lock remained')), 2_000);
                }),
            ]);
            if (lockTimeout)
                clearTimeout(lockTimeout);
            expect(followup).toMatchObject({ outcome: 'already_running', committed: true, recoveryId: followupRecoveryId });
        }
        finally {
            writeFileSync(providerStopPath, 'stop');
            if (bootstrapResult) {
                await bootstrapResult.catch(() => ({ outcome: 'provider_spawn_failed' }));
            }
            if (launchAttemptForCleanup) {
                await retireWorkerLaunchAttempt(launchAttemptForCleanup, 'test_cleanup').catch(() => false);
            }
        }
        await expect(bootstrapResult).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
    });
    it('publishes durable orphan evidence when split succeeds without a parseable pane id', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-pane-unaddressable-'));
        const teamName = 'unaddressable-team';
        const requestId = 'unaddressable-request';
        const recoveryId = 'unaddressable-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        paneMocks.setPaneLiveness('%1', 'dead');
        paneMocks.splitTeamWorkerPaneWithEvidence.mockResolvedValueOnce({ commandSucceeded: true, provider: 'tmux',
            splitTarget: '%0', direction: 'right', rawOutput: 'not-a-pane\n', stderr: '', paneId: null,
            tmuxServerIdentity: fixtureTmuxServerIdentity() });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });
        expect(paneMocks.spawnWorkerInPane).not.toHaveBeenCalled();
        const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
        const evidenceFiles = readdirSync(evidenceRoot);
        expect(evidenceFiles).toHaveLength(1);
        const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles[0]), 'utf8'));
        expect(evidence).toMatchObject({ schema_version: 1, team_name: teamName, worker_name: 'worker-1',
            request_id: requestId, recovery_id: recoveryId, pane_id: null, reason: 'pane_identity_pane_id_missing',
            liveness: 'unknown', unaddressable: true,
            split: { commandSucceeded: true, provider: 'tmux', rawOutput: 'not-a-pane', paneId: null } });
        await expectRecoveryLockReleased(teamName, 'worker-1', 'unaddressable-split');
    });
    it('persists failed split stdout and stderr as durable recovery orphan evidence', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-pane-split-failed-'));
        const teamName = 'split-failed-team';
        const requestId = 'split-failed-request';
        const recoveryId = 'split-failed-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        paneMocks.setPaneLiveness('%1', 'dead');
        paneMocks.splitTeamWorkerPaneWithEvidence.mockResolvedValueOnce({ commandSucceeded: false, provider: 'tmux',
            splitTarget: '%0', direction: 'right', rawOutput: '%orphan\n', stderr: 'transport interrupted', paneId: null,
            tmuxServerIdentity: fixtureTmuxServerIdentity() });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });
        const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
        const evidenceFiles = readdirSync(evidenceRoot);
        expect(evidenceFiles).toHaveLength(1);
        const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles[0]), 'utf8'));
        expect(evidence).toMatchObject({ reason: 'pane_identity_split_failed', unaddressable: true,
            split: { commandSucceeded: false, provider: 'tmux', rawOutput: '%orphan', stderr: 'transport interrupted', paneId: null } });
    });
    it('records a valid recovery split that loses provider-target membership before activation', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-pane-membership-loss-'));
        const teamName = 'membership-loss-team';
        const requestId = 'membership-loss-request';
        const recoveryId = 'membership-loss-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%9',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        paneMocks.setPaneLiveness('%1', 'dead');
        paneMocks.blockPane('%10');
        paneMocks.splitTeamWorkerPaneWithEvidence.mockResolvedValueOnce({ commandSucceeded: true, provider: 'tmux',
            splitTarget: '%9', direction: 'right', rawOutput: '%10\n', stderr: '', paneId: '%10',
            tmuxServerIdentity: fixtureTmuxServerIdentity() });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'worker_activation_failed', recoveryId });
        expect(paneMocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
        expect(paneMocks.killTeamPane).not.toHaveBeenCalled();
        const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
        const evidenceFiles = readdirSync(evidenceRoot);
        expect(evidenceFiles).toHaveLength(1);
        const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles[0]), 'utf8'));
        expect(evidence).toMatchObject({ reason: 'pane_membership_unverified', unaddressable: true,
            split: { provider: 'tmux', paneId: '%10' } });
    });
    it('rejects a persisted provider descriptor whose validated path has changed', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-stale-provider-path-'));
        const teamName = 'stale-provider-team';
        const requestId = 'stale-provider-request';
        const recoveryId = 'stale-provider-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata,
                    launch_descriptor: { ...launchMetadata.launch_descriptor, binary: '/tmp/path-shadow/claude' },
                    pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%9',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        paneMocks.setPaneLiveness('%1', 'dead');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'launch_descriptor_unresolvable', recoveryId });
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).not.toHaveBeenCalled();
        expect(paneMocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
    });
    it('never launches or kills when recovery split aliases the leader pane', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-pane-leader-alias-'));
        const teamName = 'leader-alias-team';
        const requestId = 'leader-alias-request';
        const recoveryId = 'leader-alias-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        await reservePersistedTeamInstance(teamName, cwd);
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude',
            created_at: new Date().toISOString(),
            tmux_session: `${teamName}:0`,
            lifecycle_state: 'active',
            state_revision: 1,
            leader_pane_id: '%9',
        }));
        await activatePersistedTeamInstance(teamName, cwd);
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, {
            operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'),
            teamName,
            workerName: 'worker-1',
            instanceId: TEAM_INSTANCE_ID,
        }, recoveryId);
        paneMocks.setPaneLiveness('%1', 'dead');
        paneMocks.splitTeamWorkerPaneWithEvidence.mockResolvedValueOnce({
            commandSucceeded: true,
            provider: 'tmux',
            splitTarget: '%9',
            direction: 'right',
            rawOutput: '%9\n',
            stderr: '',
            paneId: '%9',
            tmuxServerIdentity: fixtureTmuxServerIdentity(),
        });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });
        expect(paneMocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
        expect(paneMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
        expect(paneMocks.killTeamPane).not.toHaveBeenCalled();
        const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
        const evidenceFiles = readdirSync(evidenceRoot);
        expect(evidenceFiles).toHaveLength(1);
        const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles[0]), 'utf8'));
        expect(evidence).toMatchObject({ reason: 'pane_identity_leader_alias', pane_id: null, unaddressable: true });
    });
});
//# sourceMappingURL=recovery-pane-rollback.test.js.map