import { describe, expect, it, vi } from 'vitest';

import { finalizeRecoveryOwnerResult, resolveCommittedRecoveryManifestSync, resolveCommittedRecoveryPaneAttempt, selectRecoveryReplayTasks } from '../runtime-v2.js';
import type { TeamConfig, TeamTask, WorkerInfo } from '../types.js';

const ownerInput = {
  teamName: 'recovery-team',
  cwd: '/workspace',
  workerName: 'worker-1',
  requestId: 'request-a',
};

function activeConfig(): TeamConfig {
  return {
    name: 'recovery-team',
    worker_count: 1,
    workers: [{ name: 'worker-1', index: 1 } as WorkerInfo],
    agent_type: 'claude',
    created_at: '2026-07-10T00:00:00.000Z',
    tmux_session: 'recovery-team:0',
    state_revision: 5,
    runtime_owner_epoch: { epoch: 2, nonce: 'owner-nonce', pid: process.pid,
      process_started_at: 'process-start', created_at: '2026-07-10T00:00:00.000Z' },
    active_recovery: {
      request_id: 'request-a',
      recovery_id: 'recovery-a',
      worker_name: 'worker-1',
      owner_epoch: 2,
      owner_nonce: 'owner-nonce',
      phase: 'reserved',
      state_revision: 5,
      created_at: '2026-07-10T00:00:00.000Z',
      updated_at: '2026-07-10T00:00:00.000Z',
    },
  } as TeamConfig;
}

describe('runtime owner recovery finalization', () => {
  it('retains resumable active recovery and does not publish a final for transient failure', async () => {
    const saved: TeamConfig[] = [];
    const publishFinal = vi.fn();
    const result = { outcome: 'failed' as const, committed: false as const, error: 'spawn_failed' as const,
      requestId: 'request-a', recoveryId: 'recovery-a', teamName: 'recovery-team', workerName: 'worker-1',
      updatedAt: new Date().toISOString() };

    expect(await finalizeRecoveryOwnerResult(ownerInput, 'recovery-a', result, {
      readRevisionedConfig: async () => ({ config: activeConfig(), stateRevision: 5 }),
      saveConfigAtRevision: async config => { saved.push(config); return true; },
      publishFinal,
    })).toBe(result);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.active_recovery).toMatchObject({ recovery_id: 'recovery-a', phase: 'reserved', state_revision: 6 });
    expect(publishFinal).not.toHaveBeenCalled();
  });

  it('does not terminalize a failure after a durable task reservation was written', async () => {
    const saved: TeamConfig[] = [];
    const publishFinal = vi.fn();
    const result = { outcome: 'failed' as const, committed: false as const, error: 'task_requeue_failed' as const,
      reservationsWritten: true,
      requestId: 'request-a', recoveryId: 'recovery-a', teamName: 'recovery-team', workerName: 'worker-1',
      updatedAt: new Date().toISOString() };

    await expect(finalizeRecoveryOwnerResult(ownerInput, 'recovery-a', result, {
      readRevisionedConfig: async () => ({ config: activeConfig(), stateRevision: 5 }),
      saveConfigAtRevision: async config => { saved.push(config); return true; },
      publishFinal,
    })).resolves.toBe(result);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.active_recovery).toMatchObject({ recovery_id: 'recovery-a', phase: 'reserved' });
    expect(publishFinal).not.toHaveBeenCalled();
  });

  it('publishes terminal success only after revision-checked active-recovery cleanup', async () => {
    const order: string[] = [];
    let persistedConfig = activeConfig();
    const result = { outcome: 'recovered' as const, committed: true as const, oldPaneId: '%1', newPaneId: '%2',
      requeuedTaskIds: ['1'], continuationSequenceByTask: { '1': 4 }, stateRevision: 6,
      activation: 'active' as const, manifestSync: 'synced' as const, servicesSync: 'synced' as const,
      warnings: [], requestId: 'request-a', recoveryId: 'recovery-a', teamName: 'recovery-team', workerName: 'worker-1',
      updatedAt: new Date().toISOString() };

    expect(await finalizeRecoveryOwnerResult(ownerInput, 'recovery-a', result, {
      readRevisionedConfig: async () => ({ config: persistedConfig, stateRevision: persistedConfig.state_revision ?? 5 }),
      saveConfigAtRevision: async (config, expectedRevision, _cwd, afterCommit) => {
        order.push('cleanup');
        expect(expectedRevision).toBe(5);
        expect(config.active_recovery).toBeUndefined();
        expect(config.last_recovery).toMatchObject({ recovery_id: 'recovery-a', phase: 'adopted', state_revision: 6 });
        persistedConfig = config;
        await afterCommit?.();
        return true;
      },
      publishFinal: (_input, _recoveryId, published) => { order.push('final'); return published; },
    })).toBe(result);

    expect(order).toEqual(['cleanup', 'final']);
  });

  it.each([
    'team_shutting_down',
    'worker_not_found',
    'launch_metadata_incomplete',
    'launch_descriptor_unresolvable',
    'team_session_dead',
    'invalid_persisted_state',
  ] as const)('clears the bound attempt into exact last_recovery before publishing terminal %s', async error => {
    let persistedConfig = activeConfig();
    const order: string[] = [];
    const result = { outcome: 'failed' as const, committed: false as const, error,
      requestId: 'request-a', recoveryId: 'recovery-a', teamName: 'recovery-team', workerName: 'worker-1',
      updatedAt: new Date().toISOString() };

    await expect(finalizeRecoveryOwnerResult(ownerInput, 'recovery-a', result, {
      readRevisionedConfig: async () => ({ config: persistedConfig, stateRevision: persistedConfig.state_revision ?? 5 }),
      saveConfigAtRevision: async (config, expectedRevision, _cwd, afterCommit) => {
        expect(expectedRevision).toBe(5);
        expect(config.active_recovery).toBeUndefined();
        expect(config.last_recovery).toMatchObject({ request_id: 'request-a', recovery_id: 'recovery-a',
          worker_name: 'worker-1', owner_epoch: 2, owner_nonce: 'owner-nonce', phase: 'failed', state_revision: 6 });
        persistedConfig = config;
        order.push('cleanup');
        await afterCommit?.();
        return true;
      },
      publishFinal: (_input, _recoveryId, published) => { order.push('final'); return published; },
    })).resolves.toBe(result);
    expect(order).toEqual(['cleanup', 'final']);
  });

  it('retains the bound attempt and suppresses final publication when terminal cleanup is uncertain', async () => {
    const config = activeConfig();
    const publishFinal = vi.fn();
    const result = { outcome: 'failed' as const, committed: false as const, error: 'worker_not_found' as const,
      requestId: 'request-a', recoveryId: 'recovery-a', teamName: 'recovery-team', workerName: 'worker-1',
      updatedAt: new Date().toISOString() };

    await expect(finalizeRecoveryOwnerResult(ownerInput, 'recovery-a', result, {
      readRevisionedConfig: async () => ({ config, stateRevision: 5 }),
      saveConfigAtRevision: async () => { throw new Error('projection unavailable'); },
      publishFinal,
    })).resolves.toMatchObject({ outcome: 'commit_unknown', error: 'stale_state_revision' });
    expect(config.active_recovery).toMatchObject({ recovery_id: 'recovery-a' });
    expect(publishFinal).not.toHaveBeenCalled();
  });

  it('does not clear an active recovery whose owner fence differs from the authoritative owner', async () => {
    const config = activeConfig();
    config.active_recovery = { ...config.active_recovery!, owner_nonce: 'stale-owner' };
    const saveConfigAtRevision = vi.fn(async () => true);
    const publishFinal = vi.fn();
    const result = { outcome: 'failed' as const, committed: false as const, error: 'team_session_dead' as const,
      requestId: 'request-a', recoveryId: 'recovery-a', teamName: 'recovery-team', workerName: 'worker-1',
      updatedAt: new Date().toISOString() };

    await expect(finalizeRecoveryOwnerResult(ownerInput, 'recovery-a', result, {
      readRevisionedConfig: async () => ({ config, stateRevision: 5 }),
      saveConfigAtRevision,
      publishFinal,
    })).resolves.toMatchObject({ outcome: 'commit_unknown', error: 'stale_state_revision' });
    expect(config.active_recovery).toMatchObject({ recovery_id: 'recovery-a', owner_nonce: 'stale-owner' });
    expect(saveConfigAtRevision).not.toHaveBeenCalled();
    expect(publishFinal).not.toHaveBeenCalled();
  });

  it('does not publish final success when terminal cleanup loses the revision race', async () => {
    const publishFinal = vi.fn();
    const result = { outcome: 'already_running' as const, committed: true as const, oldPaneId: '%1', newPaneId: '%1',
      requeuedTaskIds: [], continuationSequenceByTask: {}, stateRevision: 5, activation: 'active' as const,
      manifestSync: 'synced' as const, servicesSync: 'synced' as const, warnings: [], requestId: 'request-a',
      recoveryId: 'recovery-a', teamName: 'recovery-team', workerName: 'worker-1', updatedAt: new Date().toISOString() };

    const finalized = await finalizeRecoveryOwnerResult(ownerInput, 'recovery-a', result, {
      readRevisionedConfig: async () => ({ config: activeConfig(), stateRevision: 5 }),
      saveConfigAtRevision: async () => false,
      publishFinal,
    });

    expect(finalized).toMatchObject({ outcome: 'commit_unknown', error: 'stale_state_revision' });
    expect(publishFinal).not.toHaveBeenCalled();
  });

  it('publishes when prior cleanup already committed this recovery as last_recovery', async () => {
    const config = activeConfig();
    config.last_recovery = { ...config.active_recovery!, phase: 'adopted', state_revision: 6 };
    config.active_recovery = undefined;
    const result = { outcome: 'already_running' as const, committed: true as const, oldPaneId: '%1', newPaneId: '%1',
      requeuedTaskIds: [], continuationSequenceByTask: {}, stateRevision: 5, activation: 'active' as const,
      manifestSync: 'synced' as const, servicesSync: 'synced' as const, warnings: [], requestId: 'request-a',
      recoveryId: 'recovery-a', teamName: 'recovery-team', workerName: 'worker-1', updatedAt: new Date().toISOString() };
    const publishFinal = vi.fn((_input, _recoveryId, published) => published);
    const saveConfigAtRevision = vi.fn(async () => true);

    await expect(finalizeRecoveryOwnerResult(ownerInput, 'recovery-a', result, {
      readRevisionedConfig: async () => ({ config, stateRevision: 6 }),
      saveConfigAtRevision,
      withConfigLock: async (_teamName, _cwd, fn) => fn(),
      publishFinal,
    })).resolves.toBe(result);
    expect(saveConfigAtRevision).not.toHaveBeenCalled();
    expect(publishFinal).toHaveBeenCalledTimes(1);
  });

  it('does not publish when the recovery is neither active nor the revision-checked last attempt', async () => {
    const publishFinal = vi.fn();
    const config = activeConfig();
    config.active_recovery = undefined;
    config.last_recovery = { ...activeConfig().active_recovery!, recovery_id: 'other-recovery', phase: 'adopted' };
    const result = { outcome: 'already_running' as const, committed: true as const, oldPaneId: '%1', newPaneId: '%1',
      requeuedTaskIds: [], continuationSequenceByTask: {}, stateRevision: 5, activation: 'active' as const,
      manifestSync: 'synced' as const, servicesSync: 'synced' as const, warnings: [], requestId: 'request-a',
      recoveryId: 'recovery-a', teamName: 'recovery-team', workerName: 'worker-1', updatedAt: new Date().toISOString() };

    const finalized = await finalizeRecoveryOwnerResult(ownerInput, 'recovery-a', result, {
      readRevisionedConfig: async () => ({ config, stateRevision: 5 }),
      saveConfigAtRevision: async () => true,
      publishFinal,
    });

    expect(finalized).toMatchObject({ outcome: 'commit_unknown', error: 'stale_state_revision' });
    expect(publishFinal).not.toHaveBeenCalled();
  });

  it.each([
    ['request id', (last: NonNullable<TeamConfig['last_recovery']>) => { last.request_id = 'other-request'; }],
    ['recovery id', (last: NonNullable<TeamConfig['last_recovery']>) => { last.recovery_id = 'other-recovery'; }],
    ['worker name', (last: NonNullable<TeamConfig['last_recovery']>) => { last.worker_name = 'worker-2'; }],
    ['owner epoch', (last: NonNullable<TeamConfig['last_recovery']>) => { last.owner_epoch = 3; }],
    ['owner nonce', (last: NonNullable<TeamConfig['last_recovery']>) => { last.owner_nonce = 'other-owner'; }],
    ['terminal phase', (last: NonNullable<TeamConfig['last_recovery']>) => { last.phase = 'failed'; }],
    ['embedded revision', (last: NonNullable<TeamConfig['last_recovery']>) => { last.state_revision = 5; }],
  ])('does not publish a prior cleanup with mismatched %s evidence', async (_name, mutate) => {
    const config = activeConfig();
    config.state_revision = 6;
    config.last_recovery = { ...config.active_recovery!, phase: 'adopted', state_revision: 6 };
    config.active_recovery = undefined;
    mutate(config.last_recovery);
    const publishFinal = vi.fn((_input, _recoveryId, published) => published);
    const result = { outcome: 'already_running' as const, committed: true as const, oldPaneId: '%1', newPaneId: '%1',
      requeuedTaskIds: [], continuationSequenceByTask: {}, stateRevision: 6, activation: 'active' as const,
      manifestSync: 'synced' as const, servicesSync: 'synced' as const, warnings: [], requestId: 'request-a',
      recoveryId: 'recovery-a', teamName: 'recovery-team', workerName: 'worker-1', updatedAt: new Date().toISOString() };

    const finalized = await finalizeRecoveryOwnerResult(ownerInput, 'recovery-a', result, {
      readRevisionedConfig: async () => ({ config, stateRevision: 6 }),
      saveConfigAtRevision: async () => true,
      withConfigLock: async (_teamName, _cwd, fn) => fn(),
      publishFinal,
    });
    expect(finalized).toMatchObject({ outcome: 'commit_unknown', error: 'stale_state_revision' });
    expect(publishFinal).not.toHaveBeenCalled();
  });
});

describe('committed replacement pane replay', () => {
  it('resumes the exact committed pane and pane-attempt identity', () => {
    const config = activeConfig();
    const worker = { name: 'worker-1', index: 1, pane_id: '%9', pane_attempt_id: 'attempt-a',
      recovery_id: 'recovery-a', replacement_generation: 2 } as WorkerInfo;

    expect(resolveCommittedRecoveryPaneAttempt(config.active_recovery, 'recovery-a', 2, worker))
      .toEqual({ paneId: '%9', paneAttemptId: 'attempt-a' });
    expect(resolveCommittedRecoveryPaneAttempt(config.active_recovery, 'other-recovery', 2, worker)).toBeNull();
    expect(resolveCommittedRecoveryPaneAttempt(config.active_recovery, 'recovery-a', 3, worker)).toBeNull();
    expect(resolveCommittedRecoveryPaneAttempt(config.active_recovery, 'recovery-a', 2,
      { ...worker, recovery_id: 'older-recovery' })).toBeNull();
  });

  it('does not select unrelated live replacement claims during committed replay', () => {
    const unrelated = { id: '9', subject: 'new work', description: 'unrelated', status: 'in_progress',
      owner: 'worker-1' } as TeamTask;
    const reserved = { id: '1', subject: 'reserved', description: 'recovery', status: 'pending',
      recovery_reservation: { recovery_id: 'recovery-a' } } as TeamTask;
    const adopted = { id: '2', subject: 'adopted', description: 'recovery', status: 'in_progress', owner: 'worker-1',
      recovery_adoption: { recovery_id: 'recovery-a' } } as TeamTask;

    expect(selectRecoveryReplayTasks([unrelated, reserved, adopted], 'worker-1', 'recovery-a', 'alive').map(task => task.id))
      .toEqual(['1', '2']);
    expect(selectRecoveryReplayTasks([unrelated, reserved, adopted], 'worker-1', 'recovery-a', 'unknown').map(task => task.id))
      .toEqual(['1', '2']);
    expect(selectRecoveryReplayTasks([unrelated, reserved, adopted], 'worker-1', 'recovery-a', 'dead').map(task => task.id))
      .toEqual(['9', '1', '2']);
  });

  it('degrades post-commit manifest read exceptions without reopening rollback', async () => {
    await expect(resolveCommittedRecoveryManifestSync(async () => { throw new Error('manifest unavailable'); }, {
      workerName: 'worker-1', paneId: '%9', paneAttemptId: 'attempt-a', recoveryId: 'recovery-a', replacementGeneration: 2,
    })).resolves.toBe('repair_required');
  });
});
