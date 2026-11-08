import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { TeamPaths, absPath } from './state-paths.js';
import type { TaskRecoveryCheckpoint, TaskRecoveryCheckpointValidation, TeamTaskV2 } from './types.js';

export const MAX_TASK_RECOVERY_CHECKPOINT_BYTES = 64 * 1024;

export interface PublishTaskRecoveryCheckpointInput {
  teamName: string;
  taskId: string;
  workerName: string;
  taskVersion: number;
  claimToken: string;
  sequence: number;
  resumePayload: unknown;
  updatedAt?: string;
}

export interface TaskRecoveryCheckpointTaskAccess {
  readTask: (teamName: string, taskId: string, cwd: string) => Promise<TeamTaskV2 | null>;
  withTaskLock: <T>(teamName: string, taskId: string, cwd: string, fn: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false }>;
}

export type PublishTaskRecoveryCheckpointResult =
  | { ok: true; checkpoint: TaskRecoveryCheckpoint; path: string; replayed: boolean }
  | { ok: false; error: 'claim_conflict' | 'invalid_checkpoint' | 'publication_conflict' };

function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (current: unknown): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('Checkpoint payload must be finite JSON');
      return current;
    }
    if (Array.isArray(current)) return current.map(normalize);
    if (typeof current === 'object') {
      if (seen.has(current)) throw new TypeError('Checkpoint payload must not contain cycles');
      seen.add(current);
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(current as Record<string, unknown>).sort()) {
        const child = (current as Record<string, unknown>)[key];
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') {
          throw new TypeError('Checkpoint payload must be JSON');
        }
        output[key] = normalize(child);
      }
      seen.delete(current);
      return output;
    }
    throw new TypeError('Checkpoint payload must be JSON');
  };
  return JSON.stringify(normalize(value));
}

export function hashTaskRecoveryCheckpointPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function taskRecoveryClaimTokenHash(claimToken: string): string {
  return createHash('sha256').update(claimToken).digest('hex');
}

function checkpointPath(cwd: string, teamName: string, taskId: string, claimToken: string, sequence: number): string {
  return absPath(cwd, TeamPaths.checkpoint(teamName, taskId, taskRecoveryClaimTokenHash(claimToken), sequence));
}

function latestPath(cwd: string, teamName: string, taskId: string, claimToken: string): string {
  return absPath(cwd, TeamPaths.checkpointLatest(teamName, taskId, taskRecoveryClaimTokenHash(claimToken)));
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
  await syncDirectory(path);
}

async function publishImmutableCheckpoint(path: string, content: string): Promise<'created' | 'replayed' | 'conflict'> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temp, path);
    if (await readFile(path, 'utf8') !== content) return 'conflict';
    await syncDirectory(path);
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return await readFile(path, 'utf8').catch(() => '') === content ? 'replayed' : 'conflict';
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

function parseCheckpoint(value: unknown): TaskRecoveryCheckpoint | null {
  if (!value || typeof value !== 'object') return null;
  const checkpoint = value as Partial<TaskRecoveryCheckpoint>;
  const sequence = checkpoint.sequence;
  const taskVersion = checkpoint.task_version;
  if (checkpoint.schema_version !== 1 || typeof checkpoint.team_name !== 'string' || typeof checkpoint.task_id !== 'string'
    || typeof checkpoint.worker_name !== 'string' || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= 0
    || typeof taskVersion !== 'number' || !Number.isSafeInteger(taskVersion) || taskVersion <= 0 || typeof checkpoint.claim_token !== 'string'
    || typeof checkpoint.resume_payload_hash !== 'string' || typeof checkpoint.updated_at !== 'string') return null;
  try {
    if (hashTaskRecoveryCheckpointPayload(checkpoint.resume_payload) !== checkpoint.resume_payload_hash) return null;
  } catch {
    return null;
  }
  return checkpoint as TaskRecoveryCheckpoint;
}

function sameCheckpointPublication(
  existing: TaskRecoveryCheckpoint,
  candidate: TaskRecoveryCheckpoint,
): boolean {
  const { updated_at: _existingUpdatedAt, ...existingSemantic } = existing;
  const { updated_at: _candidateUpdatedAt, ...candidateSemantic } = candidate;
  return canonicalJson(existingSemantic) === canonicalJson(candidateSemantic);
}

function checkpointSequenceFromPath(path: string): number | null {
  const match = /^(\d+)\.json$/.exec(basename(path));
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

async function readCheckpoint(path: string): Promise<TaskRecoveryCheckpoint | null> {
  const filenameSequence = checkpointSequenceFromPath(path);
  if (filenameSequence === null) return null;
  try {
    const checkpoint = parseCheckpoint(JSON.parse(await readFile(path, 'utf8')) as unknown);
    return checkpoint?.sequence === filenameSequence ? checkpoint : null;
  } catch {
    return null;
  }
}

async function readCheckpointLatest(path: string): Promise<{ sequence: number } | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { sequence?: unknown };
    return Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0 ? { sequence: value.sequence as number } : null;
  } catch { return null; }
}

export async function publishTaskRecoveryCheckpoint(
  input: PublishTaskRecoveryCheckpointInput,
  cwd: string,
  access: TaskRecoveryCheckpointTaskAccess,
): Promise<PublishTaskRecoveryCheckpointResult> {
  if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0 || !Number.isSafeInteger(input.taskVersion) || input.taskVersion <= 0) {
    return { ok: false, error: 'invalid_checkpoint' };
  }
  let payloadHash: string;
  let payloadBytes: number;
  try {
    const serialized = canonicalJson(input.resumePayload);
    payloadBytes = Buffer.byteLength(serialized);
    payloadHash = createHash('sha256').update(serialized).digest('hex');
  } catch {
    return { ok: false, error: 'invalid_checkpoint' };
  }
  if (payloadBytes > MAX_TASK_RECOVERY_CHECKPOINT_BYTES) return { ok: false, error: 'invalid_checkpoint' };

  const lock = await access.withTaskLock(input.teamName, input.taskId, cwd, async () => {
    const task = await access.readTask(input.teamName, input.taskId, cwd);
    if (!task || task.status !== 'in_progress' || task.version !== input.taskVersion || task.owner !== input.workerName
      || !task.claim || task.claim.owner !== input.workerName || task.claim.token !== input.claimToken) {
      return { ok: false as const, error: 'claim_conflict' as const };
    }
    const checkpoint: TaskRecoveryCheckpoint = {
      schema_version: 1,
      team_name: input.teamName,
      task_id: input.taskId,
      worker_name: input.workerName,
      sequence: input.sequence,
      task_version: input.taskVersion,
      claim_token: input.claimToken,
      resume_payload_hash: payloadHash,
      resume_payload: input.resumePayload,
      updated_at: input.updatedAt ?? new Date().toISOString(),
    };
    const path = checkpointPath(cwd, input.teamName, input.taskId, input.claimToken, input.sequence);
    const existing = await readCheckpoint(path);
    if (existing) {
      if (!sameCheckpointPublication(existing, checkpoint)) {
        return { ok: false as const, error: 'publication_conflict' as const };
      }
      return { ok: true as const, checkpoint: existing, path, replayed: true };
    }
    const publication = await publishImmutableCheckpoint(path, JSON.stringify(checkpoint));
    if (publication !== 'created') {
      const replayed = await readCheckpoint(path);
      return replayed && sameCheckpointPublication(replayed, checkpoint)
        ? { ok: true as const, checkpoint: replayed, path, replayed: true }
        : { ok: false as const, error: 'publication_conflict' as const };
    }
    const latest = latestPath(cwd, input.teamName, input.taskId, input.claimToken);
    const existingLatest = await readCheckpointLatest(latest);
    if (!existingLatest || input.sequence >= existingLatest.sequence) {
      await writeAtomic(latest, JSON.stringify({ sequence: input.sequence, path, resume_payload_hash: payloadHash }));
    }
    return { ok: true as const, checkpoint, path, replayed: false };
  });
  return lock.ok ? lock.value : { ok: false, error: 'claim_conflict' };
}

export async function selectTaskRecoveryCheckpoint(
  teamName: string,
  task: TeamTaskV2,
  cwd: string,
): Promise<TaskRecoveryCheckpointValidation> {
  if (!task.owner || !task.claim) return { ok: false, error: 'stale' };
  const root = absPath(cwd, TeamPaths.checkpoints(teamName, task.id, taskRecoveryClaimTokenHash(task.claim.token)));
  if (!existsSync(root)) return { ok: false, error: 'missing' };
  let names: string[];
  try { names = await readdir(root); } catch { return { ok: false, error: 'malformed' }; }
  const paths = names.filter((name) => /^\d+\.json$/.test(name)).map((name) => `${root}/${name}`);
  if (paths.length === 0) return { ok: false, error: 'missing' };
  const parsed = await Promise.all(paths.map(async (path) => ({ path, checkpoint: await readCheckpoint(path) })));
  if (parsed.some(({ checkpoint }) => !checkpoint)) return { ok: false, error: 'malformed' };
  const valid = parsed as Array<{ path: string; checkpoint: TaskRecoveryCheckpoint }>;
  const matching = valid.filter(({ checkpoint }) => checkpoint.team_name === teamName && checkpoint.task_id === task.id
    && checkpoint.worker_name === task.owner && checkpoint.task_version === task.version && checkpoint.claim_token === task.claim?.token);
  if (matching.length === 0) return { ok: false, error: 'stale' };
  const highest = Math.max(...matching.map(({ checkpoint }) => checkpoint.sequence));
  const selected = matching.filter(({ checkpoint }) => checkpoint.sequence === highest);
  if (selected.length !== 1) return { ok: false, error: 'ambiguous' };
  const otherHighest = valid.filter(({ checkpoint }) => checkpoint.sequence === highest && checkpoint.resume_payload_hash !== selected[0].checkpoint.resume_payload_hash);
  if (otherHighest.length > 0) return { ok: false, error: 'ambiguous' };
  return { ok: true, checkpoint: selected[0].checkpoint, path: selected[0].path };
}

export async function readTaskRecoveryCheckpoint(path: string): Promise<TaskRecoveryCheckpointValidation> {
  const checkpoint = await readCheckpoint(path);
  return checkpoint ? { ok: true, checkpoint, path } : { ok: false, error: existsSync(path) ? 'malformed' : 'missing' };
}
