import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRecoverySaga, type RecoverySagaDependencies, type RecoverySagaInput } from '../recovery-saga.js';
import { readRecoveryOutcome, reserveRecoveryRequest } from '../recovery-request-store.js';
import type { TeamTask } from '../types.js';

let cwd: string;
const input: RecoverySagaInput = {
  requestId: 'request-a',
  recoveryId: 'recovery-a',
  teamName: 'team-a',
  workerName: 'worker-1',
  replacementGeneration: 2,
  adoptionToken: 'secret-token',
  originalPaneId: '%old-worker-pane',
};
const task = {
  id: '1',
  subject: 'Continue safely',
  description: 'Resume from checkpoint',
  status: 'in_progress',
  owner: 'worker-1',
  version: 3,
} as TeamTask;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omc-recovery-saga-'));
  reserveRecoveryRequest(cwd, input.requestId, { operation: 'recover-worker', workspaceHash: 'a'.repeat(64),
    teamName: input.teamName, workerName: input.workerName }, input.recoveryId);
});
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

function dependencies(order: string[], overrides: Partial<RecoverySagaDependencies> = {}): RecoverySagaDependencies {
  return {
    cwd,
    getLiveness: async () => { order.push('liveness'); return 'dead'; },
    listOwnedInProgressTasks: async () => { order.push('list'); return [task]; },
    validateCheckpoint: async () => { order.push('validate'); return { ok: true, sequence: 4 }; },
    requeue: async () => { order.push('requeue'); return { ok: true, sequence: 4 }; },
    spawnGatedPane: async () => { order.push('spawn'); return { ok: true, paneId: '%9', paneAttemptId: 'attempt-a', committed: false }; },
    persistActive: async () => { order.push('persist'); return { stateRevision: 8, manifestSync: 'synced' }; },
    activatePane: async () => { order.push('activate'); return { ok: true }; },
    adoptAll: async () => {
      order.push('adopt');
      return { ok: true, continuations: [{ taskId: '1', taskVersion: 1, sequence: 4, payload: { cursor: 10 }, claimToken: 'new-claim' }] };
    },
    repairServices: async () => { order.push('repair'); return 'synced'; },
    writeRun: async (_sagaInput, _attempt, continuations) => {
      order.push(`run:${continuations[0]?.claimToken ?? 'idle'}`);
    },
    killAttemptPane: async () => { order.push('kill'); },
    ...overrides,
  };
}

describe('recovery saga ordering and rollback contract', () => {
  it('commits replacement identity, adopts every continuation, repairs services, then permits provider execution', async () => {
    const order: string[] = [];
    const result = await runRecoverySaga(input, dependencies(order));

    expect(result).toMatchObject({
      outcome: 'recovered',
      committed: true,
      oldPaneId: '%old-worker-pane',
      newPaneId: '%9',
      activation: 'active',
      requeuedTaskIds: ['1'],
    });
    expect(order).toEqual(['liveness', 'list', 'validate', 'requeue', 'spawn', 'persist', 'activate', 'adopt', 'repair', 'run:new-claim']);
  });

  it('kills only the uncommitted pane attempt when config persistence fails', async () => {
    const order: string[] = [];
    const result = await runRecoverySaga(input, dependencies(order, {
      persistActive: async () => { order.push('persist'); throw new Error('disk full'); },
    }));

    expect(result).toMatchObject({ outcome: 'failed', committed: false, error: 'config_commit_failed' });
    expect(order).toEqual(['liveness', 'list', 'validate', 'requeue', 'spawn', 'persist', 'kill']);
  });

  it('does not activate or run the provider when the committed manifest projection is unverified', async () => {
    const order: string[] = [];
    const result = await runRecoverySaga(input, dependencies(order, {
      persistActive: async () => { order.push('persist'); return { stateRevision: 8, manifestSync: 'repair_required' }; },
    }));

    expect(result).toMatchObject({ outcome: 'commit_unknown', error: 'config_commit_failed' });
    expect(order).toEqual(['liveness', 'list', 'validate', 'requeue', 'spawn', 'persist']);
  });

  it('resumes a committed pane without repeating config persistence or rollback killing', async () => {
    const order: string[] = [];
    const result = await runRecoverySaga(input, dependencies(order, {
      spawnGatedPane: async () => { order.push('spawn'); return { ok: true, paneId: '%9', paneAttemptId: 'attempt-a', committed: true, stateRevision: 8, manifestSync: 'synced' }; },
      persistActive: async () => { order.push('persist'); throw new Error('must not persist committed pane'); },
    }));

    expect(result).toMatchObject({ outcome: 'recovered', committed: true, oldPaneId: '%old-worker-pane', newPaneId: '%9' });
    expect(order).toEqual(['liveness', 'list', 'validate', 'requeue', 'spawn', 'activate', 'adopt', 'repair', 'run:new-claim']);
    expect(order).not.toContain('kill');
  });

  it('does not kill a committed replacement or start its provider when adoption is incomplete', async () => {
    const order: string[] = [];
    const result = await runRecoverySaga(input, dependencies(order, {
      adoptAll: async () => { order.push('adopt'); return { ok: false, error: 'worker_activation_failed' }; },
    }));

    expect(result).toMatchObject({ outcome: 'commit_unknown', committed: false, error: 'worker_activation_failed' });
    expect(order).toEqual(['liveness', 'list', 'validate', 'requeue', 'spawn', 'persist', 'activate', 'adopt']);
    expect(order).not.toContain('kill');
  });

  it('uses the neutral startup branch for an idle dead worker without checkpoint or adoption', async () => {
    const order: string[] = [];
    const result = await runRecoverySaga(input, dependencies(order, {
      listOwnedInProgressTasks: async () => { order.push('list'); return []; },
    }));

    expect(result).toMatchObject({
      outcome: 'recovered',
      oldPaneId: '%old-worker-pane',
      newPaneId: '%9',
      requeuedTaskIds: [],
      continuationSequenceByTask: {},
    });
    expect(order).toEqual(['liveness', 'list', 'spawn', 'persist', 'activate', 'repair', 'run:idle']);
  });

  it('never treats unknown pane liveness as a dead worker', async () => {
    const order: string[] = [];
    const result = await runRecoverySaga(input, dependencies(order, {
      getLiveness: async () => { order.push('liveness'); return 'unknown'; },
    }));

    expect(result).toMatchObject({ outcome: 'failed', error: 'worker_liveness_unknown' });
    expect(order).toEqual(['liveness']);
  });

  it('replays the same recovery identity after a later task fails requeue', async () => {
    const order: string[] = [];
    const task2 = { ...task, id: '2', subject: 'Continue second task' } as TeamTask;
    let failSecond = true;
    const reserved = new Set<string>();
    const deps = dependencies(order, {
      listOwnedInProgressTasks: async () => [task, task2],
      validateCheckpoint: async (_teamName, candidate) => ({ ok: true, sequence: Number(candidate.id) + 3 }),
      requeue: async (_sagaInput, taskId) => {
        if (taskId === '2' && failSecond) {
          failSecond = false;
          return { ok: false, error: 'task_requeue_failed' };
        }
        reserved.add(taskId);
        return { ok: true, sequence: Number(taskId) + 3 };
      },
      adoptAll: async () => ({ ok: true, continuations: [
        { taskId: '1', taskVersion: 1, sequence: 4, payload: { cursor: 1 }, claimToken: 'claim-1' },
        { taskId: '2', taskVersion: 2, sequence: 5, payload: { cursor: 2 }, claimToken: 'claim-2' },
      ] }),
    });

    await expect(runRecoverySaga(input, deps)).resolves.toMatchObject({ outcome: 'failed', error: 'task_requeue_failed', reservationsWritten: true });
    expect(reserved).toEqual(new Set(['1']));
    expect(readRecoveryOutcome(cwd, input.requestId)).toMatchObject({ kind: 'phase', recovery_id: input.recoveryId,
      phase: 'requeued', continuation: 'reserved' });

    await expect(runRecoverySaga(input, deps)).resolves.toMatchObject({
      outcome: 'recovered',
      oldPaneId: '%old-worker-pane',
      newPaneId: '%9',
      requeuedTaskIds: ['1', '2'],
    });
    expect(reserved).toEqual(new Set(['1', '2']));
  });
});
