import { createHash, randomUUID } from 'crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import type { RecoverDeadWorkerV2Error, RecoverDeadWorkerV2Result } from './types.js';
import { absPath, TeamPaths } from './state-paths.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecoveryRequestPayload {
  operation: 'recover-worker';
  workspaceHash: string;
  teamName: string;
  workerName: string;
}

export interface RecoveryRequestReservation {
  schema_version: 1;
  kind: 'reservation' | 'alias';
  request_id: string;
  payload_hash: string;
  workspace_hash: string;
  team_name: string;
  worker_name: string;
  recovery_id: string;
  created_at: string;
  expires_at: string;
  alias_of_request_id?: string;
}

export interface RecoveryOutcomeError {
  code: RecoverDeadWorkerV2Error;
  message?: string;
  commit_uncertain?: boolean;
}

export interface RecoveryOutcomePending {
  schema_version: 1;
  kind: 'phase';
  request_id: string;
  recovery_id: string;
  team_name: string;
  worker_name: string;
  phase: 'reserved' | 'elected' | 'requeued' | 'ready' | 'active' | 'services_pending' | 'adopted';
  continuation: 'none' | 'selected' | 'reserved' | 'adopted';
  adoption: 'not_started' | 'pending' | 'adopted';
  services: 'not_started' | 'pending' | 'synced' | 'repair_required';
  manifest: 'not_started' | 'synced' | 'repair_required';
  state_revision?: number;
  updated_at: string;
}

export interface RecoveryOutcomeFinal {
  schema_version: 1;
  kind: 'final';
  request_id: string;
  recovery_id: string;
  team_name: string;
  worker_name: string;
  outcome: 'succeeded' | 'failed' | 'commit_unknown';
  result?: RecoverDeadWorkerV2Result;
  error?: RecoveryOutcomeError;
  continuation: 'none' | 'selected' | 'reserved' | 'adopted';
  adoption: 'not_started' | 'pending' | 'adopted';
  services: 'synced' | 'repair_required' | 'terminal_degraded';
  manifest: 'synced' | 'repair_required';
  completed_at: string;
  expires_at: string;
}

export type RecoveryDurableOutcome = RecoveryOutcomePending | RecoveryOutcomeFinal;
export type RequestReservationResult =
  | { kind: 'created' | 'joined' | 'aliased'; reservation: RecoveryRequestReservation }
  | { kind: 'conflict'; reservation: RecoveryRequestReservation };

function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function parseCanonical<T>(path: string): T | null {
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as T;
    return canonicalize(parsed) === text ? parsed : null;
  } catch {
    return null;
  }
}

function reservationPath(cwd: string, requestId: string): string {
  return absPath(cwd, TeamPaths.recoveryRequestPending(requestId));
}

function finalPath(cwd: string, requestId: string): string {
  return absPath(cwd, TeamPaths.recoveryRequestResult(requestId));
}

function phaseDirectory(cwd: string, requestId: string): string {
  return join(dirname(reservationPath(cwd, requestId)), 'phases', requestId);
}

function publishImmutable<T>(target: string, value: T): T {
  const bytes = canonicalize(value);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = join(dirname(target), `.${randomUUID()}.tmp`);
  writeFileSync(temp, bytes, { encoding: 'utf8', mode: 0o600, flush: true });
  try {
    linkSync(temp, target);
  } catch (error) {
    const existing = parseCanonical<T>(target);
    try { unlinkSync(temp); } catch { /* unique losing temp cleanup is best-effort */ }
    if (existing && canonicalize(existing) === bytes) return existing;
    throw error;
  }
  const published = parseCanonical<T>(target);
  if (!published || canonicalize(published) !== bytes) throw new Error('immutable_recovery_record_verification_failed');
  unlinkSync(temp);
  return published;
}

export function canonicalRecoveryPayloadHash(payload: RecoveryRequestPayload): string {
  return sha256({ operation: payload.operation, workspace_hash: payload.workspaceHash, team_name: payload.teamName, worker_name: payload.workerName });
}

export function reserveRecoveryRequest(cwd: string, requestId: string, payload: RecoveryRequestPayload, recoveryId: string = randomUUID()): RequestReservationResult {
  const payloadHash = canonicalRecoveryPayloadHash(payload);
  const now = new Date();
  const reservation: RecoveryRequestReservation = {
    schema_version: 1,
    kind: 'reservation',
    request_id: requestId,
    payload_hash: payloadHash,
    workspace_hash: payload.workspaceHash,
    team_name: payload.teamName,
    worker_name: payload.workerName,
    recovery_id: recoveryId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + RETENTION_MS).toISOString(),
  };
  try {
    return { kind: 'created', reservation: publishImmutable(reservationPath(cwd, requestId), reservation) };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readRecoveryRequestReservation(cwd, requestId);
    if (!existing) throw new Error('malformed_recovery_request_reservation');
    return existing.payload_hash === payloadHash ? { kind: 'joined', reservation: existing } : { kind: 'conflict', reservation: existing };
  }
}

/** Publish a new immutable request ID that points at an existing recovery. */
export function aliasActiveRecoveryRequest(cwd: string, requestId: string, payload: RecoveryRequestPayload, active: RecoveryRequestReservation): RequestReservationResult {
  const payloadHash = canonicalRecoveryPayloadHash(payload);
  if (active.payload_hash !== payloadHash || active.team_name !== payload.teamName || active.workspace_hash !== payload.workspaceHash) return { kind: 'conflict', reservation: active };
  const now = new Date();
  const alias: RecoveryRequestReservation = {
    schema_version: 1,
    kind: 'alias',
    request_id: requestId,
    payload_hash: payloadHash,
    workspace_hash: payload.workspaceHash,
    team_name: payload.teamName,
    worker_name: payload.workerName,
    recovery_id: active.recovery_id,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + RETENTION_MS).toISOString(),
    alias_of_request_id: active.request_id,
  };
  try {
    return { kind: 'aliased', reservation: publishImmutable(reservationPath(cwd, requestId), alias) };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readRecoveryRequestReservation(cwd, requestId);
    if (!existing) throw new Error('malformed_recovery_request_reservation');
    return existing.payload_hash === payloadHash && existing.recovery_id === active.recovery_id ? { kind: 'joined', reservation: existing } : { kind: 'conflict', reservation: existing };
  }
}

export function readRecoveryRequestReservation(cwd: string, requestId: string): RecoveryRequestReservation | null {
  const reservation = parseCanonical<RecoveryRequestReservation>(reservationPath(cwd, requestId));
  if (!reservation || reservation.schema_version !== 1 || (reservation.kind !== 'reservation' && reservation.kind !== 'alias')) return null;
  return reservation;
}

export function writeRecoveryPhase(cwd: string, phase: RecoveryOutcomePending): RecoveryOutcomePending {
  const sequence = `${Date.now().toString().padStart(16, '0')}-${randomUUID()}.json`;
  return publishImmutable(join(phaseDirectory(cwd, phase.request_id), sequence), { ...phase, schema_version: 1, kind: 'phase' as const, updated_at: phase.updated_at || new Date().toISOString() });
}

export function writeRecoveryFinal(cwd: string, outcome: RecoveryOutcomeFinal): RecoveryOutcomeFinal {
  const final = { ...outcome, schema_version: 1 as const, kind: 'final' as const };
  const published = publishImmutable(finalPath(cwd, outcome.request_id), final);
  const byTeam = absPath(cwd, TeamPaths.recoveryResultByTeam(sha256(outcome.team_name), outcome.team_name, outcome.recovery_id));
  publishImmutable(byTeam, published);
  return published;
}

function latestPhase(cwd: string, requestId: string): RecoveryOutcomePending | null {
  const directory = phaseDirectory(cwd, requestId);
  try {
    const candidates = readdirSync(directory).sort().reverse() as string[];
    for (const file of candidates) {
      const phase = parseCanonical<RecoveryOutcomePending>(join(directory, file));
      if (phase?.schema_version === 1 && phase.kind === 'phase') return phase;
    }
  } catch { /* no phases */ }
  return null;
}

/** Final records take precedence, then the newest immutable phase. */
export function readRecoveryOutcome(cwd: string, requestId: string): RecoveryDurableOutcome | null {
  const final = parseCanonical<RecoveryOutcomeFinal>(finalPath(cwd, requestId));
  if (final?.schema_version === 1 && final.kind === 'final') return final;
  return latestPhase(cwd, requestId);
}

export function readRecoveryResult(cwd: string, requestId: string): RecoverDeadWorkerV2Result | null {
  const outcome = readRecoveryOutcome(cwd, requestId);
  return outcome?.kind === 'final' ? outcome.result ?? null : null;
}
