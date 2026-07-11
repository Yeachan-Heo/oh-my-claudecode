import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeTeamApiOperation } from '../api-interop.js';
import {
  MAX_TASK_RECOVERY_CHECKPOINT_BYTES,
  publishTaskRecoveryCheckpoint,
  readTaskRecoveryCheckpoint,
  selectTaskRecoveryCheckpoint,
  taskRecoveryClaimTokenHash,
} from '../task-recovery-checkpoint.js';
import { TeamPaths, absPath } from '../state-paths.js';
import type { TeamTaskV2 } from '../types.js';

const teamName = 'recovery-team';
const taskId = '1';
const workerName = 'worker-1';
const claimToken = 'claim-token';
let cwd: string;

function task(): TeamTaskV2 {
  return {
    id: taskId, subject: 'Recover', description: 'Recover safely', status: 'in_progress',
    owner: workerName, version: 3, claim: { owner: workerName, token: claimToken, leased_until: '2099-01-01T00:00:00.000Z' },
  } as TeamTaskV2;
}

const access = (current: TeamTaskV2 | null) => ({
  readTask: async () => current,
  withTaskLock: async <T>(_team: string, _task: string, _cwd: string, fn: () => Promise<T>) => ({ ok: true as const, value: await fn() }),
});

function input(sequence = 1, resumePayload: unknown = { cursor: 4 }) {
  return { teamName, taskId, workerName, taskVersion: 3, claimToken, sequence, resumePayload, updatedAt: '2026-01-01T00:00:00.000Z' };
}

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'omc-checkpoint-')); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe('task recovery checkpoints', () => {
  it('authenticates publication against the exact live claim and stores it under the claim-scoped path', async () => {
    const denied = await publishTaskRecoveryCheckpoint(input(), cwd, access({ ...task(), claim: { ...task().claim!, token: 'other' } }));
    expect(denied).toEqual({ ok: false, error: 'claim_conflict' });

    const published = await publishTaskRecoveryCheckpoint(input(), cwd, access(task()));
    expect(published).toMatchObject({ ok: true, replayed: false, checkpoint: { claim_token: claimToken, sequence: 1, task_version: 3 } });
    if (published.ok) expect(published.path).toBe(absPath(cwd, TeamPaths.checkpoint(teamName, taskId, taskRecoveryClaimTokenHash(claimToken), 1)));
  });

  it('enforces the 64 KiB payload boundary and immutable same-sequence replay/conflict', async () => {
    expect((await publishTaskRecoveryCheckpoint(input(1, 'x'.repeat(MAX_TASK_RECOVERY_CHECKPOINT_BYTES + 1)), cwd, access(task())))).toEqual({ ok: false, error: 'invalid_checkpoint' });
    const first = await publishTaskRecoveryCheckpoint(input(1, { a: 1 }), cwd, access(task()));
    expect(first).toMatchObject({ ok: true, replayed: false });
    const retryWithoutTimestamp = { ...input(1, { a: 1 }), updatedAt: undefined };
    await new Promise(resolve => setTimeout(resolve, 2));
    const replayed = await publishTaskRecoveryCheckpoint(retryWithoutTimestamp, cwd, access(task()));
    expect(replayed).toMatchObject({ ok: true, replayed: true });
    if (first.ok && replayed.ok) expect(replayed.checkpoint.updated_at).toBe(first.checkpoint.updated_at);
    expect(await publishTaskRecoveryCheckpoint(input(1, { a: 2 }), cwd, access(task()))).toEqual({ ok: false, error: 'publication_conflict' });
  });

  it('replays the public checkpoint operation after time advances', async () => {
    const taskPath = absPath(cwd, TeamPaths.taskFile(teamName, taskId));
    mkdirSync(join(taskPath, '..'), { recursive: true });
    writeFileSync(taskPath, JSON.stringify(task()));
    const previousWorker = process.env.OMC_TEAM_WORKER;
    process.env.OMC_TEAM_WORKER = `${teamName}/${workerName}`;
    const args = {
      team_name: teamName,
      task_id: taskId,
      worker: workerName,
      claim_token: claimToken,
      task_version: 3,
      sequence: 1,
      resume_payload: { cursor: 4 },
    };
    try {
      const first = await executeTeamApiOperation('write-task-checkpoint', args, cwd);
      expect(first).toMatchObject({ ok: true, data: { replayed: false } });
      await new Promise(resolve => setTimeout(resolve, 2));
      const second = await executeTeamApiOperation('write-task-checkpoint', args, cwd);
      expect(second).toMatchObject({ ok: true, data: { replayed: true } });
      if (first.ok && second.ok) {
        const firstData = first.data as { checkpoint: { updated_at: string } };
        const secondData = second.data as { checkpoint: { updated_at: string } };
        expect(secondData.checkpoint.updated_at).toBe(firstData.checkpoint.updated_at);
      }
    } finally {
      if (previousWorker === undefined) delete process.env.OMC_TEAM_WORKER;
      else process.env.OMC_TEAM_WORKER = previousWorker;
    }
  });

  it('rejects a sole checkpoint whose embedded sequence disagrees with its immutable filename', async () => {
    const first = await publishTaskRecoveryCheckpoint(input(1, { cursor: 1 }), cwd, access(task()));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const original = JSON.parse(readFileSync(first.path, 'utf8'));
    writeFileSync(first.path, JSON.stringify({ ...original, sequence: 2 }));
    await expect(readTaskRecoveryCheckpoint(first.path)).resolves.toEqual({ ok: false, error: 'malformed' });
    await expect(selectTaskRecoveryCheckpoint(teamName, task(), cwd)).resolves.toEqual({ ok: false, error: 'malformed' });
    await expect(publishTaskRecoveryCheckpoint(input(1, { cursor: 1 }), cwd, access(task())))
      .resolves.toEqual({ ok: false, error: 'publication_conflict' });
  });

  it('selects only a unique current highest checkpoint and ignores a stale latest projection after a projection-write crash', async () => {
    await publishTaskRecoveryCheckpoint(input(1, { cursor: 1 }), cwd, access(task()));
    await publishTaskRecoveryCheckpoint(input(2, { cursor: 2 }), cwd, access(task()));
    const root = absPath(cwd, TeamPaths.checkpoints(teamName, taskId, taskRecoveryClaimTokenHash(claimToken)));
    writeFileSync(join(root, 'latest.json'), JSON.stringify({ sequence: 1, path: 'stale' }));
    await expect(selectTaskRecoveryCheckpoint(teamName, task(), cwd)).resolves.toMatchObject({ ok: true, checkpoint: { sequence: 2 } });
  });

  it('distinguishes missing, malformed, and stale checkpoint sets', async () => {
    await expect(selectTaskRecoveryCheckpoint(teamName, task(), cwd)).resolves.toEqual({ ok: false, error: 'missing' });
    const root = absPath(cwd, TeamPaths.checkpoints(teamName, taskId, taskRecoveryClaimTokenHash(claimToken)));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '1.json'), '{bad');
    await expect(selectTaskRecoveryCheckpoint(teamName, task(), cwd)).resolves.toEqual({ ok: false, error: 'malformed' });
    rmSync(root, { recursive: true });
    await publishTaskRecoveryCheckpoint(input(1), cwd, access(task()));
    await expect(selectTaskRecoveryCheckpoint(teamName, { ...task(), version: 4 }, cwd)).resolves.toEqual({ ok: false, error: 'stale' });
  });
});
