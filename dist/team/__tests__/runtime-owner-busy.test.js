import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tmuxMocks = vi.hoisted(() => {
    const state = {
        paneDeadState: '0',
        serverIdentity: undefined,
        paneLiveness: new Map(),
    };
    return {
        tmuxExecAsync: vi.fn(async (args) => ({
            stdout: args.includes('list-panes') ? '%0\n%1\n%2\n%9\n%10\n' : '',
            stderr: '',
        })),
        tmuxCmdAsync: vi.fn(async (args) => ({
            stdout: args.includes('#{pid}') ? `${process.pid}\n` : `${state.paneDeadState}\n`,
            stderr: '',
        })),
        setPaneDeadState: (value) => { state.paneDeadState = value; },
        setServerIdentity: (value) => { state.serverIdentity = value; },
        setPaneLiveness: (paneId, value) => { state.paneLiveness.set(paneId, value); },
        clearPaneLiveness: () => { state.paneLiveness.clear(); },
        getOwnedWorkerLiveness: vi.fn(async (ownership) => state.paneLiveness.get(ownership.paneId) ?? 'unknown'),
        getWorkerLiveness: vi.fn(async (paneId) => state.paneLiveness.get(paneId) ?? 'unknown'),
        captureOwnedTeamPane: vi.fn(async () => ''),
        workerPaneBelongsToOwnedProviderTarget: vi.fn(async () => true),
        observeTmuxServerIdentity: vi.fn(async () => 'matching'),
        verifyTeamTargetOwnership: vi.fn(async (target) => ({
            kind: 'owned',
            provider: target.provider,
            providerTarget: target.providerTarget,
            recipient: 'worker',
            recipientRole: 'worker',
            paneId: target.paneId,
        })),
    };
});
vi.mock('../../cli/tmux-utils.js', () => tmuxMocks);
vi.mock('../tmux-session.js', async (importOriginal) => ({
    ...await importOriginal(),
    ...tmuxMocks,
}));
import { readRecoveryOutcome, reserveRecoveryRequest as persistRecoveryRequest } from '../recovery-request-store.js';
import { executeRecoverDeadWorkerV2Owner, recoverDeadWorkerV2, setRuntimeOwnerRecoveryClient, } from '../runtime-v2.js';
import { absPath, TeamPaths } from '../state-paths.js';
import { readRevisionedTeamConfig } from '../monitor.js';
import { currentProcessStartIdentity, currentStrictProcessStartIdentity, isProcessIdentityDead, isValidProcessStartIdentity, publishOwnerEpoch, readLatestOwnerEpoch } from '../team-owner-epoch.js';
import { reserveTeamInstance } from '../team-instance.js';
import { runRecoverySaga } from '../recovery-saga.js';
function reserveRecoveryRequest(cwd, requestId, payload, recoveryId) {
    persistFixtureAuthority(payload.teamName, cwd);
    return persistRecoveryRequest(cwd, requestId, payload, recoveryId);
}
const TEAM_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
function fixtureTmuxServerIdentity(cwd) {
    const processStartedAt = currentStrictProcessStartIdentity();
    if (!processStartedAt)
        throw new Error('fixture tmux process identity unavailable');
    const identity = { socket_path: join(cwd, '.omc-fixture-tmux.sock'), server_pid: process.pid, process_started_at: processStartedAt };
    tmuxMocks.setServerIdentity(identity);
    return identity;
}
function fixtureManifest(config, serverIdentity) {
    return {
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
        workers: Array.isArray(config.workers)
            ? config.workers.map((worker) => ({
                role: worker.role ?? worker.worker_cli ?? config.agent_type ?? 'worker',
                assigned_tasks: worker.assigned_tasks ?? [],
                ...worker,
            }))
            : [],
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
function persistFixtureAuthority(teamName, cwd) {
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    if (!existsSync(configPath))
        return;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const serverIdentity = fixtureTmuxServerIdentity(cwd);
    config.instance_id = config.instance_id ?? TEAM_INSTANCE_ID;
    config.tmux_server_identity = serverIdentity;
    config.leader_pane_id = /^%\d+$/.test(String(config.leader_pane_id ?? ''))
        ? config.leader_pane_id
        : '%0';
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(absPath(cwd, TeamPaths.manifest(teamName)), JSON.stringify(fixtureManifest(config, serverIdentity)));
}
async function reserveFixtureInstance(teamName, cwd, instanceId = TEAM_INSTANCE_ID) {
    await reserveTeamInstance({ teamName, cwd, instanceId });
}
const launchMetadata = { worker_cli: 'claude',
    launch_descriptor: { schema_version: 1, provider: 'claude', model: null,
        binary: '/usr/bin/claude', args: ['--dangerously-skip-permissions'] } };
let cwd;
let previousHome;
let previousUserProfile;
let previousOmcStateDir;
beforeEach(() => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousOmcStateDir = process.env.OMC_STATE_DIR;
});
function mkdtempFixture(prefix) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.OMC_STATE_DIR;
    return root;
}
function hostValidDeadProcessStartIdentity(pid) {
    const current = currentProcessStartIdentity();
    expect(current).not.toBeNull();
    expect(isValidProcessStartIdentity(current)).toBe(true);
    const darwin = /^darwin:([1-9]\d*):(\d+)$/.exec(current);
    const numeric = /^(linux|win32):([1-9]\d*)$/.exec(current);
    let dead;
    if (darwin) {
        const micros = Number(darwin[2]);
        dead = micros === 0
            ? `darwin:${Number(darwin[1]) + 1}:0`
            : `darwin:${darwin[1]}:${micros === 999_999 ? micros - 1 : micros + 1}`;
    }
    else if (numeric) {
        dead = `${numeric[1]}:${Number(numeric[2]) + 1}`;
    }
    else {
        const separator = current.indexOf(':');
        dead = `${current.slice(0, separator)}:${current.slice(separator + 1)}-different`;
    }
    expect(dead).not.toBe(current);
    expect(isValidProcessStartIdentity(dead)).toBe(true);
    expect(isProcessIdentityDead({ pid, process_started_at: dead })).toBe(true);
    return dead;
}
afterEach(() => {
    vi.clearAllMocks();
    tmuxMocks.setPaneDeadState('0');
    tmuxMocks.clearPaneLiveness();
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
describe('runtime owner team mutation contention', () => {
    it('returns team_mutation_busy without publishing a terminal final for the waiting recovery', async () => {
        cwd = mkdtempFixture('runtime-owner-busy-');
        const teamName = 'busy-team';
        await reserveFixtureInstance(teamName, cwd);
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            instance_id: TEAM_INSTANCE_ID,
            worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
            agent_type: 'claude',
            created_at: new Date().toISOString(),
            tmux_session: 'busy-team:0',
            lifecycle_state: 'active',
            state_revision: 3,
            active_recovery: {
                request_id: 'other-request', recovery_id: 'other-recovery', worker_name: 'worker-1',
                owner_epoch: 1, owner_nonce: 'other-owner', phase: 'active', state_revision: 3,
                created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            },
        }));
        reserveRecoveryRequest(cwd, 'waiting-request', { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'waiting-recovery');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'waiting-request', instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'team_mutation_busy', recoveryId: 'waiting-recovery' });
        expect(readRecoveryOutcome(cwd, 'waiting-request')).toBeNull();
    });
    it('keeps recovery transient while a durable scale-down reservation is active', async () => {
        cwd = mkdtempFixture('runtime-owner-scale-down-busy-');
        const teamName = 'scale-down-busy-team';
        await reserveFixtureInstance(teamName, cwd);
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        const now = new Date().toISOString();
        writeFileSync(configPath, JSON.stringify({
            name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 2,
            workers: [
                { name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 },
                { name: 'worker-2', index: 2, ...launchMetadata, pane_id: '%2', replacement_generation: 1 },
            ],
            agent_type: 'claude', created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 3,
            active_scale_down: { operation_id: 'scale-down-1', phase: 'draining', pid: 999999,
                process_started_at: 'linux:1', workers: [{ name: 'worker-2', pane_id: '%2' }],
                state_revision: 3, created_at: now, updated_at: now },
        }));
        reserveRecoveryRequest(cwd, 'scale-down-waiting-request', { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-2', instanceId: TEAM_INSTANCE_ID }, 'scale-down-waiting-recovery');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-2', requestId: 'scale-down-waiting-request', instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'team_mutation_busy', recoveryId: 'scale-down-waiting-recovery' });
        expect(readRecoveryOutcome(cwd, 'scale-down-waiting-request')).toBeNull();
    });
    it('rejects a stale recovery owner before publishing an epoch or active fence', async () => {
        cwd = mkdtempFixture('runtime-owner-stale-instance-');
        const teamName = 'stale-instance-team';
        await reserveFixtureInstance(teamName, cwd, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1' }],
            agent_type: 'claude',
            created_at: new Date().toISOString(),
            tmux_session: `${teamName}:0`,
            lifecycle_state: 'active',
            state_revision: 3,
        }));
        reserveRecoveryRequest(cwd, 'stale-instance-request', {
            operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'),
            teamName,
            workerName: 'worker-1',
            instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }, 'stale-instance-recovery');
        await expect(executeRecoverDeadWorkerV2Owner({
            teamName,
            cwd,
            workerName: 'worker-1',
            requestId: 'stale-instance-request',
            instanceId: TEAM_INSTANCE_ID,
        })).resolves.toMatchObject({
            outcome: 'failed',
            error: 'invalid_persisted_state',
            recoveryId: 'stale-instance-recovery',
        });
        expect(readLatestOwnerEpoch(cwd, teamName)).toBeNull();
        const staleConfig = await readRevisionedTeamConfig(teamName, cwd);
        expect(staleConfig?.config.instance_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        expect(staleConfig?.config.active_recovery).toBeUndefined();
    });
    it('retains an existing request ID instance when the same name now hosts a replacement', async () => {
        cwd = mkdtempFixture('runtime-owner-replay-instance-');
        const teamName = 'replay-instance-team';
        const replacementInstanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        await reserveFixtureInstance(teamName, cwd, replacementInstanceId);
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            instance_id: replacementInstanceId,
            worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1' }],
            agent_type: 'claude',
            created_at: new Date().toISOString(),
            tmux_session: `${teamName}:0`,
            lifecycle_state: 'active',
            state_revision: 1,
        }));
        const originalInstanceId = TEAM_INSTANCE_ID;
        reserveRecoveryRequest(cwd, 'replay-request', {
            operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'),
            teamName,
            workerName: 'worker-1',
            instanceId: originalInstanceId,
        }, 'replay-recovery');
        const request = vi.fn(async (input) => ({
            outcome: 'failed',
            committed: false,
            error: 'worker_liveness_unknown',
            requestId: 'replay-request',
            recoveryId: 'replay-recovery',
            teamName,
            workerName: 'worker-1',
            updatedAt: new Date().toISOString(),
            message: input.instanceId,
        }));
        setRuntimeOwnerRecoveryClient({ requestRuntimeOwnerRecovery: request });
        try {
            await recoverDeadWorkerV2(teamName, cwd, { workerName: 'worker-1', requestId: 'replay-request' });
            expect(request).toHaveBeenCalledWith(expect.objectContaining({ instanceId: originalInstanceId }));
        }
        finally {
            setRuntimeOwnerRecoveryClient(undefined);
        }
    });
    it('terminally rejects a persisted attempt secret with a mismatched durable identity tuple', async () => {
        cwd = mkdtempFixture('runtime-owner-attempt-secret-');
        const teamName = 'attempt-team';
        await reserveFixtureInstance(teamName, cwd);
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: 'attempt-team:0',
            lifecycle_state: 'active', state_revision: 3,
        }));
        reserveRecoveryRequest(cwd, 'attempt-request', { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'attempt-recovery');
        const attemptPath = absPath(cwd, TeamPaths.recoveryAttempt(teamName, 'attempt-recovery'));
        mkdirSync(join(attemptPath, '..'), { recursive: true });
        writeFileSync(attemptPath, JSON.stringify({ schema_version: 1, request_id: 'wrong-request',
            recovery_id: 'attempt-recovery', worker_name: 'worker-1', replacement_generation: 2,
            adoption_token: 'token', created_at: new Date().toISOString() }));
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'attempt-request', instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'invalid_persisted_state', recoveryId: 'attempt-recovery' });
        expect(readRecoveryOutcome(cwd, 'attempt-request')).toMatchObject({ kind: 'final', outcome: 'failed',
            error: { code: 'invalid_persisted_state' } });
    });
    it('rejects PID-reuse takeover when the active recovery belongs to a different attempt', async () => {
        cwd = mkdtempFixture('runtime-owner-pid-reuse-');
        const teamName = 'pid-reuse-team';
        await reserveFixtureInstance(teamName, cwd);
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1, workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1' }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: 'pid-reuse-team:0',
            lifecycle_state: 'active', state_revision: 3,
            active_recovery: { request_id: 'other-request', recovery_id: 'other-recovery', worker_name: 'worker-1',
                owner_epoch: 1, owner_nonce: 'reused-pid-owner', phase: 'active', state_revision: 3,
                created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        }));
        const processStartedAt = hostValidDeadProcessStartIdentity(process.pid);
        publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt, nonce: 'reused-pid-owner' });
        reserveRecoveryRequest(cwd, 'waiting-pid-request', { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'waiting-pid-recovery');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'waiting-pid-request', instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'runtime_owner_fence_lost' });
        const owner = readLatestOwnerEpoch(cwd, teamName);
        expect(owner).toMatchObject({ epoch: 1, pid: process.pid, process_started_at: processStartedAt });
        await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
            config: { active_recovery: { recovery_id: 'other-recovery', owner_epoch: 1 } },
        });
    });
    it('retains a committed pane on unknown liveness without spawning a duplicate replacement', async () => {
        cwd = mkdtempFixture('runtime-owner-unknown-committed-pane-');
        const teamName = 'committed-team';
        await reserveFixtureInstance(teamName, cwd);
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%9', pane_attempt_id: 'attempt-a',
                    recovery_id: 'committed-recovery', replacement_generation: 2 }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: 'committed-team:0',
            lifecycle_state: 'active', state_revision: 3,
            active_recovery: { request_id: 'committed-request', recovery_id: 'committed-recovery', worker_name: 'worker-1',
                owner_epoch: 1, owner_nonce: 'prior-owner', phase: 'active', state_revision: 3,
                created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        }));
        reserveRecoveryRequest(cwd, 'committed-request', { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'committed-recovery');
        const attemptPath = absPath(cwd, TeamPaths.recoveryAttempt(teamName, 'committed-recovery'));
        mkdirSync(join(attemptPath, '..'), { recursive: true });
        writeFileSync(attemptPath, JSON.stringify({ schema_version: 1, request_id: 'committed-request',
            recovery_id: 'committed-recovery', worker_name: 'worker-1', replacement_generation: 2,
            adoption_token: 'stable-token', created_at: new Date().toISOString() }));
        tmuxMocks.setPaneLiveness('%9', 'unknown');
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'committed-request', instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'worker_liveness_unknown', recoveryId: 'committed-recovery' });
        expect(tmuxMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
        expect(readRecoveryOutcome(cwd, 'committed-request')).toBeNull();
        await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
            config: { active_recovery: { recovery_id: 'committed-recovery' },
                workers: [{ pane_id: '%9', pane_attempt_id: 'attempt-a', replacement_generation: 2 }] },
        });
    });
    it.each(['alive', 'unknown', 'missing'])('rechecks %s original-pane liveness after election before replay effects', async (liveness) => {
        cwd = mkdtempFixture(`runtime-owner-precommit-${liveness}-`);
        const teamName = `precommit-${liveness}-team`;
        await reserveFixtureInstance(teamName, cwd);
        const requestId = `request-${liveness}`;
        const recoveryId = `recovery-${liveness}`;
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1,
                    ...(liveness === 'missing' ? {} : { pane_id: '%1' }) }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 3,
            active_recovery: { request_id: requestId, recovery_id: recoveryId, worker_name: 'worker-1',
                owner_epoch: 1, owner_nonce: 'prior-owner', phase: 'reserved', state_revision: 3,
                created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        }));
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        const attemptPath = absPath(cwd, TeamPaths.recoveryAttempt(teamName, recoveryId));
        mkdirSync(join(attemptPath, '..'), { recursive: true });
        writeFileSync(attemptPath, JSON.stringify({ schema_version: 1, request_id: requestId,
            recovery_id: recoveryId, worker_name: 'worker-1', replacement_generation: 2,
            adoption_token: 'stable-token', created_at: new Date().toISOString() }));
        const taskPath = absPath(cwd, TeamPaths.taskFile(teamName, '1'));
        if (liveness === 'missing') {
            mkdirSync(join(taskPath, '..'), { recursive: true });
            writeFileSync(taskPath, JSON.stringify({ id: '1', subject: 'owned task', description: 'must not requeue',
                status: 'in_progress', owner: 'worker-1', version: 1, blocked_by: [], created_at: new Date().toISOString() }));
        }
        tmuxMocks.setPaneDeadState(liveness === 'alive' ? '0' : liveness === 'unknown' ? 'unknown' : '1');
        if (liveness !== 'missing')
            tmuxMocks.setPaneLiveness('%1', liveness);
        const result = await executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID });
        expect(result).toMatchObject({ outcome: 'failed', error: 'worker_liveness_unknown', recoveryId });
        expect(tmuxMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
        const persisted = await readRevisionedTeamConfig(teamName, cwd);
        expect(readRecoveryOutcome(cwd, requestId)).toBeNull();
        expect(persisted?.config.active_recovery).toMatchObject({ recovery_id: recoveryId });
        if (liveness === 'missing') {
            const task = JSON.parse(readFileSync(taskPath, 'utf8'));
            expect(task).toMatchObject({ status: 'in_progress', owner: 'worker-1' });
            expect(task.recovery_reservation).toBeUndefined();
        }
    });
    it.each([
        ['launch_metadata_incomplete', undefined],
        ['launch_descriptor_unresolvable', { schema_version: 1, provider: 'claude', model: null, binary: 'claude', args: [] }],
    ])('rejects %s before recovery pane effects', async (expectedError, launchDescriptor) => {
        cwd = mkdtempFixture('runtime-owner-launch-metadata-');
        const teamName = launchDescriptor ? 'bad-descriptor' : 'missing-metadata';
        await reserveFixtureInstance(teamName, cwd);
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({ name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, worker_cli: 'claude', pane_id: '%1',
                    ...(launchDescriptor ? { launch_descriptor: launchDescriptor } : {}) }],
            agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
            lifecycle_state: 'active', state_revision: 3 }));
        const requestId = `request-${expectedError}`;
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, `recovery-${expectedError}`);
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: expectedError });
        expect(tmuxMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
    });
    it('allows recovery past a committed scale-up fence without team_mutation_busy', async () => {
        cwd = mkdtempFixture('runtime-owner-committed-scale-up-');
        const teamName = 'committed-scale-up-team';
        await reserveFixtureInstance(teamName, cwd);
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        const now = new Date().toISOString();
        writeFileSync(configPath, JSON.stringify({
            name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
            agent_type: 'claude', created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 3,
            // Durable post-commit fence after release write failure — reconcilable, non-blocking.
            active_scale_up: {
                operation_id: 'scale-up-committed-1', phase: 'committed', pid: 999999,
                process_started_at: 'linux:1', state_revision: 3, created_at: now, updated_at: now,
            },
        }));
        reserveRecoveryRequest(cwd, 'committed-scale-up-request', { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'committed-scale-up-recovery');
        const result = await executeRecoverDeadWorkerV2Owner({
            teamName, cwd, workerName: 'worker-1', requestId: 'committed-scale-up-request', instanceId: TEAM_INSTANCE_ID,
        });
        expect(result.recoveryId).toBe('committed-scale-up-recovery');
        // Recovery is allowed to proceed past the fence (may fail later for other reasons).
        if (result.outcome === 'failed') {
            expect(result.error).not.toBe('team_mutation_busy');
        }
        else {
            expect(['recovered', 'already_running']).toContain(result.outcome);
        }
    });
    it.each(['reserved', 'effects', 'failed'])('keeps recovery blocked while scale-up fence phase is %s', async (phase) => {
        cwd = mkdtempFixture(`runtime-owner-scale-up-${phase}-`);
        const teamName = `scale-up-${phase}-team`;
        await reserveFixtureInstance(teamName, cwd);
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        const now = new Date().toISOString();
        writeFileSync(configPath, JSON.stringify({
            name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
            agent_type: 'claude', created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 3,
            active_scale_up: {
                operation_id: `scale-up-${phase}-1`, phase, pid: 999999,
                process_started_at: 'linux:1', state_revision: 3, created_at: now, updated_at: now,
                ...(phase === 'failed' ? { failure_reason: 'test' } : {}),
            },
        }));
        const requestId = `scale-up-${phase}-request`;
        const recoveryId = `scale-up-${phase}-recovery`;
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
        await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
            .resolves.toMatchObject({ outcome: 'failed', error: 'team_mutation_busy', recoveryId });
        expect(readRecoveryOutcome(cwd, requestId)).toBeNull();
    });
    it('does not treat non-committed phase labels as committed even if other fields look durable', async () => {
        cwd = mkdtempFixture('runtime-owner-stale-scale-up-label-');
        const teamName = 'stale-scale-up-label-team';
        await reserveFixtureInstance(teamName, cwd);
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        const now = new Date().toISOString();
        writeFileSync(configPath, JSON.stringify({
            name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
            workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
            agent_type: 'claude', created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 3,
            // Foreign/stale-looking fence without the atomic committed phase proof.
            active_scale_up: {
                operation_id: 'foreign-op', phase: 'effects', pid: 1,
                process_started_at: 'linux:foreign', state_revision: 3, created_at: now, updated_at: now,
            },
        }));
        reserveRecoveryRequest(cwd, 'stale-label-request', { operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'stale-label-recovery');
        await expect(executeRecoverDeadWorkerV2Owner({
            teamName, cwd, workerName: 'worker-1', requestId: 'stale-label-request', instanceId: TEAM_INSTANCE_ID,
        })).resolves.toMatchObject({ outcome: 'failed', error: 'team_mutation_busy', recoveryId: 'stale-label-recovery' });
    });
    it('reconciles a live committed replacement through activation, adoption, services, and run publication', async () => {
        cwd = mkdtempFixture('runtime-owner-committed-replay-');
        const input = {
            requestId: 'committed-replay-request',
            recoveryId: 'committed-replay-recovery',
            teamName: 'committed-replay-team',
            workerName: 'worker-1',
            replacementGeneration: 2,
            adoptionToken: 'committed-replay-token',
            originalPaneId: '%old',
        };
        const task = {
            id: '1',
            status: 'in_progress',
            owner: 'worker-1',
            version: 3,
        };
        const activatePane = vi.fn(async () => ({ ok: true }));
        const adoptAll = vi.fn(async () => ({
            ok: true,
            continuations: [{
                    taskId: '1',
                    taskVersion: 3,
                    sequence: 7,
                    payload: { prompt: 'continue' },
                    claimToken: 'claim-token',
                }],
        }));
        const repairServices = vi.fn(async () => 'synced');
        const writeRun = vi.fn(async () => undefined);
        reserveRecoveryRequest(cwd, input.requestId, {
            operation: 'recover-worker',
            workspaceHash: createHash('sha256').update(cwd).digest('hex'),
            teamName: input.teamName,
            workerName: input.workerName,
            instanceId: TEAM_INSTANCE_ID,
        }, input.recoveryId);
        const result = await runRecoverySaga(input, {
            cwd,
            getLiveness: async () => 'alive',
            isCommittedReplacement: async () => true,
            listOwnedInProgressTasks: async () => [task],
            validateCheckpoint: async () => ({ ok: true, sequence: 7 }),
            requeue: async () => ({ ok: true, sequence: 7 }),
            spawnGatedPane: async () => ({
                ok: true,
                paneId: '%replacement',
                paneAttemptId: 'replacement-attempt',
                committed: true,
                stateRevision: 9,
                manifestSync: 'synced',
            }),
            activatePane,
            adoptAll,
            writeRun,
            persistActive: async () => ({ stateRevision: 9, manifestSync: 'synced' }),
            repairServices,
            killAttemptPane: async () => undefined,
        });
        expect(result).toMatchObject({
            outcome: 'recovered',
            oldPaneId: '%old',
            newPaneId: '%replacement',
            activation: 'active',
            servicesSync: 'synced',
        });
        expect(activatePane).toHaveBeenCalledWith(input, 'replacement-attempt');
        expect(adoptAll).toHaveBeenCalledWith(input, expect.objectContaining({ recoveryId: input.recoveryId }), ['1']);
        expect(repairServices).toHaveBeenCalledWith(input);
        expect(writeRun).toHaveBeenCalledWith(input, 'replacement-attempt', expect.any(Array));
    });
});
//# sourceMappingURL=runtime-owner-busy.test.js.map