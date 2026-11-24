import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isProcessAlive } from '../../platform/process-utils.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { resolveRuntimeCliPath } from '../runtime-owner-client.js';
import { assertTeamInstanceUnderLock, reserveTeamInstance, withTeamInstanceLifecycleLock } from '../team-instance.js';
import { createHash } from 'node:crypto';
import { readRecoveryFinalState, reserveRecoveryRequest } from '../recovery-request-store.js';
import { readRevisionedTeamConfig, saveTeamConfigAtRevision } from '../monitor.js';
import { publishOwnerEpoch } from '../team-owner-epoch.js';
import { awaitWorkerLaunchAcknowledgement, awaitWorkerLaunchProviderStarted, buildWorkerLaunchBootstrapSpec, prepareWorkerLaunchAttempt, runWorkerLaunchBootstrap, terminateWorkerLaunchProvider, withWorkerLaunchAttemptFence } from '../worker-launch-ack.js';
const tmuxUtilsMocks = vi.hoisted(() => ({
    tmuxExecAsync: vi.fn(),
    tmuxCmdAsync: vi.fn(),
}));
const tmuxSessionMocks = vi.hoisted(() => ({
    observeTmuxServerIdentity: vi.fn(async () => 'matching'),
    getOwnedWorkerLiveness: vi.fn(async () => 'dead'),
    observeTeamSessionTargetPresence: vi.fn(async () => ({ kind: 'owned' })),
    workerPaneBelongsToOwnedProviderTarget: vi.fn(async () => true),
    killOwnedWorkerPane: vi.fn(async () => undefined),
    killTeamSession: vi.fn(async () => true),
}));
const tmuxCalls = vi.hoisted(() => []);
const TEAM_INSTANCE_ID = '44444444-4444-4444-8444-444444444444';
const FIXTURE_TMUX_SERVER_IDENTITY = {
    socket_path: '/tmp/omc-test-tmux.sock',
    server_pid: 4242,
    process_started_at: process.platform === 'darwin'
        ? 'darwin:1700000000:123456'
        : 'linux:01234567-89ab-cdef-0123-456789abcdef:424242',
};
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        tmuxExecAsync: tmuxUtilsMocks.tmuxExecAsync,
        tmuxCmdAsync: tmuxUtilsMocks.tmuxCmdAsync,
    };
});
vi.mock('../tmux-session.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        observeTmuxServerIdentity: tmuxSessionMocks.observeTmuxServerIdentity,
        getOwnedWorkerLiveness: tmuxSessionMocks.getOwnedWorkerLiveness,
        observeTeamSessionTargetPresence: tmuxSessionMocks.observeTeamSessionTargetPresence,
        workerPaneBelongsToOwnedProviderTarget: tmuxSessionMocks.workerPaneBelongsToOwnedProviderTarget,
        killOwnedWorkerPane: tmuxSessionMocks.killOwnedWorkerPane,
        killTeamSession: tmuxSessionMocks.killTeamSession,
    };
});
async function writeJson(cwd, relativePath, value) {
    const fullPath = isAbsolute(relativePath) ? relativePath : join(cwd, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, JSON.stringify(value, null, 2), 'utf-8');
}
describe('shutdownTeamV2 split-pane pane cleanup', () => {
    let cwd = '';
    let originalHome;
    let originalUserProfile;
    let originalStateDir;
    beforeEach(async () => {
        originalHome = process.env.HOME;
        originalUserProfile = process.env.USERPROFILE;
        originalStateDir = process.env.OMC_STATE_DIR;
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-pane-cleanup-'));
        process.env.HOME = cwd;
        process.env.USERPROFILE = cwd;
        delete process.env.OMC_STATE_DIR;
        tmuxCalls.length = 0;
        tmuxUtilsMocks.tmuxExecAsync.mockReset();
        tmuxUtilsMocks.tmuxCmdAsync.mockReset();
        tmuxSessionMocks.observeTmuxServerIdentity.mockReset();
        tmuxSessionMocks.observeTmuxServerIdentity.mockResolvedValue('matching');
        tmuxSessionMocks.getOwnedWorkerLiveness.mockReset();
        tmuxSessionMocks.getOwnedWorkerLiveness.mockResolvedValue('dead');
        tmuxSessionMocks.observeTeamSessionTargetPresence.mockReset();
        tmuxSessionMocks.observeTeamSessionTargetPresence.mockResolvedValue({ kind: 'owned' });
        tmuxSessionMocks.workerPaneBelongsToOwnedProviderTarget.mockReset();
        tmuxSessionMocks.workerPaneBelongsToOwnedProviderTarget.mockResolvedValue(true);
        tmuxSessionMocks.killOwnedWorkerPane.mockReset();
        tmuxSessionMocks.killOwnedWorkerPane.mockImplementation(async () => undefined);
        tmuxSessionMocks.killTeamSession.mockReset();
        tmuxSessionMocks.killTeamSession.mockResolvedValue(true);
        const run = (args) => {
            tmuxCalls.push(args);
            let stdout = '';
            if (args[0] === 'list-panes') {
                stdout = '%1\n%2\n%3\n';
            }
            else if (args[0] === 'display-message' && args.includes('#{pane_dead}')) {
                stdout = '1\n';
            }
            return { stdout, stderr: '' };
        };
        tmuxUtilsMocks.tmuxExecAsync.mockImplementation(async (args) => run(args));
        tmuxUtilsMocks.tmuxCmdAsync.mockImplementation(async (args) => run(args));
    });
    afterEach(async () => {
        tmuxCalls.length = 0;
        tmuxUtilsMocks.tmuxExecAsync.mockReset();
        tmuxUtilsMocks.tmuxCmdAsync.mockReset();
        if (originalHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = originalHome;
        if (originalUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = originalUserProfile;
        if (originalStateDir === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = originalStateDir;
        if (cwd) {
            await rm(cwd, { recursive: true, force: true });
            cwd = '';
        }
    });
    it('preserves the owned pane and state when provider launch identity is missing', async () => {
        const teamName = 'pane-cleanup-team';
        await reserveTeamInstance({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });
        const teamRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);
        await writeJson(cwd, `${teamRoot}/config.json`, {
            name: teamName,
            instance_id: TEAM_INSTANCE_ID,
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 2,
            max_workers: 20,
            workers: [
                { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%2' },
                { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [] },
            ],
            created_at: new Date().toISOString(),
            tmux_session: 'leader-session:0',
            tmux_server_identity: FIXTURE_TMUX_SERVER_IDENTITY,
            tmux_window_owned: false,
            next_task_id: 1,
            leader_pane_id: '%1',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        });
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await expect(shutdownTeamV2(teamName, cwd, { timeoutMs: 0 })).resolves.toMatchObject({
            outcome: 'preserved',
        });
        const killPaneTargets = tmuxCalls
            .filter((args) => args[0] === 'kill-pane')
            .map((args) => args[2]);
        expect(killPaneTargets).toEqual([]);
        expect(tmuxCalls.some(args => args[0] === 'kill-window' || args[0] === 'kill-session')).toBe(false);
        await expect(readFile(join(teamRoot, 'config.json'), 'utf-8')).resolves.toContain('pane-cleanup-team');
    });
    it('retires and terminates the exact provider while accepting a proven-dead pane', async () => {
        const teamName = 'provider-cleanup-team';
        await reserveTeamInstance({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });
        const teamRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);
        let attempt;
        let bootstrap;
        let startedRecord;
        try {
            attempt = await prepareWorkerLaunchAttempt({ cwd, teamName, workerName: 'worker-1', paneId: '%2',
                instanceId: TEAM_INSTANCE_ID, provider: 'claude', runtimeCliPath: resolveRuntimeCliPath(), context: { kind: 'initial' } });
            bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(attempt, [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd));
            await expect(awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
                .resolves.toEqual({ ok: true });
            await expect(awaitWorkerLaunchProviderStarted(attempt, { timeoutMs: 10_000, pollIntervalMs: 5 }))
                .resolves.toBe(true);
            startedRecord = JSON.parse(await readFile(attempt.startedPath, 'utf-8'));
            const providerPid = startedRecord.pid;
            // Publication precedes the bootstrap's final handoff checks. Wait for
            // its fence to be released before testing shutdown of a running launch.
            await expect(withWorkerLaunchAttemptFence(attempt, async () => isProcessAlive(providerPid)))
                .resolves.toEqual({ ok: true, value: true });
            await writeJson(cwd, `${teamRoot}/config.json`, {
                name: teamName, instance_id: TEAM_INSTANCE_ID, task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive', worker_count: 1, max_workers: 20,
                workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%2',
                        worker_cli: 'claude', launch_attempt_id: attempt.attempt_id,
                        launch_descriptor: { schema_version: 1, provider: 'claude', model: null, binary: process.execPath, args: [] } }],
                created_at: new Date().toISOString(), tmux_session: 'leader-session:0',
                tmux_server_identity: FIXTURE_TMUX_SERVER_IDENTITY, tmux_window_owned: false,
                next_task_id: 1, leader_pane_id: '%1', hud_pane_id: null, resize_hook_name: null, resize_hook_target: null,
            });
            const { shutdownTeamV2 } = await import('../runtime-v2.js');
            await shutdownTeamV2(teamName, cwd, { timeoutMs: 0, force: true });
            const bootstrapResult = await bootstrap;
            expect(bootstrapResult, JSON.stringify(bootstrapResult)).toMatchObject({ outcome: 'ran' });
            expect(isProcessAlive(providerPid)).toBe(false);
            expect(tmuxCalls.some(args => args[0] === 'kill-pane' && args[2] === '%2')).toBe(false);
            await expect(readFile(join(teamRoot, 'config.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
        }
        finally {
            if (attempt && !startedRecord) {
                const started = await awaitWorkerLaunchProviderStarted(attempt, { timeoutMs: 2_000, pollIntervalMs: 5 })
                    .then(async (present) => present ? JSON.parse(await readFile(attempt.startedPath, 'utf8')) : undefined)
                    .catch(() => undefined);
                if (started)
                    startedRecord = started;
            }
            if (attempt)
                await terminateWorkerLaunchProvider(attempt, 2_000).catch(() => false);
            if (bootstrap)
                await bootstrap.catch(() => undefined);
            if (startedRecord) {
                await vi.waitFor(() => {
                    expect(isProcessAlive(startedRecord.pid)).toBe(false);
                    if (startedRecord.process_group_id !== undefined) {
                        expect(() => process.kill(-startedRecord.process_group_id, 0))
                            .toThrow(expect.objectContaining({ code: 'ESRCH' }));
                    }
                }, { timeout: 2_000, interval: 20 });
            }
        }
    });
    async function seedSavedRecoveryTimeout(teamName) {
        await reserveTeamInstance({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });
        const teamRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);
        const now = new Date().toISOString();
        await writeJson(cwd, `${teamRoot}/config.json`, {
            name: teamName, instance_id: TEAM_INSTANCE_ID, task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
            worker_count: 1, max_workers: 20, workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
            created_at: now, tmux_session: 'leader-session:0', tmux_server_identity: FIXTURE_TMUX_SERVER_IDENTITY,
            tmux_window_owned: false, next_task_id: 1, leader_pane_id: '%1', hud_pane_id: null, resize_hook_name: null,
            resize_hook_target: null, lifecycle_state: 'active', state_revision: 3,
            runtime_owner_epoch: { epoch: 1, nonce: 'dead-owner', pid: 2_147_483_647, process_started_at: FIXTURE_TMUX_SERVER_IDENTITY.process_started_at, created_at: now },
            active_recovery: { request_id: 'saved-request', recovery_id: 'saved-recovery', worker_name: 'worker-1', owner_epoch: 1,
                owner_nonce: 'dead-owner', phase: 'reserved', state_revision: 3, created_at: now, updated_at: now },
        });
        reserveRecoveryRequest(cwd, 'saved-request', { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'saved-recovery');
        const { finalizeRecoveryOwnerResult } = await import('../runtime-v2.js');
        // The owner saves the timeout to config and dies before publishing the final.
        await finalizeRecoveryOwnerResult({ teamName, cwd, workerName: 'worker-1', requestId: 'saved-request', instanceId: TEAM_INSTANCE_ID }, 'saved-recovery', { outcome: 'failed', committed: false, error: 'recovery_request_timeout',
            message: 'Recovery owner deadline exceeded: no attempt finished within 300000 ms of admission.',
            requestId: 'saved-request', recoveryId: 'saved-recovery', teamName, workerName: 'worker-1', updatedAt: now }, {
            readRevisionedConfig: readRevisionedTeamConfig,
            saveConfigAtRevision: saveTeamConfigAtRevision,
            publishFinal: () => { throw new Error('owner died'); },
        });
        expect((await readRevisionedTeamConfig(teamName, cwd))?.config.last_recovery).toMatchObject({ phase: 'failed' });
        expect(readRecoveryFinalState(cwd, 'saved-request').kind).toBe('missing');
        return teamRoot;
    }
    it('publishes a saved recovery timeout final before shutdown disposes the team state', async () => {
        const teamName = 'saved-timeout-team';
        const teamRoot = await seedSavedRecoveryTimeout(teamName);
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await expect(shutdownTeamV2(teamName, cwd, { timeoutMs: 0, force: true })).resolves.toMatchObject({ outcome: 'cleaned' });
        await expect(readFile(join(teamRoot, 'config.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(readRecoveryFinalState(cwd, 'saved-request')).toMatchObject({ kind: 'valid',
            final: { outcome: 'failed', error: { code: 'recovery_request_timeout' } } });
    });
    // chmod cannot deny writes on Windows or to root.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps the team state when shutdown cannot publish a saved recovery timeout final', async () => {
        const teamName = 'saved-timeout-team';
        const teamRoot = await seedSavedRecoveryTimeout(teamName);
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        const byRequest = join(getOmcRoot(cwd), 'state', 'team-recovery', 'by-request');
        const instance = { teamName, cwd, instanceId: TEAM_INSTANCE_ID };
        await chmod(byRequest, 0o555);
        try {
            await expect(shutdownTeamV2(teamName, cwd, { timeoutMs: 0, force: true })).resolves.toEqual({
                outcome: 'failed', reason: 'state_cleanup_failed', detail: 'recovery_final_unpublished:saved-recovery'
            });
        }
        finally {
            await chmod(byRequest, 0o755);
        }
        const retained = await readRevisionedTeamConfig(teamName, cwd);
        expect(retained?.config).toMatchObject({ lifecycle_state: 'stopped',
            last_recovery: { recovery_id: 'saved-recovery', failure_reason: 'recovery_request_timeout' } });
        await expect(withTeamInstanceLifecycleLock(cwd, teamName, () => assertTeamInstanceUnderLock(instance)))
            .resolves.toMatchObject({ observed_state: 'bound' });
        expect(readRecoveryFinalState(cwd, 'saved-request').kind).toBe('missing');
        await expect(shutdownTeamV2(teamName, cwd, { timeoutMs: 0, force: true })).resolves.toMatchObject({ outcome: 'cleaned' });
        await expect(readFile(join(teamRoot, 'config.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(readRecoveryFinalState(cwd, 'saved-request')).toMatchObject({ kind: 'valid',
            final: { outcome: 'failed', error: { code: 'recovery_request_timeout' } } });
    });
    // One live owner drains two overdue recoveries for different workers. The
    // first saves its timeout to config, then its final publication fails.
    async function seedTimeoutThenQueuedRecovery(teamName) {
        await reserveTeamInstance({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });
        const teamRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);
        const now = new Date().toISOString();
        const owner = publishOwnerEpoch(cwd, teamName, 1);
        await writeJson(cwd, `${teamRoot}/config.json`, {
            name: teamName, instance_id: TEAM_INSTANCE_ID, task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
            worker_count: 1, max_workers: 20, workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
            created_at: now, tmux_session: 'leader-session:0', tmux_server_identity: FIXTURE_TMUX_SERVER_IDENTITY,
            tmux_window_owned: false, next_task_id: 1, leader_pane_id: '%1', hud_pane_id: null, resize_hook_name: null,
            resize_hook_target: null, lifecycle_state: 'active', state_revision: 3, runtime_owner_epoch: owner,
            active_recovery: { request_id: 'first-request', recovery_id: 'first-recovery', worker_name: 'worker-1', owner_epoch: 1,
                owner_nonce: owner.nonce, phase: 'reserved', state_revision: 3, created_at: now, updated_at: now },
        });
        const workspaceHash = createHash('sha256').update(cwd).digest('hex');
        reserveRecoveryRequest(cwd, 'first-request', { operation: 'recover-worker', workspaceHash, teamName,
            workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'first-recovery');
        reserveRecoveryRequest(cwd, 'second-request', { operation: 'recover-worker', workspaceHash, teamName,
            workerName: 'worker-2', instanceId: TEAM_INSTANCE_ID }, 'second-recovery');
        const { finalizeRecoveryOwnerResult } = await import('../runtime-v2.js');
        await finalizeRecoveryOwnerResult({ teamName, cwd, workerName: 'worker-1', requestId: 'first-request', instanceId: TEAM_INSTANCE_ID }, 'first-recovery', { outcome: 'failed', committed: false, error: 'recovery_request_timeout',
            message: 'Recovery owner deadline exceeded: no attempt finished within 300000 ms of admission.',
            requestId: 'first-request', recoveryId: 'first-recovery', teamName, workerName: 'worker-1', updatedAt: now }, {
            readRevisionedConfig: readRevisionedTeamConfig,
            saveConfigAtRevision: saveTeamConfigAtRevision,
            publishFinal: () => { throw new Error('final publication failed'); },
        });
        expect((await readRevisionedTeamConfig(teamName, cwd))?.config.last_recovery).toMatchObject({ recovery_id: 'first-recovery' });
        expect(readRecoveryFinalState(cwd, 'first-request').kind).toBe('missing');
        return teamRoot;
    }
    it('publishes a saved recovery timeout before the next recovery replaces it, so shutdown keeps its final', async () => {
        const teamName = 'replaced-timeout-team';
        await seedTimeoutThenQueuedRecovery(teamName);
        const { executeRecoverDeadWorkerV2Owner, shutdownTeamV2 } = await import('../runtime-v2.js');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-2', requestId: 'second-request',
            instanceId: TEAM_INSTANCE_ID })).resolves.toMatchObject({ outcome: 'failed', error: 'worker_not_found' });
        await expect(shutdownTeamV2(teamName, cwd, { timeoutMs: 0, force: true })).resolves.toMatchObject({ outcome: 'cleaned' });
        expect(readRecoveryFinalState(cwd, 'first-request')).toMatchObject({ kind: 'valid',
            final: { outcome: 'failed', error: { code: 'recovery_request_timeout' } } });
        expect(readRecoveryFinalState(cwd, 'second-request')).toMatchObject({ kind: 'valid',
            final: { outcome: 'failed', error: { code: 'worker_not_found' } } });
    });
    // chmod cannot deny writes on Windows or to root.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps the saved recovery timeout in config while its final cannot be published', async () => {
        const teamName = 'blocked-timeout-team';
        await seedTimeoutThenQueuedRecovery(teamName);
        const { executeRecoverDeadWorkerV2Owner } = await import('../runtime-v2.js');
        const byRequest = join(getOmcRoot(cwd), 'state', 'team-recovery', 'by-request');
        const second = { teamName, cwd, workerName: 'worker-2', requestId: 'second-request', instanceId: TEAM_INSTANCE_ID };
        await chmod(byRequest, 0o555);
        try {
            await expect(executeRecoverDeadWorkerV2Owner(second)).resolves.toMatchObject({ outcome: 'failed',
                error: 'runtime_owner_unavailable' });
        }
        finally {
            await chmod(byRequest, 0o755);
        }
        expect((await readRevisionedTeamConfig(teamName, cwd))?.config).toMatchObject({
            last_recovery: { recovery_id: 'first-recovery', failure_reason: 'recovery_request_timeout' }
        });
        expect((await readRevisionedTeamConfig(teamName, cwd))?.config.active_recovery).toBeUndefined();
        await expect(executeRecoverDeadWorkerV2Owner(second)).resolves.toMatchObject({ outcome: 'failed', error: 'worker_not_found' });
        expect(readRecoveryFinalState(cwd, 'first-request')).toMatchObject({ kind: 'valid',
            final: { outcome: 'failed', error: { code: 'recovery_request_timeout' } } });
    });
});
//# sourceMappingURL=runtime-v2.shutdown-pane-cleanup.test.js.map