import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  aliasActiveRecoveryRequest,
  canonicalRecoveryPayloadHash,
  readRecoveryOutcome,
  readRecoveryRequestReservation,
  reserveRecoveryRequest,
  writeRecoveryFinal,
  type RecoveryRequestPayload,
  type RecoveryRequestReservation,
} from './recovery-request-store.js';
import { absPath, TeamPaths } from './state-paths.js';
import type { RecoverDeadWorkerV2Result } from './types.js';

const MIN_RECOVERY_TIMEOUT_MS = 180_000;
const MAX_RECOVERY_TIMEOUT_MS = 300_000;

export interface RecoverDeadWorkerOwnerInput {
  teamName: string;
  cwd: string;
  workerName: string;
  requestId: string;
  timeoutMs?: number;
}

export interface RecoveryOwnerClient {
  recoverDeadWorker(input: RecoverDeadWorkerOwnerInput): Promise<RecoverDeadWorkerV2Result>;
}

export type RecoveryOwnerDispatch = (input: RecoverDeadWorkerOwnerInput) => Promise<RecoverDeadWorkerV2Result>;

function workspaceHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex');
}

function timeoutBudget(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) return MIN_RECOVERY_TIMEOUT_MS;
  return Math.max(MIN_RECOVERY_TIMEOUT_MS, Math.min(MAX_RECOVERY_TIMEOUT_MS, Math.floor(timeoutMs!)));
}

function findActiveIdenticalReservation(cwd: string, payload: RecoveryRequestPayload): RecoveryRequestReservation | null {
  const targetHash = canonicalRecoveryPayloadHash(payload);
  try {
    for (const name of readdirSync(absPath(cwd, TeamPaths.recoveryRequestsRoot()))) {
      const match = /^(.+)\.pending\.json$/.exec(name);
      if (!match) continue;
      const reservation = readRecoveryRequestReservation(cwd, match[1]);
      if (!reservation || reservation.payload_hash !== targetHash) continue;
      const outcome = readRecoveryOutcome(cwd, reservation.request_id);
      if (!outcome || outcome.kind === 'phase') return reservation;
    }
  } catch { /* request root has not been created */ }
  return null;
}

async function publishIntent(input: RecoverDeadWorkerOwnerInput, recoveryId: string): Promise<void> {
  const path = absPath(input.cwd, TeamPaths.recoveryIntent(input.teamName, recoveryId));
  const payload = JSON.stringify({ schema_version: 1, kind: 'recover-worker', request_id: input.requestId,
    recovery_id: recoveryId, team_name: input.teamName, worker_name: input.workerName, created_at: new Date().toISOString() });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function timeoutResult(input: RecoverDeadWorkerOwnerInput, recoveryId: string): RecoverDeadWorkerV2Result {
  return { outcome: 'failed', committed: false, error: 'recovery_request_timeout', requestId: input.requestId,
    recoveryId, teamName: input.teamName, workerName: input.workerName, updatedAt: new Date().toISOString(),
    message: 'Timed out waiting for the persistent recovery owner.' };
}

/** Durable admission/replay client. The injected owner alone performs recovery effects. */
export function createRecoveryOwnerClient(dispatch: RecoveryOwnerDispatch): RecoveryOwnerClient {
  return {
    async recoverDeadWorker(input: RecoverDeadWorkerOwnerInput): Promise<RecoverDeadWorkerV2Result> {
      const requestId = input.requestId || randomUUID();
      const normalized = { ...input, requestId, timeoutMs: timeoutBudget(input.timeoutMs) };
      const payload: RecoveryRequestPayload = { operation: 'recover-worker', workspaceHash: workspaceHash(normalized.cwd), teamName: normalized.teamName, workerName: normalized.workerName };
      const active = findActiveIdenticalReservation(normalized.cwd, payload);
      const admission = active
        ? aliasActiveRecoveryRequest(normalized.cwd, requestId, payload, active)
        : reserveRecoveryRequest(normalized.cwd, requestId, payload);
      if (admission.kind === 'conflict') {
        return { outcome: 'failed', committed: false, error: 'recovery_attempt_conflict', requestId,
          recoveryId: admission.reservation.recovery_id, teamName: normalized.teamName, workerName: normalized.workerName,
          updatedAt: new Date().toISOString(), message: 'Request ID is already reserved for a different recovery payload.' };
      }
      const outcomeRequestId = admission.reservation.alias_of_request_id ?? requestId;
      await publishIntent(normalized, admission.reservation.recovery_id);
      const prior = readRecoveryOutcome(normalized.cwd, outcomeRequestId);
      if (prior?.kind === 'final' && prior.result) return prior.result;
      if (!admission.reservation.alias_of_request_id) {
        void dispatch(normalized).catch((error: unknown) => {
          const result: RecoverDeadWorkerV2Result = { outcome: 'failed', committed: false, error: 'runtime_owner_unavailable', requestId,
            recoveryId: admission.reservation.recovery_id, teamName: normalized.teamName, workerName: normalized.workerName,
            updatedAt: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) };
          writeRecoveryFinal(normalized.cwd, { schema_version: 1, kind: 'final', request_id: requestId, recovery_id: result.recoveryId,
            team_name: result.teamName, worker_name: result.workerName, outcome: 'failed', result,
            error: { code: result.error, message: result.message }, continuation: 'none', adoption: 'not_started', services: 'terminal_degraded',
            manifest: 'repair_required', completed_at: result.updatedAt, expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() });
        });
      }
      const deadline = Date.now() + normalized.timeoutMs;
      while (Date.now() < deadline) {
        const outcome = readRecoveryOutcome(normalized.cwd, outcomeRequestId);
        if (outcome?.kind === 'final' && outcome.result) return outcome.result;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return timeoutResult(normalized, admission.reservation.recovery_id);
    },
  };
}

let installedRecoveryOwnerDispatch: RecoveryOwnerDispatch | undefined;

/** Install the long-lived owner dispatcher without coupling the public client to runtime-cli startup. */
export function setRuntimeOwnerDispatch(dispatch: RecoveryOwnerDispatch | undefined): void {
  installedRecoveryOwnerDispatch = dispatch;
}

/**
 * Stable named client used by runtime-v2. Admission is durable and dispatch is
 * non-recursive: the runtime owner invokes the private executor, never the
 * public recoverDeadWorkerV2 facade.
 */
export async function requestRuntimeOwnerRecovery(input: RecoverDeadWorkerOwnerInput): Promise<RecoverDeadWorkerV2Result> {
  const dispatch = installedRecoveryOwnerDispatch ?? (async (ownerInput: RecoverDeadWorkerOwnerInput) => {
    const runtime = await import('./runtime-cli.js');
    return runtime.handleRecoverDeadWorkerV2Owner(ownerInput);
  });
  return createRecoveryOwnerClient(dispatch).recoverDeadWorker(input);
}
