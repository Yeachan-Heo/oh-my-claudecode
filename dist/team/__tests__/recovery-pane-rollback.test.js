import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive } from '../../platform/process-utils.js';
const paneMocks = vi.hoisted(() => ({
    getWorkerLiveness: vi.fn(),
    splitTeamWorkerPane: vi.fn(async () => '%2'),
    splitTeamWorkerPaneWithEvidence: vi.fn(async () => ({ commandSucceeded: true, provider: 'tmux',
        splitTarget: '%leader', direction: 'right', rawOutput: '%2\n', stderr: '', paneId: '%2' })),
    spawnWorkerInPane: vi.fn(async (_sessionName, _paneId, _config) => { throw new Error('spawn failed --api-key SUPERSECRET after pane creation'); }),
    spawnOwnedWorkerInPane: vi.fn(),
    killTeamPane: vi.fn(async (_paneId) => { throw new Error('pane still alive'); }),
    killOwnedWorkerPane: vi.fn(),
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
        },
    })),
}));
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => ({
    ...await importOriginal(),
    tmuxExecAsync: vi.fn(async () => ({ stdout: '', stderr: '' })),
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
import { reserveRecoveryRequest } from '../recovery-request-store.js';
import { executeRecoverDeadWorkerV2Owner } from '../runtime-v2.js';
import { runWorkerActivationGate } from '../worker-activation-gate.js';
import { absPath, TeamPaths } from '../state-paths.js';
import { awaitWorkerLaunchAcknowledgement, awaitWorkerLaunchProviderStarted, buildWorkerLaunchBootstrapSpec, prepareWorkerLaunchAttempt, loadCurrentWorkerLaunchAttempt, runWorkerLaunchBootstrap, retireWorkerLaunchAttempt, terminateWorkerLaunchProvider, } from '../worker-launch-ack.js';
const launchMetadata = { worker_cli: 'claude',
    launch_descriptor: { schema_version: 1, provider: 'claude', model: null,
        binary: '/bin/echo', args: [] } };
let cwd = '';
afterEach(() => {
    vi.clearAllMocks();
    if (cwd)
        rmSync(cwd, { recursive: true, force: true });
});
async function expectRecoveryLockReleased(teamName, workerName, suffix) {
    const requestId = `${suffix}-followup-request`;
    const followupRecoveryId = `${suffix}-followup-recovery`;
    reserveRecoveryRequest(cwd, requestId, {
        operation: 'recover-worker',
        workspaceHash: createHash('sha256').update(cwd).digest('hex'),
        teamName,
        workerName,
    }, followupRecoveryId);
    let timeout;
    const followup = await Promise.race([
        executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName, requestId }),
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
        provider, runtimeCliPath: '/runtime-cli.cjs', context: { kind: 'initial' } });
    const expected = JSON.parse(readFileSync(attempt.expectedPath, 'utf8'));
    writeFileSync(attempt.ackPath, JSON.stringify({ ...expected, kind: 'worker_launch_ack', written_at: new Date().toISOString() }));
    await expect(awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 1_000, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
    writeFileSync(`${attempt.startedPath}.terminal`, JSON.stringify({ ...expected,
        kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
        pid: 999_999, process_start_identity: '1', written_at: new Date().toISOString() }));
    worker.pane_id = '%1';
    worker.launch_attempt_id = attempt.attempt_id;
    writeFileSync(configPath, JSON.stringify(config));
}
describe('recovery pane rollback evidence', () => {
    it('retains the attempt and publishes durable evidence when pane cleanup cannot be verified', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-pane-orphan-'));
        const teamName = 'orphan-team';
        const requestId = 'orphan-request';
        const recoveryId = 'orphan-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        const workerCwd = join(cwd, 'worker-worktree');
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
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
        paneMocks.getWorkerLiveness.mockResolvedValueOnce('dead').mockResolvedValue('alive');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).toHaveBeenCalled();
        expect(paneMocks.spawnWorkerInPane).toHaveBeenCalled();
        expect(paneMocks.spawnOwnedWorkerInPane).toHaveBeenCalledWith(`${teamName}:0`, expect.objectContaining({ paneId: '%2' }), expect.objectContaining({ cwd: workerCwd, launchStateCwd: cwd }));
        expect(paneMocks.killTeamPane).toHaveBeenCalledTimes(2);
        const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
        const evidenceFiles = readdirSync(evidenceRoot);
        expect(evidenceFiles).toHaveLength(1);
        const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles[0]), 'utf8'));
        expect(evidence).toMatchObject({ schema_version: 1, team_name: teamName, worker_name: 'worker-1',
            request_id: requestId, recovery_id: recoveryId, pane_id: '%2', reason: 'spawn failed --api-key=<redacted> after pane creation', liveness: 'alive' });
        await expectRecoveryLockReleased(teamName, 'worker-1', 'cleanup-failure');
    });
    it('reconciles an accepted initial launch pointer before treating the worker as already running', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'omc-recovery-initial-pointer-'));
        const teamName = 'initial-pointer-team';
        const requestId = 'initial-pointer-request';
        const recoveryId = 'initial-pointer-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
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
        reserveRecoveryRequest(cwd, requestId, {
            operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'),
            teamName,
            workerName: 'worker-1',
        }, recoveryId);
        const launchAttempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName,
            workerName: 'worker-1',
            paneId: '%9',
            provider: 'claude',
            runtimeCliPath: '/runtime-cli.cjs',
            context: { kind: 'initial' },
        });
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd));
        await awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 });
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, { timeoutMs: 10_000, pollIntervalMs: 5 })).resolves.toBe(true);
        await expect(loadCurrentWorkerLaunchAttempt({
            cwd,
            teamName,
            workerName: 'worker-1',
            provider: 'claude',
        })).resolves.toMatchObject({ attempt_id: launchAttempt.attempt_id, pane_id: '%9', context: { kind: 'initial' } });
        paneMocks.getWorkerLiveness.mockResolvedValue('alive');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
            .resolves.toMatchObject({ outcome: 'already_running', committed: true, newPaneId: '%9' });
        const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(persisted.workers[0]).toMatchObject({
            pane_id: '%9',
            launch_attempt_id: launchAttempt.attempt_id,
            operational_state: 'active',
        });
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).not.toHaveBeenCalled();
        await expect(retireWorkerLaunchAttempt(launchAttempt, 'test_cleanup')).resolves.toBe(true);
        await expect(terminateWorkerLaunchProvider(launchAttempt)).resolves.toBe(true);
        await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
    });
    it('cleans a pre-upgrade dead pane (descriptor+pane, no launch_attempt_id) and continues recovery', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-legacy-dead-pane-'));
        const teamName = 'legacy-dead-pane-team';
        const requestId = 'legacy-dead-pane-request';
        const recoveryId = 'legacy-dead-pane-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
        // Saga getLiveness + legacy cleanup both observe the pre-upgrade pane as dead.
        // Replacement pane (%2) is alive so spawn-failure cleanup publishes orphan evidence.
        paneMocks.getWorkerLiveness.mockImplementation(async (paneId) => (paneId === '%1' ? 'dead' : 'alive'));
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).toHaveBeenCalled();
        expect(paneMocks.spawnOwnedWorkerInPane).toHaveBeenCalled();
        // Dead pre-upgrade pane: no ownership kill required
        expect(paneMocks.adoptWorkerPaneOwnership).not.toHaveBeenCalledWith(expect.objectContaining({ paneId: '%1' }));
        const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(persisted.active_recovery).toMatchObject({ recovery_id: recoveryId, worker_name: 'worker-1' });
    });
    it('kills a live pre-upgrade owned pane before replacement when launch_attempt_id is absent', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-legacy-live-pane-'));
        const teamName = 'legacy-live-pane-team';
        const requestId = 'legacy-live-pane-request';
        const recoveryId = 'legacy-live-pane-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
        // Saga getLiveness must report dead (worker process dead) even if the pane shell is live.
        // Legacy cleanup then kills the live owned pane; replacement uses %2.
        let legacyKillCount = 0;
        paneMocks.getWorkerLiveness.mockImplementation(async (paneId) => {
            if (paneId === '%2')
                return 'alive';
            // First saga getLiveness uses originalPaneId=%1 — report dead so recovery proceeds.
            // Subsequent %1 checks after kill report dead; before kill report alive for cleanup path.
            // Order: saga getLiveness(%1)=dead, legacy cleanup(%1)=alive, post-kill(%1)=dead, ...
            return 'dead';
        });
        // Force the legacy cleanup branch to see a live pane by overriding only after saga starts.
        // Use a call counter: call0 saga=dead, call1+ for %1: first live then dead after kill.
        let call = 0;
        paneMocks.getWorkerLiveness.mockImplementation(async (paneId) => {
            if (paneId !== '%1')
                return 'alive';
            call += 1;
            if (call === 1)
                return 'dead'; // saga getLiveness: worker is dead
            if (legacyKillCount === 0)
                return 'alive'; // legacy cleanup sees live pane shell
            return 'dead'; // after kill
        });
        paneMocks.killOwnedWorkerPane.mockImplementation(async (ownership) => {
            if (ownership.paneId === '%1')
                legacyKillCount += 1;
            // Successful owned kill of the legacy pane — do not throw
        });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });
        expect(paneMocks.adoptWorkerPaneOwnership).toHaveBeenCalledWith(expect.objectContaining({
            paneId: '%1',
            leaderPaneId: '%leader',
            providerTarget: `${teamName}:0`,
        }));
        expect(paneMocks.killOwnedWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%1' }));
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).toHaveBeenCalled();
    });
    it('fail-closes legacy recovery when pane liveness is unknown', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-legacy-unknown-liveness-'));
        const teamName = 'legacy-unknown-liveness-team';
        const requestId = 'legacy-unknown-liveness-request';
        const recoveryId = 'legacy-unknown-liveness-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
        // Saga must see dead to enter spawnGatedPane; legacy cleanup then sees unknown.
        let call = 0;
        paneMocks.getWorkerLiveness.mockImplementation(async (paneId) => {
            if (paneId !== '%1')
                return 'alive';
            call += 1;
            return call === 1 ? 'dead' : 'unknown';
        });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'worker_cleanup_incomplete', recoveryId });
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).not.toHaveBeenCalled();
        expect(paneMocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
        expect(paneMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
        const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(persisted.workers[0].pane_id).toBe('%1');
        expect(persisted.active_recovery).toMatchObject({ recovery_id: recoveryId, worker_name: 'worker-1' });
    });
    it('fail-closes legacy recovery when ownership adoption is rejected (foreign/alias)', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-legacy-foreign-pane-'));
        const teamName = 'legacy-foreign-pane-team';
        const requestId = 'legacy-foreign-pane-request';
        const recoveryId = 'legacy-foreign-pane-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
        let call = 0;
        paneMocks.getWorkerLiveness.mockImplementation(async (paneId) => {
            if (paneId !== '%1')
                return 'alive';
            call += 1;
            return call === 1 ? 'dead' : 'alive';
        });
        paneMocks.adoptWorkerPaneOwnership.mockResolvedValueOnce({
            ok: false,
            reason: 'leader_alias',
        });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'worker_cleanup_incomplete', recoveryId });
        expect(paneMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
        expect(paneMocks.splitTeamWorkerPaneWithEvidence).not.toHaveBeenCalled();
        const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(persisted.workers[0].pane_id).toBe('%1');
    });
    it('fail-closes legacy recovery when owned pane kill cannot prove death', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-legacy-kill-fail-'));
        const teamName = 'legacy-kill-fail-team';
        const requestId = 'legacy-kill-fail-request';
        const recoveryId = 'legacy-kill-fail-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
        let call = 0;
        paneMocks.getWorkerLiveness.mockImplementation(async (paneId) => {
            if (paneId !== '%1')
                return 'alive';
            call += 1;
            return call === 1 ? 'dead' : 'alive'; // always alive after saga → kill cannot prove death
        });
        paneMocks.killOwnedWorkerPane.mockResolvedValue(undefined);
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
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
        const oldAttempt = await prepareWorkerLaunchAttempt({ cwd, teamName, workerName: 'worker-1', paneId: '%1',
            provider: 'claude', runtimeCliPath: '/runtime-cli.cjs', context: { kind: 'initial' } });
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(oldAttempt, [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd));
        await expect(awaitWorkerLaunchAcknowledgement(oldAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
            .resolves.toEqual({ ok: true });
        await expect(awaitWorkerLaunchProviderStarted(oldAttempt, { timeoutMs: 10_000, pollIntervalMs: 5 }))
            .resolves.toBe(true);
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
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
        paneMocks.getWorkerLiveness.mockResolvedValue('dead');
        paneMocks.splitTeamWorkerPaneWithEvidence.mockImplementationOnce(async () => {
            expect(isProcessAlive(oldPid)).toBe(false);
            return { commandSucceeded: true, provider: 'tmux', splitTarget: '%9', direction: 'right',
                rawOutput: '', stderr: '', paneId: null };
        });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
            .resolves.toMatchObject({ outcome: 'failed', recoveryId });
        await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
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
                        args: ['-e', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(providerObservedPath)},fs.readFileSync(${JSON.stringify(inboxPath)},'utf8'));setTimeout(()=>process.exit(0),5000)`],
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
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, {
            operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'),
            teamName,
            workerName: 'worker-1',
        }, recoveryId);
        paneMocks.getWorkerLiveness.mockResolvedValueOnce('dead').mockResolvedValue('alive');
        let bootstrapResult;
        let launchedPath = '';
        let expectedLaunchAttemptId = '';
        paneMocks.spawnOwnedWorkerInPane.mockImplementationOnce(async (_sessionName, ownership, config) => {
            const attempt = await prepareWorkerLaunchAttempt({
                cwd: config.launchStateCwd,
                teamName: config.teamName,
                workerName: config.workerName,
                paneId: ownership.paneId,
                provider: config.provider,
                runtimeCliPath: config.launchBootstrapPath,
                context: config.launchContext,
            });
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
            const expected = JSON.parse(readFileSync(attempt.expectedPath, 'utf8'));
            writeFileSync(attempt.ackPath, JSON.stringify({
                ...expected,
                kind: 'worker_launch_ack',
                written_at: new Date().toISOString(),
            }));
            const accepted = await awaitWorkerLaunchAcknowledgement(attempt, {
                timeoutMs: 2_000,
                pollIntervalMs: 5,
            });
            if (!accepted.ok)
                throw new Error(`launch acknowledgement failed: ${accepted.reason}`);
            bootstrapResult = runWorkerActivationGate({ ...gateSpec, launchAttempt: attempt });
            return { ownership, provider: config.provider, attempt };
        });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
            .resolves.toMatchObject({ outcome: 'recovered', committed: true, recoveryId });
        expect(bootstrapResult).toBeDefined();
        await expect(bootstrapResult).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
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
        }, followupRecoveryId);
        let lockTimeout;
        const followup = await Promise.race([
            executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: followupRequestId }),
            new Promise((_, reject) => {
                lockTimeout = setTimeout(() => reject(new Error('recovery lock remained held')), 2_000);
            }),
        ]);
        if (lockTimeout)
            clearTimeout(lockTimeout);
        expect(followup).toMatchObject({ outcome: 'already_running', committed: true, recoveryId: followupRecoveryId });
    });
    it('publishes durable orphan evidence when split succeeds without a parseable pane id', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'recovery-pane-unaddressable-'));
        const teamName = 'unaddressable-team';
        const requestId = 'unaddressable-request';
        const recoveryId = 'unaddressable-recovery';
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
        paneMocks.getWorkerLiveness.mockResolvedValue('dead');
        paneMocks.splitTeamWorkerPaneWithEvidence.mockResolvedValueOnce({ commandSucceeded: true, provider: 'tmux',
            splitTarget: '%leader', direction: 'right', rawOutput: 'not-a-pane\n', stderr: '', paneId: null });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
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
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
        }));
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
        paneMocks.getWorkerLiveness.mockResolvedValue('dead');
        paneMocks.splitTeamWorkerPaneWithEvidence.mockResolvedValueOnce({ commandSucceeded: false, provider: 'tmux',
            splitTarget: '%leader', direction: 'right', rawOutput: '%orphan\n', stderr: 'transport interrupted', paneId: null });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
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
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1, working_dir: cwd }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%9',
        }));
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
        paneMocks.getWorkerLiveness.mockResolvedValue('dead');
        paneMocks.workerPaneBelongsToProviderTarget
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        paneMocks.splitTeamWorkerPaneWithEvidence.mockResolvedValueOnce({ commandSucceeded: true, provider: 'tmux',
            splitTarget: '%9', direction: 'right', rawOutput: '%10\n', stderr: '', paneId: '%10' });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
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
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
        paneMocks.getWorkerLiveness.mockResolvedValue('dead');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
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
        await attachPersistedPriorLaunch(teamName, configPath);
        reserveRecoveryRequest(cwd, requestId, {
            operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'),
            teamName,
            workerName: 'worker-1',
        }, recoveryId);
        paneMocks.getWorkerLiveness.mockResolvedValue('dead');
        paneMocks.splitTeamWorkerPaneWithEvidence.mockResolvedValueOnce({
            commandSucceeded: true,
            provider: 'tmux',
            splitTarget: '%9',
            direction: 'right',
            rawOutput: '%9\n',
            stderr: '',
            paneId: '%9',
        });
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
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