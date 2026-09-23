import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync as createTempDir, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTeamApiOperation as executeSecondaryTeamApiOperation } from '../../cli/team.js';
import { executeTeamApiOperation } from '../api-interop.js';
import { readRecoveryOutcome, reserveRecoveryRequest, writeRecoveryFinal } from '../recovery-request-store.js';
import { readRecoverDeadWorkerV2Result as readRootRecoverDeadWorkerV2Result } from '../../index.js';
import { finalizeRecoveryOwnerResult, recoverDeadWorkerV2, readRecoverDeadWorkerV2Outcome, readRecoverDeadWorkerV2Result, setRuntimeOwnerRecoveryClient } from '../runtime-v2.js';
import { absPath, TeamPaths } from '../state-paths.js';
import { activateTeamInstanceUnderLock, createTeamInstanceBinding, reserveTeamInstanceUnderLock, withTeamInstanceLifecycleLock, } from '../team-instance.js';
const recovered = {
    outcome: 'recovered',
    committed: true,
    oldPaneId: '%1',
    newPaneId: '%2',
    requeuedTaskIds: ['1'],
    continuationSequenceByTask: { '1': 4 },
    stateRevision: 8,
    activation: 'active',
    manifestSync: 'synced',
    servicesSync: 'synced',
    warnings: [],
    requestId: 'request-a',
    recoveryId: 'recovery-a',
    teamName: 'recovery-team',
    workerName: 'worker-1',
    updatedAt: '2026-07-10T00:00:00.000Z',
};
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
async function seedTeamInstance(cwd, teamName = 'recovery-team') {
    const instance = createTeamInstanceBinding({ teamName, cwd });
    const teamRoot = instance.state_root;
    await withTeamInstanceLifecycleLock(instance.cwd, instance.team_name, async () => {
        await reserveTeamInstanceUnderLock({ teamName, cwd, instanceId: instance.instance_id });
        mkdirSync(teamRoot, { recursive: true });
        writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
            name: teamName,
            instance_id: instance.instance_id,
            leader_cwd: cwd,
            team_state_root: teamRoot,
            lifecycle_state: 'active',
            task: 'recovery test',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 1,
            max_workers: 20,
            workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
            created_at: new Date().toISOString(),
            tmux_session: `${teamName}:0`,
            next_task_id: 1,
            state_revision: 0,
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        }, null, 2));
        await activateTeamInstanceUnderLock(instance);
    });
    return { teamRoot, instanceId: instance.instance_id };
}
function recoveryPayload(cwd, teamName, instanceId) {
    return {
        operation: 'recover-worker',
        workspaceHash: createHash('sha256').update(cwd).digest('hex'),
        teamName,
        workerName: 'worker-1',
        instanceId,
    };
}
afterEach(() => {
    vi.useRealTimers();
    setRuntimeOwnerRecoveryClient(undefined);
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
describe('public dead-worker recovery facade', () => {
    it('classifies authoritative config independently of any manifest before dispatching recovery effects', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-state-'));
        try {
            await expect(recoverDeadWorkerV2('missing-team', cwd, {
                workerName: 'worker-1', requestId: 'missing-request', timeoutMs: 180_000,
            })).resolves.toMatchObject({ outcome: 'failed', committed: false, error: 'team_not_found' });
            const configPath = absPath(cwd, TeamPaths.config('legacy-team'));
            mkdirSync(join(configPath, '..'), { recursive: true });
            writeFileSync(configPath, JSON.stringify({ name: 'legacy-team', task: 'legacy', agent_type: 'claude',
                worker_launch_mode: 'interactive', worker_count: 0, max_workers: 20, workers: [],
                created_at: new Date().toISOString(), tmux_session: 'legacy-team:0', next_task_id: 1 }));
            await expect(executeTeamApiOperation('recover-worker', {
                team_name: 'legacy-team', worker: 'worker-1', request_id: 'legacy-request', timeout_ms: 180_000,
            }, cwd)).resolves.toMatchObject({ ok: true, data: { result: { outcome: 'failed', error: 'runtime_v2_required' } } });
            const malformedConfigPath = absPath(cwd, TeamPaths.config('malformed-team'));
            mkdirSync(join(malformedConfigPath, '..'), { recursive: true });
            writeFileSync(malformedConfigPath, '{"state_revision":');
            await expect(recoverDeadWorkerV2('malformed-team', cwd, {
                workerName: 'worker-1', requestId: 'malformed-request', timeoutMs: 180_000,
            })).resolves.toMatchObject({ outcome: 'failed', committed: false, error: 'invalid_persisted_state' });
            const malformedRevisionPath = absPath(cwd, TeamPaths.config('malformed-revision-team'));
            mkdirSync(join(malformedRevisionPath, '..'), { recursive: true });
            writeFileSync(malformedRevisionPath, JSON.stringify({ name: 'malformed-revision-team', state_revision: 'one' }));
            await expect(recoverDeadWorkerV2('malformed-revision-team', cwd, {
                workerName: 'worker-1', requestId: 'malformed-revision-request', timeoutMs: 180_000,
            })).resolves.toMatchObject({ outcome: 'failed', committed: false, error: 'invalid_persisted_state' });
            const manifestOnlyPath = absPath(cwd, TeamPaths.manifest('manifest-only-team'));
            mkdirSync(join(manifestOnlyPath, '..'), { recursive: true });
            writeFileSync(manifestOnlyPath, '{not authoritative config}');
            await expect(recoverDeadWorkerV2('manifest-only-team', cwd, {
                workerName: 'worker-1', requestId: 'manifest-only-request', timeoutMs: 180_000,
            })).resolves.toMatchObject({ outcome: 'failed', committed: false, error: 'team_not_found' });
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('preserves the exact package argument boundary and typed result', async () => {
        const requestRuntimeOwnerRecovery = vi.fn(async () => recovered);
        setRuntimeOwnerRecoveryClient({ requestRuntimeOwnerRecovery });
        const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-boundary-'));
        const { instanceId } = await seedTeamInstance(cwd);
        await expect(recoverDeadWorkerV2('recovery-team', cwd, {
            workerName: 'worker-1',
            requestId: 'request-a',
            timeoutMs: 180_000,
        })).resolves.toEqual(recovered);
        expect(requestRuntimeOwnerRecovery).toHaveBeenCalledWith({
            teamName: 'recovery-team',
            cwd,
            workerName: 'worker-1',
            requestId: 'request-a',
            instanceId,
            timeoutMs: 180_000,
        });
        rmSync(cwd, { recursive: true, force: true });
    });
    it('returns the exact typed invalid_input result and matching API envelopes for an invalid timeout', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
        const requestRuntimeOwnerRecovery = vi.fn(async () => recovered);
        setRuntimeOwnerRecoveryClient({ requestRuntimeOwnerRecovery });
        const expectedResult = {
            outcome: 'failed', committed: false, error: 'invalid_input', requestId: 'request-a', recoveryId: '',
            teamName: 'recovery-team', workerName: 'worker-1', updatedAt: '2026-07-10T12:00:00.000Z',
            message: 'cwd, workerName, and requestId are required; timeoutMs must be an integer from 180000 through 300000.',
        };
        await expect(recoverDeadWorkerV2('recovery-team', '/workspace', {
            workerName: 'worker-1', requestId: 'request-a', timeoutMs: 1_000,
        })).resolves.toEqual(expectedResult);
        await expect(recoverDeadWorkerV2('recovery-team', '/workspace', {
            workerName: 'worker-1', requestId: '../../../../tmp/owned', timeoutMs: 180_000,
        })).resolves.toMatchObject({ outcome: 'failed', error: 'invalid_input' });
        await expect(recoverDeadWorkerV2('recovery-team', '/workspace', {
            workerName: '../worker', requestId: 'request-worker', timeoutMs: 180_000,
        })).resolves.toMatchObject({ outcome: 'failed', error: 'invalid_input', workerName: '../worker' });
        const invalidEnvelope = { ok: false, operation: 'recover-worker', error: {
                code: 'invalid_input',
                message: 'team_name and worker are required; request_id must be a path-safe 1-128 character opaque identifier and timeout_ms must be an integer from 180000 through 300000 when provided',
            } };
        await expect(executeTeamApiOperation('recover-worker', {
            team_name: 'recovery-team', worker: 'worker-1', request_id: 'request-a', timeout_ms: 1_000,
        }, '/workspace')).resolves.toEqual(invalidEnvelope);
        await expect(executeSecondaryTeamApiOperation('recover-worker', {
            teamName: 'recovery-team', workerName: 'worker-1', requestId: 'request-a', timeoutMs: 1_000,
        }, '/workspace')).resolves.toEqual(invalidEnvelope);
        await expect(executeTeamApiOperation('recover-worker', {
            team_name: 'recovery-team', worker: 'worker-1', request_id: '../../../../tmp/owned', timeout_ms: 180_000,
        }, '/workspace')).resolves.toEqual(invalidEnvelope);
        expect(requestRuntimeOwnerRecovery).not.toHaveBeenCalled();
    });
    it('maps canonical snake_case CLI fields to the package facade and returns the canonical envelope', async () => {
        setRuntimeOwnerRecoveryClient({ requestRuntimeOwnerRecovery: vi.fn(async () => recovered) });
        const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-envelope-'));
        await seedTeamInstance(cwd);
        await expect(executeTeamApiOperation('recover-worker', {
            team_name: 'recovery-team',
            worker: 'worker-1',
            request_id: 'request-a',
            timeout_ms: 180_000,
        }, cwd)).resolves.toEqual({ ok: true, operation: 'recover-worker', data: { result: recovered } });
        await expect(executeSecondaryTeamApiOperation('recover-worker', {
            teamName: 'recovery-team',
            workerName: 'worker-1',
            requestId: 'request-a',
            timeoutMs: 180_000,
        }, cwd)).resolves.toEqual({ ok: true, operation: 'recover-worker', data: { result: recovered } });
        rmSync(cwd, { recursive: true, force: true });
    });
    it('preserves the legacy unsupported-operation envelope outside the recovery operation', async () => {
        await expect(executeSecondaryTeamApiOperation('not-real', {}, '/workspace')).resolves.toEqual({
            ok: false,
            operation: 'not-real',
            error: { code: 'UNSUPPORTED_OPERATION', message: 'Unsupported omc team api operation: not-real' },
        });
    });
    it('retrieves a durable final result by request id after the initiating call has returned', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-result-'));
        try {
            const { instanceId } = await seedTeamInstance(cwd);
            reserveRecoveryRequest(cwd, 'request-a', recoveryPayload(cwd, 'recovery-team', instanceId), 'recovery-a');
            writeRecoveryFinal(cwd, {
                schema_version: 1,
                kind: 'final',
                request_id: 'request-a',
                recovery_id: 'recovery-a',
                team_name: 'recovery-team',
                worker_name: 'worker-1',
                outcome: 'succeeded',
                result: recovered,
                continuation: 'adopted',
                adoption: 'adopted',
                services: 'synced',
                manifest: 'synced',
                completed_at: recovered.updatedAt,
                expires_at: '2099-01-01T00:00:00.000Z',
            });
            await expect(executeTeamApiOperation('read-recovery-result', { team_name: 'recovery-team', request_id: 'request-a' }, cwd))
                .resolves.toMatchObject({ ok: true, operation: 'read-recovery-result', data: { outcome: { kind: 'final', result: recovered } } });
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('requires team_name and rejects unsupported read-recovery-result fields', async () => {
        await expect(executeTeamApiOperation('read-recovery-result', { request_id: 'request-a' }, '/workspace'))
            .resolves.toEqual({
            ok: false,
            operation: 'read-recovery-result',
            error: { code: 'invalid_input', message: 'team_name and request_id are required' },
        });
        await expect(executeTeamApiOperation('read-recovery-result', {
            team_name: 'recovery-team',
            request_id: 'request-a',
            worker: 'worker-1',
        }, '/workspace')).resolves.toEqual({
            ok: false,
            operation: 'read-recovery-result',
            error: { code: 'invalid_input', message: 'read-recovery-result received unsupported fields: worker' },
        });
    });
    it('exports an async request-first terminal-result reader that preserves canonical durable pane identities', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-terminal-reader-'));
        try {
            const { instanceId } = await seedTeamInstance(cwd);
            reserveRecoveryRequest(cwd, 'request-a', recoveryPayload(cwd, 'recovery-team', instanceId), 'recovery-a');
            writeRecoveryFinal(cwd, {
                schema_version: 1, kind: 'final', request_id: 'request-a', recovery_id: 'recovery-a',
                team_name: 'recovery-team', worker_name: 'worker-1', outcome: 'succeeded', result: recovered,
                continuation: 'adopted', adoption: 'adopted', services: 'synced', manifest: 'synced',
                completed_at: recovered.updatedAt, expires_at: '2099-01-01T00:00:00.000Z',
            });
            const packageReader = readRecoverDeadWorkerV2Result;
            const rootReader = readRootRecoverDeadWorkerV2Result;
            await expect(packageReader('request-a', cwd)).resolves.toEqual(recovered);
            await expect(rootReader('request-a', cwd)).resolves.toEqual(recovered);
            expect(readRecoverDeadWorkerV2Outcome(cwd, 'request-a')).toMatchObject({ kind: 'final', result: recovered });
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('returns the actual live pane for an already-running durable success', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-live-pane-'));
        const alreadyRunning = {
            ...recovered,
            outcome: 'already_running',
            oldPaneId: null,
            newPaneId: '%live-worker-pane',
            requeuedTaskIds: [],
            continuationSequenceByTask: {},
        };
        try {
            const { instanceId } = await seedTeamInstance(cwd);
            reserveRecoveryRequest(cwd, 'request-a', recoveryPayload(cwd, 'recovery-team', instanceId), 'recovery-a');
            writeRecoveryFinal(cwd, {
                schema_version: 1, kind: 'final', request_id: 'request-a', recovery_id: 'recovery-a',
                team_name: 'recovery-team', worker_name: 'worker-1', outcome: 'succeeded', result: alreadyRunning,
                continuation: 'none', adoption: 'not_started', services: 'synced', manifest: 'synced',
                completed_at: alreadyRunning.updatedAt, expires_at: '2099-01-01T00:00:00.000Z',
            });
            await expect(readRecoverDeadWorkerV2Result('request-a', cwd)).resolves.toEqual(alreadyRunning);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('fails closed when a durable success result omits its required actual pane identity', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-missing-pane-'));
        try {
            const { instanceId } = await seedTeamInstance(cwd);
            reserveRecoveryRequest(cwd, 'request-a', recoveryPayload(cwd, 'recovery-team', instanceId), 'recovery-a');
            expect(() => writeRecoveryFinal(cwd, {
                schema_version: 1, kind: 'final', request_id: 'request-a', recovery_id: 'recovery-a',
                team_name: 'recovery-team', worker_name: 'worker-1', outcome: 'succeeded',
                result: { ...recovered, oldPaneId: '' }, continuation: 'adopted', adoption: 'adopted',
                services: 'synced', manifest: 'synced', completed_at: recovered.updatedAt,
                expires_at: '2099-01-01T00:00:00.000Z',
            })).toThrow('invalid_persisted_state');
            await expect(readRecoverDeadWorkerV2Result('request-a', cwd)).resolves.toBeNull();
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('does not authorize config cleanup or final publication for malformed owner success', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-malformed-owner-success-'));
        const publishFinal = vi.fn();
        const saveConfigAtRevision = vi.fn();
        try {
            const { instanceId } = await seedTeamInstance(cwd);
            reserveRecoveryRequest(cwd, 'request-a', recoveryPayload(cwd, 'recovery-team', instanceId), 'recovery-a');
            const result = await finalizeRecoveryOwnerResult({
                teamName: 'recovery-team',
                cwd,
                workerName: 'worker-1',
                requestId: 'request-a',
                instanceId,
            }, 'recovery-a', { ...recovered, newPaneId: ' ' }, {
                readRevisionedConfig: vi.fn(), saveConfigAtRevision, publishFinal,
            });
            expect(result).toMatchObject({ outcome: 'failed', committed: false, error: 'invalid_persisted_state' });
            expect(saveConfigAtRevision).not.toHaveBeenCalled();
            expect(publishFinal).not.toHaveBeenCalled();
            expect(readRecoveryOutcome(cwd, 'request-a')).toBeNull();
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=recovery-public-api.test.js.map