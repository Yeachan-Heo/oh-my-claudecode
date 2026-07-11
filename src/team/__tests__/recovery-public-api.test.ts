import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeTeamApiOperation as executeSecondaryTeamApiOperation } from '../../cli/team.js';
import { executeTeamApiOperation } from '../api-interop.js';
import { readRecoveryOutcome, reserveRecoveryRequest, writeRecoveryFinal } from '../recovery-request-store.js';
import { readRecoverDeadWorkerV2Result as readRootRecoverDeadWorkerV2Result } from '../../index.js';
import { finalizeRecoveryOwnerResult, recoverDeadWorkerV2, readRecoverDeadWorkerV2Outcome, readRecoverDeadWorkerV2Result, setRuntimeOwnerRecoveryClient } from '../runtime-v2.js';

import type { RecoverDeadWorkerV2Result } from '../types.js';

const recovered: RecoverDeadWorkerV2Result = {
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

afterEach(() => {
  vi.useRealTimers();
  setRuntimeOwnerRecoveryClient(undefined);
});

describe('public dead-worker recovery facade', () => {
  it('classifies authoritative config independently of any manifest before dispatching recovery effects', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-state-'));
    try {
      await expect(recoverDeadWorkerV2('missing-team', cwd, {
        workerName: 'worker-1', requestId: 'missing-request', timeoutMs: 180_000,
      })).resolves.toMatchObject({ outcome: 'failed', committed: false, error: 'team_not_found' });

      const configPath = join(cwd, '.omc', 'state', 'team', 'legacy-team', 'config.json');
      mkdirSync(join(configPath, '..'), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ name: 'legacy-team', task: 'legacy', agent_type: 'claude',
        worker_launch_mode: 'interactive', worker_count: 0, max_workers: 20, workers: [],
        created_at: new Date().toISOString(), tmux_session: 'legacy-team:0', next_task_id: 1 }));
      await expect(executeTeamApiOperation('recover-worker', {
        team_name: 'legacy-team', worker: 'worker-1', request_id: 'legacy-request', timeout_ms: 180_000,
      }, cwd)).resolves.toMatchObject({ ok: true, data: { result: { outcome: 'failed', error: 'runtime_v2_required' } } });

      const malformedConfigPath = join(cwd, '.omc', 'state', 'team', 'malformed-team', 'config.json');
      mkdirSync(join(malformedConfigPath, '..'), { recursive: true });
      writeFileSync(malformedConfigPath, '{"state_revision":');
      await expect(recoverDeadWorkerV2('malformed-team', cwd, {
        workerName: 'worker-1', requestId: 'malformed-request', timeoutMs: 180_000,
      })).resolves.toMatchObject({ outcome: 'failed', committed: false, error: 'invalid_persisted_state' });

      const malformedRevisionPath = join(cwd, '.omc', 'state', 'team', 'malformed-revision-team', 'config.json');
      mkdirSync(join(malformedRevisionPath, '..'), { recursive: true });
      writeFileSync(malformedRevisionPath, JSON.stringify({ name: 'malformed-revision-team', state_revision: 'one' }));
      await expect(recoverDeadWorkerV2('malformed-revision-team', cwd, {
        workerName: 'worker-1', requestId: 'malformed-revision-request', timeoutMs: 180_000,
      })).resolves.toMatchObject({ outcome: 'failed', committed: false, error: 'invalid_persisted_state' });

      const manifestOnlyPath = join(cwd, '.omc', 'state', 'team', 'manifest-only-team', 'manifest.json');
      mkdirSync(join(manifestOnlyPath, '..'), { recursive: true });
      writeFileSync(manifestOnlyPath, '{not authoritative config}');
      await expect(recoverDeadWorkerV2('manifest-only-team', cwd, {
        workerName: 'worker-1', requestId: 'manifest-only-request', timeoutMs: 180_000,
      })).resolves.toMatchObject({ outcome: 'failed', committed: false, error: 'team_not_found' });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('preserves the exact package argument boundary and typed result', async () => {
    const requestRuntimeOwnerRecovery = vi.fn(async () => recovered);
    setRuntimeOwnerRecoveryClient({ requestRuntimeOwnerRecovery });

    await expect(recoverDeadWorkerV2('recovery-team', '/workspace', {
      workerName: 'worker-1',
      requestId: 'request-a',
      timeoutMs: 180_000,
    })).resolves.toEqual(recovered);
    expect(requestRuntimeOwnerRecovery).toHaveBeenCalledWith({
      teamName: 'recovery-team',
      cwd: '/workspace',
      workerName: 'worker-1',
      requestId: 'request-a',
      timeoutMs: 180_000,
    });
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

    await expect(executeTeamApiOperation('recover-worker', {
      team_name: 'recovery-team',
      worker: 'worker-1',
      request_id: 'request-a',
      timeout_ms: 180_000,
    }, '/workspace')).resolves.toEqual({ ok: true, operation: 'recover-worker', data: { result: recovered } });
    await expect(executeSecondaryTeamApiOperation('recover-worker', {
      teamName: 'recovery-team',
      workerName: 'worker-1',
      requestId: 'request-a',
      timeoutMs: 180_000,
    }, '/workspace')).resolves.toEqual({ ok: true, operation: 'recover-worker', data: { result: recovered } });
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
      reserveRecoveryRequest(cwd, 'request-a', { operation: 'recover-worker', workspaceHash: 'a'.repeat(64),
        teamName: 'recovery-team', workerName: 'worker-1' }, 'recovery-a');
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
    } finally {
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
      reserveRecoveryRequest(cwd, 'request-a', { operation: 'recover-worker', workspaceHash: 'a'.repeat(64),
        teamName: 'recovery-team', workerName: 'worker-1' }, 'recovery-a');
      writeRecoveryFinal(cwd, {
        schema_version: 1, kind: 'final', request_id: 'request-a', recovery_id: 'recovery-a',
        team_name: 'recovery-team', worker_name: 'worker-1', outcome: 'succeeded', result: recovered,
        continuation: 'adopted', adoption: 'adopted', services: 'synced', manifest: 'synced',
        completed_at: recovered.updatedAt, expires_at: '2099-01-01T00:00:00.000Z',
      });

      const packageReader: (requestId: string, cwd?: string) => Promise<RecoverDeadWorkerV2Result | null> = readRecoverDeadWorkerV2Result;
      const rootReader: (requestId: string, cwd?: string) => Promise<RecoverDeadWorkerV2Result | null> = readRootRecoverDeadWorkerV2Result;
      await expect(packageReader('request-a', cwd)).resolves.toEqual(recovered);
      await expect(rootReader('request-a', cwd)).resolves.toEqual(recovered);
      expect(readRecoverDeadWorkerV2Outcome(cwd, 'request-a')).toMatchObject({ kind: 'final', result: recovered });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns the actual live pane for an already-running durable success', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-live-pane-'));
    const alreadyRunning: RecoverDeadWorkerV2Result = {
      ...recovered,
      outcome: 'already_running',
      oldPaneId: null,
      newPaneId: '%live-worker-pane',
      requeuedTaskIds: [],
      continuationSequenceByTask: {},
    };
    try {
      reserveRecoveryRequest(cwd, 'request-a', { operation: 'recover-worker', workspaceHash: 'a'.repeat(64),
        teamName: 'recovery-team', workerName: 'worker-1' }, 'recovery-a');
      writeRecoveryFinal(cwd, {
        schema_version: 1, kind: 'final', request_id: 'request-a', recovery_id: 'recovery-a',
        team_name: 'recovery-team', worker_name: 'worker-1', outcome: 'succeeded', result: alreadyRunning,
        continuation: 'none', adoption: 'not_started', services: 'synced', manifest: 'synced',
        completed_at: alreadyRunning.updatedAt, expires_at: '2099-01-01T00:00:00.000Z',
      });

      await expect(readRecoverDeadWorkerV2Result('request-a', cwd)).resolves.toEqual(alreadyRunning);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when a durable success result omits its required actual pane identity', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-missing-pane-'));
    try {
      reserveRecoveryRequest(cwd, 'request-a', { operation: 'recover-worker', workspaceHash: 'a'.repeat(64),
        teamName: 'recovery-team', workerName: 'worker-1' }, 'recovery-a');
      expect(() => writeRecoveryFinal(cwd, {
        schema_version: 1, kind: 'final', request_id: 'request-a', recovery_id: 'recovery-a',
        team_name: 'recovery-team', worker_name: 'worker-1', outcome: 'succeeded',
        result: { ...recovered, oldPaneId: '' }, continuation: 'adopted', adoption: 'adopted',
        services: 'synced', manifest: 'synced', completed_at: recovered.updatedAt,
        expires_at: '2099-01-01T00:00:00.000Z',
      })).toThrow('invalid_persisted_state');

      await expect(readRecoverDeadWorkerV2Result('request-a', cwd)).resolves.toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not authorize config cleanup or final publication for malformed owner success', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'recovery-public-malformed-owner-success-'));
    const publishFinal = vi.fn();
    const saveConfigAtRevision = vi.fn();
    try {
      reserveRecoveryRequest(cwd, 'request-a', { operation: 'recover-worker', workspaceHash: 'a'.repeat(64),
        teamName: 'recovery-team', workerName: 'worker-1' }, 'recovery-a');
      const result = await finalizeRecoveryOwnerResult({ teamName: 'recovery-team', cwd, workerName: 'worker-1', requestId: 'request-a' },
        'recovery-a', { ...recovered, newPaneId: ' ' }, {
          readRevisionedConfig: vi.fn(), saveConfigAtRevision, publishFinal,
        });
      expect(result).toMatchObject({ outcome: 'failed', committed: false, error: 'invalid_persisted_state' });
      expect(saveConfigAtRevision).not.toHaveBeenCalled();
      expect(publishFinal).not.toHaveBeenCalled();
      expect(readRecoveryOutcome(cwd, 'request-a')).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
