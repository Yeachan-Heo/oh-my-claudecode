import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { canonicalRecoveryPayloadHash, readRecoveryOutcome, readRecoveryRequestReservation, reserveRecoveryRequest, writeRecoveryFinal } from '../recovery-request-store.js';
import { createRecoveryOwnerClient, isExpectedRecoveryOwnerSuccessor, recoveryOwnerBootstrapTestHooks, requestRuntimeOwnerRecovery, setRuntimeOwnerDispatch, withRecoveryAdmissionLock, type RecoverDeadWorkerOwnerInput } from '../runtime-owner-client.js';
import type { RecoverDeadWorkerV2Result } from '../types.js';
import { absPath, TeamPaths } from '../state-paths.js';
import { currentProcessStartIdentity, publishOwnerEpoch } from '../team-owner-epoch.js';
import { executeRecoverDeadWorkerV2Owner, prepareRecoveryOwnerBootstrap } from '../runtime-v2.js';

afterEach(() => {
  vi.useRealTimers();
  setRuntimeOwnerDispatch(undefined);
});

function publishSuccess(cwd: string, requestId: string): RecoverDeadWorkerV2Result {
  const reservation = readRecoveryRequestReservation(cwd, requestId);
  if (!reservation) throw new Error('reservation missing');
  const result: RecoverDeadWorkerV2Result = {
    outcome: 'recovered',
    committed: true,
    oldPaneId: '%1',
    newPaneId: '%2',
    requeuedTaskIds: [],
    continuationSequenceByTask: {},
    stateRevision: 4,
    activation: 'active',
    manifestSync: 'synced',
    servicesSync: 'synced',
    warnings: [],
    requestId,
    recoveryId: reservation.recovery_id,
    teamName: 'recovery-team',
    workerName: 'worker-1',
    updatedAt: new Date().toISOString(),
  };
  writeRecoveryFinal(cwd, {
    schema_version: 1,
    kind: 'final',
    request_id: requestId,
    recovery_id: result.recoveryId,
    team_name: result.teamName,
    worker_name: result.workerName,
    outcome: 'succeeded',
    result,
    continuation: 'none',
    adoption: 'not_started',
    services: 'synced',
    manifest: 'synced',
    completed_at: result.updatedAt,
    expires_at: '2099-01-01T00:00:00.000Z',
  });
  return result;
}

function validV2Config(teamName: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: teamName,
    task: 'runtime owner recovery',
    agent_type: 'claude',
    worker_launch_mode: 'interactive',
    worker_count: 0,
    max_workers: 20,
    workers: [],
    created_at: new Date().toISOString(),
    tmux_session: `${teamName}:0`,
    next_task_id: 1,
    state_revision: 1,
    ...overrides,
  };
}

function seedV2Team(cwd: string, teamName = 'recovery-team'): void {
  const configPath = absPath(cwd, TeamPaths.config(teamName));
  const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
  mkdirSync(join(configPath, '..'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(validV2Config(teamName)));
  writeFileSync(manifestPath, JSON.stringify({ schema_version: 2 }));
}

function seedBootstrapRecoveryRequest(
  cwd: string,
  teamName: string,
  requestId: string,
  recoveryId: string,
): void {
  const payload = { operation: 'recover-worker' as const,
    workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' };
  reserveRecoveryRequest(cwd, requestId, payload, recoveryId);
  const intentPath = absPath(cwd, TeamPaths.recoveryIntent(teamName, recoveryId));
  mkdirSync(join(intentPath, '..'), { recursive: true });
  writeFileSync(intentPath, JSON.stringify({ schema_version: 1, kind: 'recover-worker', request_id: requestId,
    recovery_id: recoveryId, operation: payload.operation, workspace_hash: payload.workspaceHash,
    payload_hash: canonicalRecoveryPayloadHash(payload), team_name: teamName, worker_name: 'worker-1',
    created_at: new Date().toISOString() }));
}

describe('runtime owner durable request admission', () => {
  it('joins concurrent copies of the same request and never dispatches owner effects twice', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-replay-'));
    try {
      const dispatch = vi.fn(async input => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return publishSuccess(input.cwd, input.requestId);
      });
      setRuntimeOwnerDispatch(dispatch);
      const input = { teamName: 'recovery-team', cwd, workerName: 'worker-1', requestId: 'request-a', timeoutMs: 180_000 };

      const [first, joined] = await Promise.all([
        requestRuntimeOwnerRecovery(input),
        requestRuntimeOwnerRecovery(input),
      ]);
      const replay = await requestRuntimeOwnerRecovery(input);

      expect(joined).toEqual(first);
      expect(replay).toEqual(first);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('aliases concurrent identical requests to one recovery identity and one owner dispatch', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-alias-'));
    try {
      const dispatch = vi.fn(async input => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return publishSuccess(input.cwd, input.requestId);
      });
      setRuntimeOwnerDispatch(dispatch);

      const [first, second] = await Promise.all([
        requestRuntimeOwnerRecovery({ teamName: 'recovery-team', cwd, workerName: 'worker-1', requestId: 'request-a', timeoutMs: 180_000 }),
        requestRuntimeOwnerRecovery({ teamName: 'recovery-team', cwd, workerName: 'worker-1', requestId: 'request-b', timeoutMs: 180_000 }),
      ]);

      expect(first.recoveryId).toBe(second.recoveryId);
      expect(dispatch).toHaveBeenCalledTimes(1);

      const later = await requestRuntimeOwnerRecovery({ teamName: 'recovery-team', cwd, workerName: 'worker-1', requestId: 'request-c', timeoutMs: 180_000 });
      expect(later.recoveryId).not.toBe(first.recoveryId);
      expect(dispatch).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects self-inconsistent immutable reservations before intent, final, or owner effects', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-inconsistent-reservation-'));
    try {
      seedV2Team(cwd);
      const requestId = 'inconsistent-request';
      const workspaceHash = createHash('sha256').update(cwd).digest('hex');
      const path = absPath(cwd, TeamPaths.recoveryRequestPending(requestId));
      const configPath = absPath(cwd, TeamPaths.config('recovery-team'));
      const mutations: Array<[string, string | RegExp, string]> = [
        ['team', '"team_name":"recovery-team"', '"team_name":"other-team"'],
        ['worker', '"worker_name":"worker-1"', '"worker_name":"worker-2"'],
        ['workspace', `"workspace_hash":"${workspaceHash}"`, `"workspace_hash":"${'b'.repeat(64)}"`],
        ['operation', '"operation":"recover-worker"', '"operation":"recover-workeX"'],
        ['payload hash', /"payload_hash":"[a-f0-9]{64}"/, `"payload_hash":"${'b'.repeat(64)}"`],
      ];
      for (const [name, from, to] of mutations) {
        reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker', workspaceHash,
          teamName: 'recovery-team', workerName: 'worker-1' }, 'recovery-inconsistent');
        const bytes = readFileSync(path, 'utf8');
        writeFileSync(path, bytes.replace(from, to));
        const configBytes = readFileSync(configPath, 'utf8');
        const dispatch = vi.fn();
        const client = createRecoveryOwnerClient(dispatch, { minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });
        await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
          requestId, timeoutMs: 100 }), name).rejects.toThrow('malformed_recovery_request_reservation');
        expect(dispatch, name).not.toHaveBeenCalled();
        expect(existsSync(absPath(cwd, TeamPaths.recoveryIntent('recovery-team', 'recovery-inconsistent'))), name).toBe(false);
        expect(existsSync(absPath(cwd, TeamPaths.recoveryRequestResult(requestId))), name).toBe(false);
        expect(readFileSync(configPath, 'utf8'), name).toBe(configBytes);
        unlinkSync(path);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reconstructs a missing canonical intent after a crash following reservation publication', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-missing-intent-'));
    try {
      reserveRecoveryRequest(cwd, 'request-crash', { operation: 'recover-worker',
        workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName: 'recovery-team', workerName: 'worker-1' }, 'recovery-crash');
      const dispatch = vi.fn(async input => publishSuccess(input.cwd, input.requestId));
      setRuntimeOwnerDispatch(dispatch);
      const pending = requestRuntimeOwnerRecovery({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId: 'request-crash', timeoutMs: 180_000 });
      const intentPath = absPath(cwd, TeamPaths.recoveryIntent('recovery-team', 'recovery-crash'));
      for (let attempt = 0; attempt < 50 && !existsSync(intentPath); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(existsSync(intentPath)).toBe(true);
      const result = publishSuccess(cwd, 'request-crash');
      await expect(pending).resolves.toEqual(result);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('bootstraps epoch 1 only when no owner exists and waits for the exact authoritative config fence', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-first-owner-'));
    try {
      seedV2Team(cwd);
      const bootstrapOwner = vi.fn(async (input: RecoverDeadWorkerOwnerInput, priorEpoch: number | null) => {
        expect(priorEpoch).toBeNull();
        const owner = publishOwnerEpoch(cwd, input.teamName, 1, { nonce: 'first-owner' });
        const configPath = absPath(cwd, TeamPaths.config(input.teamName));
        writeFileSync(configPath, JSON.stringify(validV2Config(input.teamName, { state_revision: 2, runtime_owner_epoch: owner })));
        publishSuccess(input.cwd, input.requestId);
        return true;
      });
      const client = createRecoveryOwnerClient(vi.fn(), { persistentOwnerBootstrap: true, bootstrapOwner,
        minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });
      await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId: 'first-owner-request', timeoutMs: 100 })).resolves.toMatchObject({ outcome: 'recovered' });
      expect(bootstrapOwner).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not bootstrap an unknown owner identity', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-unknown-'));
    try {
      seedV2Team(cwd);
      publishOwnerEpoch(cwd, 'recovery-team', 1, { nonce: 'unknown-owner' });
      writeFileSync(absPath(cwd, TeamPaths.ownerEpoch('recovery-team', 1)), '{');
      const bootstrapOwner = vi.fn(async () => true);
      const client = createRecoveryOwnerClient(vi.fn(), { persistentOwnerBootstrap: true, bootstrapOwner,
        minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });
      await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId: 'unknown-owner-request', timeoutMs: 100 })).resolves.toMatchObject({ error: 'recovery_request_timeout' });
      expect(readRecoveryOutcome(cwd, 'unknown-owner-request')).not.toMatchObject({ kind: 'final' });
      expect(bootstrapOwner).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('bootstraps exactly one successor after a positively dead owner epoch and leaves execution to that owner', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-successor-'));
    try {
      seedV2Team(cwd);
      publishOwnerEpoch(cwd, 'recovery-team', 1, { pid: process.pid, processStartedAt: 'linux:1', nonce: 'dead-owner' });
      const dispatch = vi.fn();
      const bootstrapOwner = vi.fn(async (input: RecoverDeadWorkerOwnerInput, priorEpoch: number | null) => {
        expect(priorEpoch).toBe(1);
        const owner = publishOwnerEpoch(cwd, 'recovery-team', 2, { nonce: 'successor-owner' });
        writeFileSync(absPath(cwd, TeamPaths.config('recovery-team')), JSON.stringify(
          validV2Config('recovery-team', { state_revision: 2, runtime_owner_epoch: owner }),
        ));
        publishSuccess(input.cwd, input.requestId);
        return true;
      });
      const client = createRecoveryOwnerClient(dispatch, { persistentOwnerBootstrap: true, bootstrapOwner,
        minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });

      await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId: 'successor-request', timeoutMs: 100 })).resolves.toMatchObject({ outcome: 'recovered' });
      expect(bootstrapOwner).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('replays a canonical final after team deletion without publishing an empty-recovery result', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-deleted-final-'));
    try {
      seedV2Team(cwd);
      const requestId = 'deleted-final-request';
      const admissionDispatch = vi.fn(async (input: RecoverDeadWorkerOwnerInput) => publishSuccess(input.cwd, input.requestId));
      const admittingClient = createRecoveryOwnerClient(admissionDispatch,
        { minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });
      const expected = await admittingClient.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId, timeoutMs: 100 });
      const reservation = readRecoveryRequestReservation(cwd, requestId);
      expect(reservation).toMatchObject({ kind: 'reservation', request_id: requestId,
        team_name: 'recovery-team', worker_name: 'worker-1' });
      expect(expected.recoveryId).toBe(reservation?.recovery_id);
      expect(expected.recoveryId).not.toBe('');
      expect(admissionDispatch).toHaveBeenCalledTimes(1);

      unlinkSync(absPath(cwd, TeamPaths.config('recovery-team')));
      const bootstrapOwner = vi.fn(async () => true);
      const client = createRecoveryOwnerClient(vi.fn(), { persistentOwnerBootstrap: true, bootstrapOwner,
        minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });

      await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId, timeoutMs: 100 })).resolves.toEqual(expected);
      expect(bootstrapOwner).not.toHaveBeenCalled();
      expect(readRecoveryOutcome(cwd, requestId)).toMatchObject({
        kind: 'final', recovery_id: expected.recoveryId,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns a request-ID conflict after team deletion without publishing a new empty-recovery final', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-deleted-conflict-'));
    try {
      seedV2Team(cwd);
      reserveRecoveryRequest(cwd, 'deleted-conflict-request', { operation: 'recover-worker',
        workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName: 'other-team', workerName: 'worker-1' },
      'other-recovery');
      unlinkSync(absPath(cwd, TeamPaths.config('recovery-team')));
      const bootstrapOwner = vi.fn(async () => true);
      const client = createRecoveryOwnerClient(vi.fn(), { persistentOwnerBootstrap: true, bootstrapOwner,
        minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });

      await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId: 'deleted-conflict-request', timeoutMs: 100 })).resolves.toMatchObject({
        outcome: 'failed', error: 'recovery_attempt_conflict', recoveryId: 'other-recovery',
      });
      expect(bootstrapOwner).not.toHaveBeenCalled();
      expect(readRecoveryOutcome(cwd, 'deleted-conflict-request')).toBeNull();
      expect(readRecoveryRequestReservation(cwd, 'deleted-conflict-request')).toMatchObject({
        recovery_id: 'other-recovery', team_name: 'other-team',
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ['absent', undefined],
    ['malformed', '{'],
    ['stale', JSON.stringify({ schema_version: 2, state_revision: 0, name: 'stale-projection' })],
  ])('accepts revisioned config authority with a %s manifest', async (_manifestState, manifest) => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-config-authority-'));
    try {
      const teamName = 'recovery-team';
      const configPath = absPath(cwd, TeamPaths.config(teamName));
      mkdirSync(join(configPath, '..'), { recursive: true });
      writeFileSync(configPath, JSON.stringify(validV2Config(teamName)));
      if (manifest !== undefined) writeFileSync(absPath(cwd, TeamPaths.manifest(teamName)), manifest);
      publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: 'linux:1', nonce: 'dead-owner' });
      const bootstrapOwner = vi.fn(async (input: RecoverDeadWorkerOwnerInput) => {
        publishOwnerEpoch(cwd, teamName, 2, { nonce: 'successor-owner' });
        publishSuccess(input.cwd, input.requestId);
        return true;
      });
      const client = createRecoveryOwnerClient(vi.fn(), { persistentOwnerBootstrap: true, bootstrapOwner,
        minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });

      await expect(client.recoverDeadWorker({ teamName, cwd, workerName: 'worker-1',
        requestId: `manifest-${_manifestState}`, timeoutMs: 100 })).resolves.toMatchObject({ outcome: 'recovered' });
      expect(bootstrapOwner).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ['incomplete revisioned', { state_revision: 1 }],
    ['negative revision', validV2Config('recovery-team', { state_revision: -1 })],
    ['malformed worker', validV2Config('recovery-team', { workers: [{ name: 'worker-1', index: 'bad' }], worker_count: 1 })],
    ['malformed owner', validV2Config('recovery-team', { runtime_owner_epoch: { epoch: 1, nonce: 'owner' } })],
    ['malformed service', validV2Config('recovery-team', { service_descriptor: { schema_version: 1, service_generation: 1 } })],
    ['malformed lifecycle', validV2Config('recovery-team', { lifecycle_state: 'unknown' })],
  ])('classifies %s authoritative config as invalid before owner effects', async (_name, config) => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-malformed-config-'));
    try {
      const path = absPath(cwd, TeamPaths.config('recovery-team'));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, JSON.stringify(config));
      const bootstrapOwner = vi.fn(async () => true);
      const client = createRecoveryOwnerClient(vi.fn(), { persistentOwnerBootstrap: true, bootstrapOwner,
        minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });
      await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId: `malformed-${_name.replace(/\s+/g, '-')}`, timeoutMs: 100 })).resolves.toMatchObject({ error: 'invalid_persisted_state' });
      expect(bootstrapOwner).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('classifies only a complete unrevisioned config as legacy and a missing config as absent', async () => {
    const legacyCwd = mkdtempSync(join(tmpdir(), 'runtime-owner-legacy-config-'));
    const absentCwd = mkdtempSync(join(tmpdir(), 'runtime-owner-absent-config-'));
    try {
      const configPath = absPath(legacyCwd, TeamPaths.config('recovery-team'));
      mkdirSync(join(configPath, '..'), { recursive: true });
      const legacy = validV2Config('recovery-team');
      delete legacy.state_revision;
      writeFileSync(configPath, JSON.stringify(legacy));
      const client = createRecoveryOwnerClient(vi.fn(), { persistentOwnerBootstrap: true,
        minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });
      await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd: legacyCwd, workerName: 'worker-1',
        requestId: 'legacy-config', timeoutMs: 100 })).resolves.toMatchObject({ error: 'runtime_v2_required' });
      await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd: absentCwd, workerName: 'worker-1',
        requestId: 'absent-config', timeoutMs: 100 })).resolves.toMatchObject({ error: 'team_not_found' });
    } finally {
      rmSync(legacyCwd, { recursive: true, force: true });
      rmSync(absentCwd, { recursive: true, force: true });
    }
  });

  it('does not take over a verified live owner and keeps the request transient', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-live-'));
    try {
      seedV2Team(cwd);
      publishOwnerEpoch(cwd, 'recovery-team', 1, { nonce: 'live-owner' });
      const bootstrapOwner = vi.fn(async (_input: RecoverDeadWorkerOwnerInput, _priorEpoch: number | null) => true);
      const dispatch = vi.fn();
      const client = createRecoveryOwnerClient(dispatch, { persistentOwnerBootstrap: true, bootstrapOwner,
        minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });

      await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId: 'live-request', timeoutMs: 100 })).resolves.toMatchObject({ error: 'recovery_request_timeout' });
      expect(bootstrapOwner).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns the exact typed timeout while leaving the durable intent pending', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-timeout-'));
    try {
      const neverSettles = new Promise<RecoverDeadWorkerV2Result>(() => undefined);
      const client = createRecoveryOwnerClient(vi.fn(() => neverSettles),
        { minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });
      const result = await client.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId: 'request-timeout', timeoutMs: 100 });
      const reservation = readRecoveryRequestReservation(cwd, 'request-timeout');
      expect(reservation).not.toBeNull();
      expect(result).toEqual({
        outcome: 'failed', committed: false, error: 'recovery_request_timeout', requestId: 'request-timeout',
        recoveryId: reservation!.recovery_id, teamName: 'recovery-team', workerName: 'worker-1',
        updatedAt: expect.any(String), message: 'Timed out waiting for the persistent recovery owner.',
      });
      expect(existsSync(absPath(cwd, TeamPaths.recoveryIntent('recovery-team', reservation!.recovery_id)))).toBe(true);
      expect(readRecoveryOutcome(cwd, 'request-timeout')).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a truncated existing canonical intent without dispatching owner effects', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-truncated-intent-'));
    try {
      reserveRecoveryRequest(cwd, 'request-truncated', { operation: 'recover-worker',
        workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName: 'recovery-team', workerName: 'worker-1' },
      'recovery-truncated');
      const intentPath = absPath(cwd, TeamPaths.recoveryIntent('recovery-team', 'recovery-truncated'));
      mkdirSync(join(intentPath, '..'), { recursive: true });
      writeFileSync(intentPath, '{"schema_version":1');
      const dispatch = vi.fn(async input => publishSuccess(input.cwd, input.requestId));
      const client = createRecoveryOwnerClient(dispatch, { minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });

      await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId: 'request-truncated', timeoutMs: 100 })).rejects.toThrow('invalid_persisted_state');
      expect(dispatch).not.toHaveBeenCalled();
      expect(readRecoveryOutcome(cwd, 'request-truncated')).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a tuple-matching incomplete final instead of replaying or dispatching', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-incomplete-final-'));
    try {
      reserveRecoveryRequest(cwd, 'request-incomplete', { operation: 'recover-worker',
        workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName: 'recovery-team', workerName: 'worker-1' },
      'recovery-incomplete');
      writeFileSync(absPath(cwd, TeamPaths.recoveryRequestResult('request-incomplete')), JSON.stringify({
        schema_version: 1, kind: 'final', request_id: 'request-incomplete', recovery_id: 'recovery-incomplete',
        team_name: 'recovery-team', worker_name: 'worker-1', outcome: 'failed',
        result: { outcome: 'failed', requestId: 'request-incomplete', recoveryId: 'recovery-incomplete',
          teamName: 'recovery-team', workerName: 'worker-1', updatedAt: new Date().toISOString() },
        error: { code: 'worker_not_found', commit_uncertain: false }, continuation: 'none', adoption: 'not_started',
        services: 'terminal_degraded', manifest: 'repair_required', completed_at: new Date().toISOString(),
        expires_at: '2099-01-01T00:00:00.000Z' }));
      const dispatch = vi.fn(async input => publishSuccess(input.cwd, input.requestId));
      const client = createRecoveryOwnerClient(dispatch, { minTimeoutMs: 100, maxTimeoutMs: 100, pollIntervalMs: 10 });

      await expect(client.recoverDeadWorker({ teamName: 'recovery-team', cwd, workerName: 'worker-1',
        requestId: 'request-incomplete', timeoutMs: 100 })).rejects.toThrow('invalid_persisted_state');
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('recovery admission lock crash takeover', () => {
  it('reclaims a complete lock record only after its PID identity is confirmed dead', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-stale-lock-'));
    try {
      const lockPath = absPath(cwd, TeamPaths.recoveryAdmissionLock('payload-hash'));
      mkdirSync(join(lockPath, '..'), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ schema_version: 1, pid: 2_147_483_647,
        process_started_at: 'linux:1', nonce: 'crashed-owner', created_at: new Date().toISOString() }));

      const effect = vi.fn(() => 'reclaimed');
      await expect(withRecoveryAdmissionLock(cwd, 'payload-hash', effect)).resolves.toBe('reclaimed');
      expect(effect).toHaveBeenCalledTimes(1);
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it('accepts only the exact child-owned successor epoch and fence', () => {
    const owner = { schema_version: 1 as const, epoch: 1, pid: 123, process_started_at: 'linux:456',
      nonce: 'owner', payload_hash: 'hash', created_at: new Date().toISOString() };
    expect(isExpectedRecoveryOwnerSuccessor(owner, 1, 123, 'linux:456', true)).toBe(true);
    expect(isExpectedRecoveryOwnerSuccessor({ ...owner, epoch: 2 }, 1, 123, 'linux:456', true)).toBe(false);
    expect(isExpectedRecoveryOwnerSuccessor({ ...owner, pid: 124 }, 1, 123, 'linux:456', true)).toBe(false);
    expect(isExpectedRecoveryOwnerSuccessor(owner, 1, 123, 'linux:999', true)).toBe(false);
    expect(isExpectedRecoveryOwnerSuccessor(owner, 1, 123, 'linux:456', false)).toBe(false);
    expect(isExpectedRecoveryOwnerSuccessor(owner, 1, 123, 'linux:456', true, 'different-owner')).toBe(false);
    expect(isExpectedRecoveryOwnerSuccessor(owner, 1, 123, 'linux:456', true, 'owner')).toBe(true);
  });

});

describe('recovery owner bootstrap candidates', () => {
  it('retries the same canonical request with a second child after the first candidate dies pre-epoch', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-bootstrap-candidates-'));
    try {
      const teamName = 'recovery-team';
      const requestId = 'candidate-retry-request';
      const recoveryId = 'candidate-retry-recovery';
      const payload = { operation: 'recover-worker' as const,
        workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' };
      const configPath = absPath(cwd, TeamPaths.config(teamName));
      mkdirSync(join(configPath, '..'), { recursive: true });
      writeFileSync(configPath, JSON.stringify(validV2Config(teamName)));
      reserveRecoveryRequest(cwd, requestId, payload, recoveryId);
      const intentPath = absPath(cwd, TeamPaths.recoveryIntent(teamName, recoveryId));
      mkdirSync(join(intentPath, '..'), { recursive: true });
      writeFileSync(intentPath, JSON.stringify({ schema_version: 1, kind: 'recover-worker', request_id: requestId,
        recovery_id: recoveryId, operation: payload.operation, workspace_hash: payload.workspaceHash,
        payload_hash: canonicalRecoveryPayloadHash(payload), team_name: teamName, worker_name: 'worker-1',
        created_at: new Date().toISOString() }));
      const baseInput = { teamName, cwd, workerName: 'worker-1', requestId };
      await recoveryOwnerBootstrapTestHooks.publishCandidate(baseInput, recoveryId, 1, 'dead-child',
        2_147_483_647, 'linux:1', null);
      expect(recoveryOwnerBootstrapTestHooks.hasLiveOrUnknownCandidate(baseInput, recoveryId, 1, null)).toBe(false);
      expect(readRecoveryOutcome(cwd, requestId)).toBeNull();

      const processStartedAt = currentProcessStartIdentity();
      expect(processStartedAt).toBeTruthy();
      const input: RecoverDeadWorkerOwnerInput = { ...baseInput, bootstrap: {
        expectedEpoch: 1, predecessorEpoch: 0, predecessorNonce: null, predecessorPid: null,
        predecessorProcessStartedAt: null, pid: process.pid, processStartedAt: processStartedAt!,
        nonce: 'successor-child', recoveryId,
      } };
      await recoveryOwnerBootstrapTestHooks.publishCandidate(baseInput, recoveryId, 1, 'successor-child',
        process.pid, processStartedAt!, null);
      await expect(prepareRecoveryOwnerBootstrap(input)).resolves.toBeUndefined();
      expect(readRecoveryOutcome(cwd, requestId)).toBeNull();
      const bound = JSON.parse(readFileSync(configPath, 'utf8')) as { active_recovery?: { request_id: string }; runtime_owner_epoch?: { nonce: string } };
      expect(bound.runtime_owner_epoch?.nonce).toBe('successor-child');
      expect(bound.active_recovery?.request_id).toBe(requestId);

      await expect(executeRecoverDeadWorkerV2Owner(input)).resolves.toMatchObject({ outcome: 'failed', error: 'worker_not_found' });
      expect(readRecoveryOutcome(cwd, requestId)).toMatchObject({ kind: 'final', result: { error: 'worker_not_found' } });
      const finalized = JSON.parse(readFileSync(configPath, 'utf8')) as { active_recovery?: unknown; last_recovery?: { request_id: string } };
      expect(finalized.active_recovery).toBeUndefined();
      expect(finalized.last_recovery?.request_id).toBe(requestId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('times out missing bootstrap evidence without publishing owner, config, effects, or a final result', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-bootstrap-timeout-'));
    try {
      const teamName = 'recovery-team';
      const requestId = 'missing-candidate-request';
      const recoveryId = 'missing-candidate-recovery';
      const configPath = absPath(cwd, TeamPaths.config(teamName));
      mkdirSync(join(configPath, '..'), { recursive: true });
      writeFileSync(configPath, JSON.stringify(validV2Config(teamName)));
      seedBootstrapRecoveryRequest(cwd, teamName, requestId, recoveryId);
      const processStartedAt = currentProcessStartIdentity();
      expect(processStartedAt).toBeTruthy();
      let now = 0;
      let sleepCalls = 0;
      const input: RecoverDeadWorkerOwnerInput = { teamName, cwd, workerName: 'worker-1', requestId, bootstrap: {
        expectedEpoch: 1, predecessorEpoch: 0, predecessorNonce: null, predecessorPid: null,
        predecessorProcessStartedAt: null, pid: process.pid, processStartedAt: processStartedAt!, nonce: 'missing-child', recoveryId,
      } };

      await expect(prepareRecoveryOwnerBootstrap(input, {
        timeoutMs: Number.MAX_SAFE_INTEGER,
        now: () => now,
        sleep: async delayMs => { sleepCalls++; now += delayMs; },
      })).rejects.toThrow('runtime_owner_bootstrap_fence_lost');
      expect(sleepCalls).toBe(40);

      const config = JSON.parse(readFileSync(configPath, 'utf8')) as { runtime_owner_epoch?: unknown; active_recovery?: unknown };
      expect(config.runtime_owner_epoch).toBeUndefined();
      expect(config.active_recovery).toBeUndefined();
      expect(readRecoveryOutcome(cwd, requestId)).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('cancels bootstrap evidence waiting without publishing owner, config, effects, or a final result', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-bootstrap-abort-'));
    try {
      const teamName = 'recovery-team';
      const requestId = 'aborted-candidate-request';
      const recoveryId = 'aborted-candidate-recovery';
      const configPath = absPath(cwd, TeamPaths.config(teamName));
      mkdirSync(join(configPath, '..'), { recursive: true });
      writeFileSync(configPath, JSON.stringify(validV2Config(teamName)));
      seedBootstrapRecoveryRequest(cwd, teamName, requestId, recoveryId);
      const processStartedAt = currentProcessStartIdentity();
      expect(processStartedAt).toBeTruthy();
      const controller = new AbortController();
      const input: RecoverDeadWorkerOwnerInput = { teamName, cwd, workerName: 'worker-1', requestId, bootstrap: {
        expectedEpoch: 1, predecessorEpoch: 0, predecessorNonce: null, predecessorPid: null,
        predecessorProcessStartedAt: null, pid: process.pid, processStartedAt: processStartedAt!, nonce: 'aborted-child', recoveryId,
      } };

      await expect(prepareRecoveryOwnerBootstrap(input, {
        signal: controller.signal,
        sleep: async () => { controller.abort(); },
      })).rejects.toThrow('runtime_owner_bootstrap_fence_lost');

      const config = JSON.parse(readFileSync(configPath, 'utf8')) as { runtime_owner_epoch?: unknown; active_recovery?: unknown };
      expect(config.runtime_owner_epoch).toBeUndefined();
      expect(config.active_recovery).toBeUndefined();
      expect(readRecoveryOutcome(cwd, requestId)).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when a same-epoch bootstrap candidate sibling is malformed', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-bootstrap-malformed-'));
    try {
      const input = { teamName: 'recovery-team', cwd, workerName: 'worker-1', requestId: 'candidate-malformed-request' };
      const path = absPath(cwd, TeamPaths.recoveryOwnerBootstrapCandidate(input.teamName, 1, 'malformed-child'));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, '{ malformed');
      expect(recoveryOwnerBootstrapTestHooks.hasLiveOrUnknownCandidate(input, 'candidate-malformed-recovery', 1, null)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
