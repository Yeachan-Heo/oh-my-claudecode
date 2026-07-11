import { createHash, randomUUID } from 'crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import type { RecoverDeadWorkerV2Error, RecoverDeadWorkerV2Failure, RecoverDeadWorkerV2Result, RecoverDeadWorkerV2Success } from './types.js';
import { absPath, TeamPaths } from './state-paths.js';
import { withProcessIdentityFileLockSync } from './process-identity-lock.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function isSafeRecoveryRequestId(requestId: string): boolean {
  return requestId.length > 0 && requestId.length <= 128 && requestId !== '.' && requestId !== '..'
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requestId);
}

function assertSafeRecoveryRequestId(requestId: string): void {
  if (!isSafeRecoveryRequestId(requestId)) throw new Error('invalid_recovery_request_id');
}

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
  operation: 'recover-worker';
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
  assertSafeRecoveryRequestId(requestId);
  return absPath(cwd, TeamPaths.recoveryRequestPending(requestId));
}

function finalPath(cwd: string, requestId: string): string {
  assertSafeRecoveryRequestId(requestId);
  return absPath(cwd, TeamPaths.recoveryRequestResult(requestId));
}

function phaseDirectory(cwd: string, requestId: string): string {
  assertSafeRecoveryRequestId(requestId);
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

function replaceDerivedIndex<T>(target: string, value: T): T {
  const bytes = canonicalize(value);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = join(dirname(target), `.${randomUUID()}.repair.tmp`);
  writeFileSync(temp, bytes, { encoding: 'utf8', mode: 0o600, flush: true });
  try { renameSync(temp, target); } finally { if (existsSync(temp)) unlinkSync(temp); }
  const repaired = parseCanonical<T>(target);
  if (!repaired || canonicalize(repaired) !== bytes) throw new Error('immutable_recovery_record_verification_failed');
  return repaired;
}

export function canonicalRecoveryPayloadHash(payload: RecoveryRequestPayload): string {
  return sha256({ operation: payload.operation, workspace_hash: payload.workspaceHash, team_name: payload.teamName, worker_name: payload.workerName });
}

export function reserveRecoveryRequest(cwd: string, requestId: string, payload: RecoveryRequestPayload, recoveryId: string = randomUUID()): RequestReservationResult {
  assertSafeRecoveryRequestId(requestId);
  assertSafeRecoveryRequestId(recoveryId);
  const payloadHash = canonicalRecoveryPayloadHash(payload);
  const now = new Date();
  const reservation: RecoveryRequestReservation = {
    schema_version: 1,
    kind: 'reservation',
    request_id: requestId,
    payload_hash: payloadHash,
    operation: payload.operation,
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
    return existing.operation === payload.operation && existing.payload_hash === payloadHash
      && existing.workspace_hash === payload.workspaceHash && existing.team_name === payload.teamName
      && existing.worker_name === payload.workerName
      ? { kind: 'joined', reservation: existing } : { kind: 'conflict', reservation: existing };
  }
}

/** Publish a new immutable request ID that points at an existing recovery. */
export function aliasActiveRecoveryRequest(cwd: string, requestId: string, payload: RecoveryRequestPayload, active: RecoveryRequestReservation): RequestReservationResult {
  assertSafeRecoveryRequestId(requestId);
  assertSafeRecoveryRequestId(active.request_id);
  assertSafeRecoveryRequestId(active.recovery_id);
  const payloadHash = canonicalRecoveryPayloadHash(payload);
  if (active.operation !== payload.operation || active.payload_hash !== payloadHash || active.team_name !== payload.teamName
    || active.worker_name !== payload.workerName || active.workspace_hash !== payload.workspaceHash) return { kind: 'conflict', reservation: active };
  const now = new Date();
  const alias: RecoveryRequestReservation = {
    schema_version: 1,
    kind: 'alias',
    request_id: requestId,
    payload_hash: payloadHash,
    operation: payload.operation,
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
    return existing.operation === payload.operation && existing.payload_hash === payloadHash
      && existing.workspace_hash === payload.workspaceHash && existing.team_name === payload.teamName
      && existing.worker_name === payload.workerName && existing.recovery_id === active.recovery_id
      ? { kind: 'joined', reservation: existing } : { kind: 'conflict', reservation: existing };
  }
}

export function readRecoveryRequestReservation(cwd: string, requestId: string): RecoveryRequestReservation | null {
  const reservation = parseCanonical<RecoveryRequestReservation>(reservationPath(cwd, requestId));
  if (!reservation || reservation.schema_version !== 1 || (reservation.kind !== 'reservation' && reservation.kind !== 'alias')
    || reservation.request_id !== requestId || reservation.operation !== 'recover-worker'
    || typeof reservation.payload_hash !== 'string' || !/^[a-f0-9]{64}$/.test(reservation.payload_hash)
    || typeof reservation.workspace_hash !== 'string' || !/^[a-f0-9]{64}$/.test(reservation.workspace_hash)
    || typeof reservation.team_name !== 'string' || reservation.team_name.length === 0
    || typeof reservation.worker_name !== 'string' || reservation.worker_name.length === 0
    || reservation.payload_hash !== canonicalRecoveryPayloadHash({ operation: reservation.operation,
      workspaceHash: reservation.workspace_hash, teamName: reservation.team_name, workerName: reservation.worker_name })
    || typeof reservation.recovery_id !== 'string' || !isSafeRecoveryRequestId(reservation.recovery_id)
    || typeof reservation.created_at !== 'string' || !Number.isFinite(Date.parse(reservation.created_at))
    || typeof reservation.expires_at !== 'string' || !Number.isFinite(Date.parse(reservation.expires_at))
    || (reservation.kind === 'alias' && (typeof reservation.alias_of_request_id !== 'string' || !isSafeRecoveryRequestId(reservation.alias_of_request_id)))
    || (reservation.kind === 'reservation' && reservation.alias_of_request_id !== undefined)) return null;
  return reservation;
}

const MAX_RECOVERY_ALIAS_DEPTH = 16;

function hasMatchingReservationTuple(left: RecoveryRequestReservation, right: RecoveryRequestReservation): boolean {
  return left.operation === right.operation
    && left.payload_hash === right.payload_hash
    && left.workspace_hash === right.workspace_hash
    && left.team_name === right.team_name
    && left.worker_name === right.worker_name
    && left.recovery_id === right.recovery_id;
}

/** Resolves aliases only through matching, path-bound immutable reservations. */
function resolveCanonicalRecoveryRequestId(cwd: string, requestId: string): string | null {
  assertSafeRecoveryRequestId(requestId);
  const visited = new Set<string>();
  let currentRequestId = requestId;
  let alias: RecoveryRequestReservation | null = null;

  for (let depth = 0; depth < MAX_RECOVERY_ALIAS_DEPTH; depth += 1) {
    if (visited.has(currentRequestId)) return null;
    visited.add(currentRequestId);
    const reservation = readRecoveryRequestReservation(cwd, currentRequestId);
    if (!reservation) {
      if (alias || existsSync(reservationPath(cwd, currentRequestId))) return null;
      return currentRequestId;
    }
    if (alias && !hasMatchingReservationTuple(alias, reservation)) return null;
    if (reservation.kind === 'reservation') return currentRequestId;
    alias = reservation;
    currentRequestId = reservation.alias_of_request_id!;
  }
  return null;
}


function hasMatchingRecoveryPhaseTuple(phase: RecoveryOutcomePending, reservation: RecoveryRequestReservation): boolean {
  return phase.request_id === reservation.request_id
    && phase.recovery_id === reservation.recovery_id
    && phase.team_name === reservation.team_name
    && phase.worker_name === reservation.worker_name;
}

function isValidRecoveryPhase(phase: RecoveryOutcomePending | null, reservation: RecoveryRequestReservation): phase is RecoveryOutcomePending {
  return phase?.schema_version === 1 && phase.kind === 'phase'
    && hasMatchingRecoveryPhaseTuple(phase, reservation)
    && ['reserved', 'elected', 'requeued', 'ready', 'active', 'services_pending', 'adopted'].includes(phase.phase)
    && ['none', 'selected', 'reserved', 'adopted'].includes(phase.continuation)
    && ['not_started', 'pending', 'adopted'].includes(phase.adoption)
    && ['not_started', 'pending', 'synced', 'repair_required'].includes(phase.services)
    && ['not_started', 'synced', 'repair_required'].includes(phase.manifest)
    && typeof phase.updated_at === 'string' && Number.isFinite(Date.parse(phase.updated_at))
    && (phase.state_revision === undefined || (Number.isSafeInteger(phase.state_revision) && phase.state_revision >= 0));
}

export function writeRecoveryPhase(cwd: string, phase: RecoveryOutcomePending): RecoveryOutcomePending {
  const reservation = readRecoveryRequestReservation(cwd, phase.request_id);
  if (!reservation || reservation.kind !== 'reservation' || !hasMatchingRecoveryPhaseTuple(phase, reservation)) {
    throw new Error('invalid_persisted_state');
  }
  const sequence = `${Date.now().toString().padStart(16, '0')}-${process.hrtime.bigint().toString().padStart(20, '0')}-${randomUUID()}.json`;
  return publishImmutable(join(phaseDirectory(cwd, phase.request_id), sequence), { ...phase, schema_version: 1, kind: 'phase' as const, updated_at: phase.updated_at || new Date().toISOString() });
}

export function writeRecoveryFinal(cwd: string, outcome: RecoveryOutcomeFinal): RecoveryOutcomeFinal {
  const reservation = readRecoveryRequestReservation(cwd, outcome.request_id);
  if (!reservation || reservation.kind !== 'reservation' || reservation.recovery_id !== outcome.recovery_id
    || reservation.team_name !== outcome.team_name || reservation.worker_name !== outcome.worker_name) {
    throw new Error('invalid_persisted_state');
  }
  const final = { ...outcome, schema_version: 1 as const, kind: 'final' as const };
  if (!isMatchingRecoveryFinal(final, { requestId: outcome.request_id, recoveryId: outcome.recovery_id,
    teamName: outcome.team_name, workerName: outcome.worker_name })) throw new Error('invalid_persisted_state');
  const published = publishImmutable(finalPath(cwd, outcome.request_id), final);
  const byTeam = absPath(cwd, TeamPaths.recoveryResultByTeam(reservation.workspace_hash, outcome.team_name, outcome.recovery_id));
  const indexed = publishImmutable(byTeam, published);
  if (canonicalize(indexed) !== canonicalize(published)) throw new Error('immutable_recovery_record_verification_failed');
  return published;
}

function latestPhase(cwd: string, requestId: string): RecoveryOutcomePending | null {
  const reservation = readRecoveryRequestReservation(cwd, requestId);
  if (!reservation || reservation.kind !== 'reservation') return null;
  const directory = phaseDirectory(cwd, requestId);
  try {
    const candidates = readdirSync(directory).filter(file => file.endsWith('.json')).sort().reverse() as string[];
    if (candidates.length === 0) return null;
    const phase = parseCanonical<RecoveryOutcomePending>(join(directory, candidates[0]!));
    return isValidRecoveryPhase(phase, reservation) ? phase : null;
  } catch { /* no phases */ }
  return null;
}



function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactUniqueKeys(values: string[], record: Record<string, unknown>): boolean {
  if (new Set(values).size !== values.length) return false;
  const expected = [...values].sort();
  const actual = Object.keys(record).sort();
  return expected.length === actual.length && expected.every((value, index) => value === actual[index]);
}

const RECOVERY_ERRORS = new Set<RecoverDeadWorkerV2Error>([
  'invalid_input', 'team_not_found', 'worker_not_found', 'runtime_v2_required', 'invalid_persisted_state',
  'runtime_owner_unavailable', 'runtime_owner_fence_lost', 'recovery_request_timeout', 'recovery_attempt_conflict',
  'team_mutation_busy', 'team_mutation_resume_required', 'team_shutting_down', 'team_session_dead',
  'worker_liveness_unknown', 'recovery_checkpoint_missing', 'recovery_checkpoint_malformed',
  'recovery_checkpoint_ambiguous', 'recovery_checkpoint_stale', 'task_requeue_failed', 'launch_metadata_incomplete',
  'launch_descriptor_unresolvable', 'spawn_failed', 'startup_ack_timeout', 'worker_activation_failed',
  'auto_merge_unavailable', 'stale_state_revision', 'config_commit_failed',
]);
const RECOVERY_WARNINGS = new Set(['projection_repair_required', 'identity_repair_required', 'services_pending',
  'event_repair_required', 'result_repair_required']);

function isValidRecoveryResult(value: unknown): value is RecoverDeadWorkerV2Result {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (typeof result.requestId !== 'string' || typeof result.recoveryId !== 'string'
    || typeof result.teamName !== 'string' || typeof result.workerName !== 'string'
    || typeof result.updatedAt !== 'string' || !Number.isFinite(Date.parse(result.updatedAt as string))
    || typeof result.committed !== 'boolean') return false;
  if (result.outcome === 'recovered' || result.outcome === 'already_running') {
    if (result.committed !== true || (typeof result.oldPaneId !== 'string' && result.oldPaneId !== null)
      || typeof result.newPaneId !== 'string' || !result.newPaneId.trim()
      || (result.outcome === 'recovered' && (typeof result.oldPaneId !== 'string' || !result.oldPaneId.trim()))
      || !isStringArray(result.requeuedTaskIds)
      || !isPlainRecord(result.continuationSequenceByTask)
      || !hasExactUniqueKeys(result.requeuedTaskIds, result.continuationSequenceByTask)
      || !Object.values(result.continuationSequenceByTask)
        .every(sequence => typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0)
      || typeof result.stateRevision !== 'number' || !Number.isSafeInteger(result.stateRevision)
      || (result.activation !== 'active' && result.activation !== 'services_pending')
      || (result.manifestSync !== 'synced' && result.manifestSync !== 'repair_required')
      || (result.servicesSync !== 'synced' && result.servicesSync !== 'repair_required')
      || !isStringArray(result.warnings) || !result.warnings.every(warning => RECOVERY_WARNINGS.has(warning))) return false;
    return result.outcome !== 'already_running' || result.requeuedTaskIds.length === 0;
  }
  return (result.outcome === 'failed' || result.outcome === 'commit_unknown') && result.committed === false
    && typeof result.error === 'string' && RECOVERY_ERRORS.has(result.error as RecoverDeadWorkerV2Error)
    && (result.message === undefined || typeof result.message === 'string');
}

export type RecoveryFinalState = { kind: 'missing' } | { kind: 'invalid' }
  | { kind: 'valid'; final: RecoveryOutcomeFinal & { result: RecoverDeadWorkerV2Result } };

export function readRecoveryFinalState(cwd: string, requestId: string): RecoveryFinalState {
  const path = finalPath(cwd, requestId);
  if (!existsSync(path)) return { kind: 'missing' };
  const final = parseCanonical<RecoveryOutcomeFinal>(path);
  if (!final || final.schema_version !== 1 || final.kind !== 'final' || !isMatchingRecoveryFinal(final, { requestId })) {
    return { kind: 'invalid' };
  }
  const reservation = readRecoveryRequestReservation(cwd, requestId);
  if (!reservation || reservation.kind !== 'reservation' || reservation.recovery_id !== final.recovery_id
    || reservation.team_name !== final.team_name || reservation.worker_name !== final.worker_name) return { kind: 'invalid' };
  const byTeam = absPath(cwd, TeamPaths.recoveryResultByTeam(reservation.workspace_hash, final.team_name, final.recovery_id));
  try {
    const expectedBytes = canonicalize(final);
    const indexed = existsSync(byTeam) ? parseCanonical<RecoveryOutcomeFinal>(byTeam) : null;
    if (!indexed || canonicalize(indexed) !== expectedBytes) {
      const lockPath = absPath(cwd, TeamPaths.recoveryFinalIndexLock(reservation.workspace_hash, final.team_name, final.recovery_id));
      withProcessIdentityFileLockSync(lockPath, () => {
        const current = existsSync(byTeam) ? parseCanonical<RecoveryOutcomeFinal>(byTeam) : null;
        if (!current || canonicalize(current) !== expectedBytes) replaceDerivedIndex(byTeam, final);
      });
    }
    const verified = parseCanonical<RecoveryOutcomeFinal>(byTeam);
    if (!verified || canonicalize(verified) !== expectedBytes) return { kind: 'invalid' };
  } catch { return { kind: 'invalid' }; }
  return { kind: 'valid', final };
}
export function isMatchingRecoveryFinal(
  outcome: RecoveryDurableOutcome | null | undefined,
  expected: Partial<{ requestId: string; recoveryId: string; teamName: string; workerName: string }> = {},
): outcome is RecoveryOutcomeFinal & { result: RecoverDeadWorkerV2Result } {
  if (!outcome || outcome.kind !== 'final' || !isValidRecoveryResult(outcome.result)
    || outcome.request_id !== outcome.result.requestId || outcome.recovery_id !== outcome.result.recoveryId
    || outcome.team_name !== outcome.result.teamName || outcome.worker_name !== outcome.result.workerName
    || (expected.requestId !== undefined && outcome.request_id !== expected.requestId)
    || (expected.recoveryId !== undefined && outcome.recovery_id !== expected.recoveryId)
    || (expected.teamName !== undefined && outcome.team_name !== expected.teamName)
    || (expected.workerName !== undefined && outcome.worker_name !== expected.workerName)
    || typeof outcome.completed_at !== 'string' || !Number.isFinite(Date.parse(outcome.completed_at))
    || typeof outcome.expires_at !== 'string' || !Number.isFinite(Date.parse(outcome.expires_at))
    || !['none', 'selected', 'reserved', 'adopted'].includes(outcome.continuation)
    || !['not_started', 'pending', 'adopted'].includes(outcome.adoption)
    || !['synced', 'repair_required', 'terminal_degraded'].includes(outcome.services)
    || !['synced', 'repair_required'].includes(outcome.manifest)) return false;
  const succeeded = outcome.result.outcome === 'recovered' || outcome.result.outcome === 'already_running';
  if (outcome.outcome !== (succeeded ? 'succeeded' : outcome.result.outcome === 'commit_unknown' ? 'commit_unknown' : 'failed')) return false;
  if (succeeded) {
    const success = outcome.result as RecoverDeadWorkerV2Success;
    const hasContinuations = success.requeuedTaskIds.length > 0;
    const servicesPending = success.servicesSync === 'repair_required';
    return outcome.error === undefined
      && outcome.continuation === (hasContinuations ? 'adopted' : 'none')
      && outcome.adoption === (hasContinuations ? 'adopted' : 'not_started')
      && outcome.services === success.servicesSync && outcome.manifest === success.manifestSync
      && success.manifestSync === 'synced'
      && success.activation === (servicesPending ? 'services_pending' : 'active')
      && (servicesPending
        ? success.warnings.length === 1 && success.warnings[0] === 'services_pending'
        : success.warnings.length === 0);
  }
  const failure = outcome.result as RecoverDeadWorkerV2Failure;
  return outcome.continuation === 'none' && outcome.adoption === 'not_started'
    && outcome.error?.code === failure.error
    && outcome.error?.message === failure.message
    && outcome.error?.commit_uncertain === (failure.outcome === 'commit_unknown')
    && outcome.services === 'terminal_degraded' && outcome.manifest === 'repair_required';
}

/** Final records take precedence, then the newest immutable phase. */
export function readRecoveryOutcome(cwd: string, requestId: string): RecoveryDurableOutcome | null {
  const canonicalRequestId = resolveCanonicalRecoveryRequestId(cwd, requestId);
  if (!canonicalRequestId) return null;
  const final = readRecoveryFinalState(cwd, canonicalRequestId);
  if (final.kind === 'valid') return final.final;
  if (final.kind === 'invalid') return null;
  return latestPhase(cwd, canonicalRequestId);
}

export function readRecoveryResult(cwd: string, requestId: string): RecoverDeadWorkerV2Result | null {
  const outcome = readRecoveryOutcome(cwd, requestId);
  return outcome?.kind === 'final' ? outcome.result ?? null : null;
}
