import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hashTaskRecoveryCheckpointPayload,
  MAX_TASK_RECOVERY_CHECKPOINT_BYTES,
  publishTaskRecoveryCheckpoint,
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
    expect(await publishTaskRecoveryCheckpoint(input(1, { a: 1 }), cwd, access(task()))).toMatchObject({ ok: true, replayed: true });
    expect(await publishTaskRecoveryCheckpoint(input(1, { a: 2 }), cwd, access(task()))).toEqual({ ok: false, error: 'publication_conflict' });
  });

  it('selects only a unique current highest checkpoint and ignores a stale latest projection after a projection-write crash', async () => {
    await publishTaskRecoveryCheckpoint(input(1, { cursor: 1 }), cwd, access(task()));
    await publishTaskRecoveryCheckpoint(input(2, { cursor: 2 }), cwd, access(task()));
    const root = absPath(cwd, TeamPaths.checkpoints(teamName, taskId, taskRecoveryClaimTokenHash(claimToken)));
    writeFileSync(join(root, 'latest.json'), JSON.stringify({ sequence: 1, path: 'stale' }));
    await expect(selectTaskRecoveryCheckpoint(teamName, task(), cwd)).resolves.toMatchObject({ ok: true, checkpoint: { sequence: 2 } });
  });

  it('distinguishes missing, malformed, stale, and ambiguous checkpoint sets', async () => {
    await expect(selectTaskRecoveryCheckpoint(teamName, task(), cwd)).resolves.toEqual({ ok: false, error: 'missing' });
    const root = absPath(cwd, TeamPaths.checkpoints(teamName, taskId, taskRecoveryClaimTokenHash(claimToken)));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '1.json'), '{bad');
    await expect(selectTaskRecoveryCheckpoint(teamName, task(), cwd)).resolves.toEqual({ ok: false, error: 'malformed' });
    rmSync(root, { recursive: true });
    await publishTaskRecoveryCheckpoint(input(1), cwd, access(task()));
    await expect(selectTaskRecoveryCheckpoint(teamName, { ...task(), version: 4 }, cwd)).resolves.toEqual({ ok: false, error: 'stale' });
    const source = absPath(cwd, TeamPaths.checkpoint(teamName, taskId, taskRecoveryClaimTokenHash(claimToken), 1));
    const original = JSON.parse(readFileSync(source, 'utf8'));
    const resumePayload = { cursor: 99 };
    writeFileSync(join(root, '2.json'), JSON.stringify({ ...original, sequence: 1, resume_payload: resumePayload, resume_payload_hash: hashTaskRecoveryCheckpointPayload(resumePayload) }));
    await expect(selectTaskRecoveryCheckpoint(teamName, task(), cwd)).resolves.toEqual({ ok: false, error: 'ambiguous' });
  });
});
