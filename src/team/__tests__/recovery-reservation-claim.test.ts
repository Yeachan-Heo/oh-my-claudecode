import { describe, expect, it } from 'vitest';

import { adoptRecoveryReservations, claimTask, releaseTaskClaim, requeueRecoveredTask } from '../state/tasks.js';
import type { RecoveryTaskTransitionDeps } from '../state/tasks.js';
import type { TeamTaskV2 } from '../types.js';

const teamName = 'recovery-team';
const token = 'old-token';
const checkpoint = { schema_version: 1 as const, team_name: teamName, task_id: '1', worker_name: 'dead-worker', sequence: 4, task_version: 3, claim_token: token, resume_payload_hash: 'checkpoint-hash', resume_payload: { cursor: 4 }, updated_at: '2026-01-01T00:00:00.000Z' };
const liveTask = (): TeamTaskV2 => ({ id: '1', subject: 'Recover', description: 'task', status: 'in_progress', owner: 'dead-worker', version: 3, claim: { owner: 'dead-worker', token, leased_until: '2099-01-01T00:00:00.000Z' } } as TeamTaskV2);
const recoveryInput = { recoveryId: 'recovery', requestId: 'request', taskId: '1', replacementWorker: 'replacement', replacementGeneration: 2, adoptionTokenHash: 'adoption-hash' };

function deps(tasks: Record<string, TeamTaskV2>, sidecars: Record<string, any> = {}, writes: string[] = []): RecoveryTaskTransitionDeps {
  return {
    teamName, cwd: '/unused', readTeamConfig: async () => ({ workers: [{ name: 'dead-worker' }, { name: 'replacement' }, { name: 'generic' }] }),
    readTask: async (_team, id) => tasks[id] ?? null,
    withTaskClaimLock: async (_team, _id, _cwd, fn) => ({ ok: true as const, value: await fn() }),
    normalizeTask: (value) => value as TeamTaskV2, isTerminalTaskStatus: () => false, taskFilePath: (_team, id) => id,
    writeAtomic: async (path, data) => { writes.push(path); tasks[path] = JSON.parse(data) as TeamTaskV2; },
    readRecoverySidecar: async (_team, recoveryId, id) => sidecars[`${recoveryId}:${id}`] ?? null,
    writeRecoverySidecar: async (_team, recoveryId, id, sidecar) => { writes.push(`sidecar:${recoveryId}:${id}`); sidecars[`${recoveryId}:${id}`] = sidecar; },
    selectRecoveryCheckpoint: async () => ({ ok: true as const, checkpoint, path: '/checkpoint' }),
    readRecoveryCheckpoint: async () => ({ ok: true as const, checkpoint, path: '/checkpoint' }),
    verifyAdoptionToken: (candidate, hash) => candidate === 'adoption-token' && hash === 'adoption-hash',
  };
}

describe('recovery reservation claim protocol', () => {
  it('writes a sidecar before the pending+reserved task projection and replays each crash boundary safely', async () => {
    const tasks = { '1': liveTask() }; const sidecars: Record<string, any> = {}; const writes: string[] = []; const d = deps(tasks, sidecars, writes);
    const first = await requeueRecoveredTask(recoveryInput, d);
    expect(first).toMatchObject({ ok: true, replayed: false, task: { status: 'pending', owner: undefined, claim: undefined, recovery_reservation: { replacement_generation: 2, adoption_token_hash: 'adoption-hash' } } });
    expect(writes).toEqual(['sidecar:recovery:1', '1']);
    expect(await requeueRecoveredTask(recoveryInput, d)).toMatchObject({ ok: true, replayed: true });

    const precommitTasks = { '1': liveTask() }; const precommitSidecars = { 'recovery:1': sidecars['recovery:1'] }; const repaired = await requeueRecoveredTask(recoveryInput, deps(precommitTasks, precommitSidecars));
    expect(repaired).toMatchObject({ ok: true, replayed: false, task: { status: 'pending', recovery_reservation: { replacement_worker: 'replacement' } } });
    const inconsistent = { '1': { ...liveTask(), version: 99 } };
    expect(await requeueRecoveredTask(recoveryInput, deps(inconsistent, precommitSidecars))).toEqual({ ok: false, error: 'task_requeue_failed' });
  });

  it('uses an immutable sidecar for each recovery attempt of the same task', async () => {
    const tasks = { '1': liveTask() }; const sidecars: Record<string, any> = {}; const writes: string[] = [];
    const d = deps(tasks, sidecars, writes);
    const r1 = await requeueRecoveredTask(recoveryInput, d);
    expect(r1).toMatchObject({ ok: true, replayed: false });
    const adopted = await adoptRecoveryReservations(['1'], 'replacement', {
      recoveryId: 'recovery', requestId: 'request', replacementGeneration: 2, adoptionToken: 'adoption-token',
    }, d);
    expect(adopted[0]).toMatchObject({ ok: true, replayed: false });
    const adoptedClaimToken = tasks['1'].claim!.token;
    expect(await releaseTaskClaim('1', adoptedClaimToken, 'replacement', d)).toMatchObject({ ok: true });
    expect(await claimTask('1', 'dead-worker', 6, d)).toMatchObject({ ok: true });

    const r2Input = { ...recoveryInput, recoveryId: 'recovery-2', requestId: 'request-2', replacementGeneration: 3 };
    await expect(requeueRecoveredTask(r2Input, d)).resolves.toMatchObject({
      ok: true, replayed: false, task: { status: 'pending', recovery_reservation: { recovery_id: 'recovery-2', replacement_generation: 3 } },
    });
    expect(sidecars['recovery:1']).toMatchObject({ recovery_id: 'recovery', old_task_version: 3 });
    expect(sidecars['recovery-2:1']).toMatchObject({ recovery_id: 'recovery-2', old_task_version: 7 });
    expect(writes).toContain('sidecar:recovery-2:1');
  });

  it('rejects generic claims while the pending reservation remains and preserves retry generation/token tuple', async () => {
    const reserved = { ...liveTask(), status: 'pending' as const, owner: undefined, claim: undefined, version: 4, recovery_reservation: { recovery_id: 'recovery', request_id: 'request', continuation_sequence: 4, checkpoint_path: '/checkpoint', checkpoint_hash: 'checkpoint-hash', replacement_worker: 'replacement', replacement_generation: 2, adoption_token_hash: 'adoption-hash', reserved_at: '2026-01-01T00:00:00.000Z' } };
    const tasks = { '1': reserved };
    expect(await claimTask('1', 'generic', 4, deps(tasks))).toEqual({ ok: false, error: 'claim_conflict' });
    expect(tasks['1'].recovery_reservation).toMatchObject({ replacement_generation: 2, adoption_token_hash: 'adoption-hash' });
  });

  it('adopts runtime-owned reservations in task-id order, rejects wrong token/generation, and replays an already adopted prefix', async () => {
    const reservation = () => ({ recovery_id: 'recovery', request_id: 'request', continuation_sequence: 4, checkpoint_path: '/checkpoint', checkpoint_hash: 'checkpoint-hash', replacement_worker: 'replacement', replacement_generation: 2, adoption_token_hash: 'adoption-hash', reserved_at: '2026-01-01T00:00:00.000Z' });
    const tasks: Record<string, TeamTaskV2> = {
      '1': { ...liveTask(), id: '1', status: 'pending', owner: undefined, claim: undefined, version: 4, recovery_reservation: reservation() },
      '2': { ...liveTask(), id: '2', status: 'pending', owner: undefined, claim: undefined, version: 4, recovery_reservation: reservation() },
    };
    const d = deps(tasks);
    expect((await adoptRecoveryReservations(['2', '1'], 'replacement', { recoveryId: 'recovery', requestId: 'request', replacementGeneration: 3, adoptionToken: 'adoption-token' }, d))[0]).toEqual({ ok: false, error: 'claim_conflict' });
    expect((await adoptRecoveryReservations(['2', '1'], 'replacement', { recoveryId: 'recovery', requestId: 'request', replacementGeneration: 2, adoptionToken: 'wrong' }, d))[0]).toEqual({ ok: false, error: 'claim_conflict' });
    const adopted = await adoptRecoveryReservations(['2', '1'], 'replacement', { recoveryId: 'recovery', requestId: 'request', replacementGeneration: 2, adoptionToken: 'adoption-token' }, d);
    expect(adopted.map((result) => result.ok)).toEqual([true, true]);
    expect(tasks['1']).toMatchObject({ status: 'in_progress', owner: 'replacement', recovery_adoption: { replacement_generation: 2 } });
    const replay = await adoptRecoveryReservations(['1', '2'], 'replacement', { recoveryId: 'recovery', requestId: 'request', replacementGeneration: 2, adoptionToken: 'adoption-token' }, d);
    expect(replay.map((result) => result.ok && result.replayed)).toEqual([true, true]);
  });
});
