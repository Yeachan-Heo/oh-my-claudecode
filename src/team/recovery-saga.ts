import { createHash } from 'node:crypto';

import type { RecoverDeadWorkerV2Error, RecoverDeadWorkerV2Failure, RecoverDeadWorkerV2Result, TaskRecoveryAdoptionProof, TeamTask } from './types.js';
import { writeRecoveryPhase } from './recovery-request-store.js';

export interface RecoverySagaInput {
  requestId: string;
  recoveryId: string;
  teamName: string;
  workerName: string;
  replacementGeneration: number;
  /** Owner-only secret. Never place this value in a task reservation. */
  adoptionToken: string;
  /** Persisted original pane identity; confirmed live/dead before a success is returned. */
  originalPaneId?: string;

}

export interface RecoverySagaDependencies {
  cwd: string;
  getLiveness: (teamName: string, workerName: string) => Promise<'dead' | 'alive' | 'unknown'>;
  listOwnedInProgressTasks: (teamName: string, workerName: string) => Promise<TeamTask[]>;
  /** Must validate every checkpoint before any transition is made. */
  validateCheckpoint: (teamName: string, task: TeamTask) => Promise<{ ok: true; sequence: number } | { ok: false; error: RecoverDeadWorkerV2Error }>;
  requeue: (input: RecoverySagaInput, taskId: string, adoptionTokenHash: string) => Promise<{ ok: true; sequence: number } | { ok: false; error: RecoverDeadWorkerV2Error }>;
  spawnGatedPane: (input: RecoverySagaInput) => Promise<{ ok: true; paneId: string; paneAttemptId: string; committed: boolean; stateRevision?: number; manifestSync?: 'synced' | 'repair_required' } | { ok: false; error: RecoverDeadWorkerV2Error }>;
  /** Writes activate only after the attempt-specific ready marker is observed. */
  activatePane: (input: RecoverySagaInput, paneAttemptId: string) => Promise<{ ok: true } | { ok: false; error: RecoverDeadWorkerV2Error }>;
  /** Runtime-owner operation: adopts all reservations in order, before run. */
  adoptAll: (input: RecoverySagaInput, proof: TaskRecoveryAdoptionProof, taskIds: string[]) => Promise<{ ok: true; continuations: Array<{ taskId: string; taskVersion: number; sequence: number; payload: unknown; claimToken: string }> } | { ok: false; error: RecoverDeadWorkerV2Error }>;
  writeRun: (input: RecoverySagaInput, paneAttemptId: string, continuations: Array<{ taskId: string; taskVersion: number; sequence: number; payload: unknown; claimToken: string }>) => Promise<void>;
  persistActive: (input: RecoverySagaInput, paneId: string) => Promise<{ stateRevision: number; manifestSync: 'synced' | 'repair_required' }>;
  repairServices: (input: RecoverySagaInput) => Promise<'synced' | 'repair_required'>;
  killAttemptPane: (paneAttemptId: string) => Promise<void>;
}

function failure(input: RecoverySagaInput, error: RecoverDeadWorkerV2Error, message?: string, reservationsWritten = false): RecoverDeadWorkerV2Failure {
  return { outcome: 'failed', committed: false, error, message,
    ...(reservationsWritten ? { reservationsWritten: true } : {}),
    requestId: input.requestId, recoveryId: input.recoveryId, teamName: input.teamName, workerName: input.workerName,
    updatedAt: new Date().toISOString() };
}


/** Recovery-only transaction. It intentionally has no general worker scaling behavior. */
export async function runRecoverySaga(input: RecoverySagaInput, deps: RecoverySagaDependencies): Promise<RecoverDeadWorkerV2Result> {
  const persistPhase = (value: 'reserved' | 'requeued' | 'ready' | 'active' | 'services_pending' | 'adopted', continuation: 'none' | 'selected' | 'reserved' | 'adopted', adoption: 'not_started' | 'pending' | 'adopted', services: 'not_started' | 'pending' | 'synced' | 'repair_required' = 'not_started') => {
    writeRecoveryPhase(deps.cwd, { schema_version: 1, kind: 'phase', request_id: input.requestId, recovery_id: input.recoveryId, team_name: input.teamName, worker_name: input.workerName, phase: value, continuation, adoption, services, manifest: 'not_started', updated_at: new Date().toISOString() });
  };
  const finalize = (result: RecoverDeadWorkerV2Result, _continuation: 'none' | 'selected' | 'reserved' | 'adopted', _adoption: 'not_started' | 'pending' | 'adopted', _services: 'synced' | 'repair_required' | 'terminal_degraded' = 'terminal_degraded'): RecoverDeadWorkerV2Result => result;

  const liveness = await deps.getLiveness(input.teamName, input.workerName);
  if (liveness === 'unknown') return finalize(failure(input, 'worker_liveness_unknown'), 'none', 'not_started');
  if (liveness === 'alive') {
    if (!input.originalPaneId?.trim()) return finalize(failure(input, 'worker_liveness_unknown'), 'none', 'not_started');
    return finalize({ outcome: 'already_running', committed: true, oldPaneId: null, newPaneId: input.originalPaneId, requeuedTaskIds: [], continuationSequenceByTask: {}, stateRevision: 0, activation: 'active', manifestSync: 'synced', servicesSync: 'synced', warnings: [], requestId: input.requestId, recoveryId: input.recoveryId, teamName: input.teamName, workerName: input.workerName, updatedAt: new Date().toISOString() }, 'none', 'not_started', 'synced');
  }
  if (!input.originalPaneId?.trim()) return finalize(failure(input, 'worker_liveness_unknown'), 'none', 'not_started');

  const tasks = await deps.listOwnedInProgressTasks(input.teamName, input.workerName);
  // The idle branch is deliberately neutral: no checkpoint, reservation, or adoption.
  if (tasks.length === 0) persistPhase('reserved', 'none', 'not_started');
  const checks = await Promise.all(tasks.map(task => deps.validateCheckpoint(input.teamName, task)));
  const rejected = checks.find((check): check is { ok: false; error: RecoverDeadWorkerV2Error } => !check.ok);
  if (rejected) return finalize(failure(input, rejected.error), 'selected', 'not_started');
  persistPhase('reserved', tasks.length ? 'selected' : 'none', 'not_started');
  const adoptionTokenHash = createHash('sha256').update(input.adoptionToken).digest('hex');
  const sequences: Record<string, number> = {};
  for (const task of tasks) {
    const result = await deps.requeue(input, task.id, adoptionTokenHash);
    if (!result.ok) return finalize(failure(input, result.error, undefined, Object.keys(sequences).length > 0), 'reserved', 'not_started');
    sequences[task.id] = result.sequence;
    try {
      persistPhase('requeued', 'reserved', 'not_started');
    } catch (error) {
      return finalize(failure(input, 'invalid_persisted_state', error instanceof Error ? error.message : String(error), true), 'reserved', 'not_started');
    }
  }
  const pane = await deps.spawnGatedPane(input);
  if (!pane.ok) return finalize(failure(input, pane.error), tasks.length ? 'reserved' : 'none', 'not_started');
  if (!pane.paneId.trim()) return finalize(failure(input, 'spawn_failed'), tasks.length ? 'reserved' : 'none', 'not_started');


  let persisted: { stateRevision: number; manifestSync: 'synced' | 'repair_required' };
  if (pane.committed) {
    persisted = { stateRevision: pane.stateRevision ?? 0, manifestSync: pane.manifestSync ?? 'repair_required' };
  } else {
    try {
      persisted = await deps.persistActive(input, pane.paneId);
    } catch (error) {
      await deps.killAttemptPane(pane.paneAttemptId);
      return finalize(failure(input, 'config_commit_failed', error instanceof Error ? error.message : String(error)), tasks.length ? 'reserved' : 'none', 'not_started');
    }
  }
  if (persisted.manifestSync !== 'synced') {
    return finalize({ ...failure(input, 'config_commit_failed', 'Replacement config committed but manifest projection requires repair.'), outcome: 'commit_unknown' }, tasks.length ? 'reserved' : 'none', tasks.length ? 'pending' : 'not_started');
  }

  const activated = await deps.activatePane(input, pane.paneAttemptId);
  if (!activated.ok) {
    return finalize({ ...failure(input, activated.error), outcome: 'commit_unknown', message: 'Replacement was committed but activation remains pending.' }, tasks.length ? 'reserved' : 'none', tasks.length ? 'pending' : 'not_started');
  }
  persistPhase('ready', tasks.length ? 'reserved' : 'none', tasks.length ? 'pending' : 'not_started');

  let continuations: Array<{ taskId: string; taskVersion: number; sequence: number; payload: unknown; claimToken: string }> = [];
  if (tasks.length) {
    const adopted = await deps.adoptAll(input, { recoveryId: input.recoveryId, requestId: input.requestId, replacementGeneration: input.replacementGeneration, adoptionToken: input.adoptionToken }, tasks.map(task => task.id));
    if (!adopted.ok) {
      return finalize({ ...failure(input, adopted.error), outcome: 'commit_unknown', message: 'Replacement was committed but continuation adoption remains pending.' }, 'reserved', 'pending');
    }
    continuations = adopted.continuations;
    persistPhase('adopted', 'adopted', 'adopted');
  }

  const services = await deps.repairServices(input);
  if (services === 'synced') {
    await deps.writeRun(input, pane.paneAttemptId, continuations);
  } else {
    persistPhase('services_pending', tasks.length ? 'adopted' : 'none', tasks.length ? 'adopted' : 'not_started', 'repair_required');
  }
  const result: RecoverDeadWorkerV2Result = { outcome: 'recovered', committed: true, oldPaneId: input.originalPaneId, newPaneId: pane.paneId, requeuedTaskIds: tasks.map(task => task.id), continuationSequenceByTask: sequences, stateRevision: persisted.stateRevision, activation: services === 'synced' ? 'active' : 'services_pending', manifestSync: persisted.manifestSync, servicesSync: services, warnings: services === 'synced' ? [] : ['services_pending'], requestId: input.requestId, recoveryId: input.recoveryId, teamName: input.teamName, workerName: input.workerName, updatedAt: new Date().toISOString() };
  return finalize(result, tasks.length ? 'adopted' : 'none', tasks.length ? 'adopted' : 'not_started', services);
}
