import { createHash, randomUUID } from 'crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import type { TeamConfig, TeamRecoveryAttempt, TeamRuntimeOwnerEpoch } from './types.js';
import { absPath, TeamPaths } from './state-paths.js';

export interface OwnerFence {
  epoch: number;
  nonce: string;
}

export interface OwnerEpochRecord extends TeamRuntimeOwnerEpoch {
  schema_version: 1;
  heartbeat?: { observed_at: string; detail?: string };
  payload_hash: string;
}

export interface OwnerEpochInput {
  pid?: number;
  processStartedAt?: string;
  nonce?: string;
  heartbeat?: OwnerEpochRecord['heartbeat'];
}

export type OwnerFenceCheck = { ok: true; record: OwnerEpochRecord } | { ok: false; reason: 'missing' | 'malformed' | 'superseded' | 'mismatch' };

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function recordBytes(record: Omit<OwnerEpochRecord, 'payload_hash'>): string {
  const payloadHash = digest(record);
  return canonicalize({ ...record, payload_hash: payloadHash });
}

function parseRecord(path: string): OwnerEpochRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as OwnerEpochRecord;
    if (parsed.schema_version !== 1 || !Number.isSafeInteger(parsed.epoch) || parsed.epoch < 1 || typeof parsed.nonce !== 'string' || typeof parsed.pid !== 'number' || typeof parsed.process_started_at !== 'string' || typeof parsed.payload_hash !== 'string') return null;
    const { payload_hash, ...unsigned } = parsed;
    return digest(unsigned) === payload_hash ? parsed : null;
  } catch {
    return null;
  }
}

export function currentProcessStartIdentity(pid: number = process.pid): string | null {
  if (process.platform !== 'linux') return null;
  try {
    // /proc/<pid>/stat's 22nd field is process start ticks. The command may contain spaces,
    // so consume everything through the final ')' before splitting the remaining fields.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export function isProcessIdentityDead(record: Pick<OwnerEpochRecord, 'pid' | 'process_started_at'>): boolean {
  try {
    process.kill(record.pid, 0);
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const observed = currentProcessStartIdentity(record.pid);
  // A live PID with an unavailable or different start identity is never proof of death.
  return observed !== null && observed !== record.process_started_at;
}

export function readLatestOwnerEpoch(cwd: string, teamName: string): OwnerEpochRecord | null {
  const directory = absPath(cwd, TeamPaths.ownerEpochs(teamName));
  if (!existsSync(directory)) return null;
  const epochs = readdirSync(directory)
    .map((name) => /^([1-9]\d*)\.json$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a);
  for (const epoch of epochs) {
    const record = parseRecord(join(directory, `${epoch}.json`));
    if (record) return record;
  }
  return null;
}

/** Publish a complete, canonical epoch through a hard link. Epoch files are never reclaimed. */
export function publishOwnerEpoch(cwd: string, teamName: string, epoch: number, input: OwnerEpochInput = {}): OwnerEpochRecord {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('invalid_owner_epoch');
  const target = absPath(cwd, TeamPaths.ownerEpoch(teamName, epoch));
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const start = input.processStartedAt ?? currentProcessStartIdentity(input.pid ?? process.pid);
  if (!start) throw new Error('process_start_identity_unavailable');
  const unsigned = {
    schema_version: 1 as const,
    epoch,
    nonce: input.nonce ?? randomUUID(),
    pid: input.pid ?? process.pid,
    process_started_at: start,
    created_at: new Date().toISOString(),
    ...(input.heartbeat ? { heartbeat: input.heartbeat } : {}),
  };
  const bytes = recordBytes(unsigned);
  const record = JSON.parse(bytes) as OwnerEpochRecord;
  const temp = join(dirname(target), `.${epoch}.${record.nonce}.${randomUUID()}.tmp`);
  writeFileSync(temp, bytes, { encoding: 'utf8', mode: 0o600, flush: true });
  try {
    linkSync(temp, target);
  } catch (error: unknown) {
    const existing = parseRecord(target);
    try { unlinkSync(temp); } catch { /* unique losing temp cleanup is best-effort */ }
    // A competing successor won this epoch. Returning its verified record makes the loser
    // observe the fence it does not hold rather than attempting deletion or reclamation.
    if (existing) return existing;
    throw error;
  }
  const verified = parseRecord(target);
  if (!verified || canonicalize(verified) !== bytes) throw new Error('owner_epoch_publication_verification_failed');
  // Verification precedes unlinking only the successful temporary alias.
  unlinkSync(temp);
  return verified;
}

export function acquireSuccessorOwnerEpoch(cwd: string, teamName: string, input: OwnerEpochInput = {}): OwnerEpochRecord {
  const latest = readLatestOwnerEpoch(cwd, teamName);
  if (latest && !isProcessIdentityDead(latest)) throw new Error('runtime_owner_not_confirmed_dead');
  return publishOwnerEpoch(cwd, teamName, (latest?.epoch ?? 0) + 1, input);
}

export function checkOwnerFence(cwd: string, teamName: string, fence: OwnerFence): OwnerFenceCheck {
  const latest = readLatestOwnerEpoch(cwd, teamName);
  if (!latest) return { ok: false, reason: 'missing' };
  if (latest.epoch !== fence.epoch) return { ok: false, reason: 'superseded' };
  if (latest.nonce !== fence.nonce) return { ok: false, reason: 'mismatch' };
  return { ok: true, record: latest };
}

export function requireOwnerFence(cwd: string, teamName: string, fence: OwnerFence): OwnerEpochRecord {
  const result = checkOwnerFence(cwd, teamName, fence);
  if (!result.ok) throw new Error('runtime_owner_fence_lost');
  return result.record;
}

export function isFreshRecoveryElection(config: TeamConfig, fence: OwnerFence, expectedRevision: number): boolean {
  return config.state_revision === expectedRevision
    && config.lifecycle_state === 'active'
    && config.runtime_owner_epoch?.epoch === fence.epoch
    && config.runtime_owner_epoch.nonce === fence.nonce
    && !config.active_recovery;
}

export function isSameAttemptSuccessorRebind(config: TeamConfig, prior: TeamRuntimeOwnerEpoch, successor: OwnerFence, requestId: string, recoveryId: string): boolean {
  const active = config.active_recovery;
  return successor.epoch === prior.epoch + 1
    && isProcessIdentityDead(prior)
    && !!active
    && active.request_id === requestId
    && active.recovery_id === recoveryId
    && active.owner_epoch === prior.epoch
    && active.owner_nonce === prior.nonce;
}

export function isActiveRecoveryEffect(config: TeamConfig, fence: OwnerFence, requestId: string, recoveryId: string): boolean {
  const active: TeamRecoveryAttempt | undefined = config.active_recovery;
  return config.runtime_owner_epoch?.epoch === fence.epoch
    && config.runtime_owner_epoch.nonce === fence.nonce
    && active?.request_id === requestId
    && active.recovery_id === recoveryId
    && active.owner_epoch === fence.epoch
    && active.owner_nonce === fence.nonce;
}

export function isFencedServiceMaintenance(config: TeamConfig, fence: OwnerFence): boolean {
  const marker = (config as TeamConfig & { service_recovery?: OwnerFence }).service_recovery;
  return !config.active_recovery
    && config.runtime_owner_epoch?.epoch === fence.epoch
    && config.runtime_owner_epoch.nonce === fence.nonce
    && marker?.epoch === fence.epoch
    && marker.nonce === fence.nonce;
}
