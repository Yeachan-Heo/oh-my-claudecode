/**
 * MCP-aligned gateway for all team operations.
 *
 * Both the MCP server and the runtime import from this module instead of
 * the lower-level persistence layers directly. Every exported function
 * corresponds to (or backs) an MCP tool with the same semantic name,
 * ensuring the runtime contract matches the external MCP surface.
 *
 * Modeled after oh-my-codex/src/team/team-ops.ts.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { TeamPaths, absPath } from './state-paths.js';
import { normalizeTeamManifest, resolveMaxWorkers } from './governance.js';
import { normalizeTeamGovernance } from './governance.js';
import { isValidPersistedMaxWorkers, migrateTeamConfigRevision, readRevisionedTeamConfig, saveTeamConfigAtRevision } from './monitor.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import {
  isTerminalTeamTaskStatus,
  canTransitionTeamTaskStatus,
  TASK_ID_SAFE_PATTERN,
  TEAM_TASK_STATUSES,
} from './contracts.js';
import type { TeamTaskStatus } from './contracts.js';
import type {
  TeamTask,
  TeamTaskV2,
  TeamTaskClaim,
  TeamConfig,
  TeamManifestV2,
  WorkerInfo,
  WorkerStatus,
  WorkerHeartbeat,
  TeamEvent,
  TeamMailboxMessage,
  TeamMailbox,
  TaskApprovalRecord,
  ClaimTaskResult,
  TransitionTaskResult,
  ReleaseTaskClaimResult,
  TaskReadiness,
  TeamSummary,
  TeamSummaryPerformance,
  ShutdownAck,
  TeamMonitorSnapshotState,
  TaskRecoveryAdoptionProof,
  TaskRecoveryAdoptionResult,
  TaskRecoveryCheckpoint,
  TaskRecoveryRequeueResult,
  TaskRecoveryRequeueSidecar,
  TaskRecoveryCheckpointValidation,
  TeamTaskRecoveryReservation,
  RecoverDeadWorkerV2Error,
  RecoverDeadWorkerV2Result,
  RecoverDeadWorkerV2Warning,
} from './types.js';

import {
  adoptRecoveryReservations as adoptRecoveryReservationsImpl,
  claimTask as claimTaskImpl,
  requeueRecoveredTask as requeueRecoveredTaskImpl,
  transitionTaskStatus as transitionTaskStatusImpl,
  releaseTaskClaim as releaseTaskClaimImpl,
  listTasks as listTasksImpl,
  createTaskRecord,
  validateTaskDependencies,
} from './state/tasks.js';
import {
  publishTaskRecoveryCheckpoint as publishTaskRecoveryCheckpointImpl,
  readTaskRecoveryCheckpoint,
  selectTaskRecoveryCheckpoint,
  type PublishTaskRecoveryCheckpointInput,
} from './task-recovery-checkpoint.js';
import { canonicalizeTeamConfigWorkers } from './worker-canonicalization.js';

// Re-export types for consumers
export type {
  TeamConfig,
  WorkerInfo,
  WorkerHeartbeat,
  WorkerStatus,
  TeamTask,
  TeamTaskV2,
  TeamTaskClaim,
  TeamManifestV2,
  TeamEvent,
  TeamMailboxMessage,
  TeamMailbox,
  TaskApprovalRecord,
  ClaimTaskResult,
  TransitionTaskResult,
  ReleaseTaskClaimResult,
  TaskReadiness,
  TeamSummary,
  ShutdownAck,
  TeamMonitorSnapshotState,
  TaskRecoveryAdoptionProof,
  TaskRecoveryAdoptionResult,
  TaskRecoveryCheckpoint,
  TaskRecoveryRequeueResult,
  TaskRecoveryRequeueSidecar,
  TaskRecoveryCheckpointValidation,
  TeamTaskRecoveryReservation,
  RecoverDeadWorkerV2Error,
  RecoverDeadWorkerV2Result,
  RecoverDeadWorkerV2Warning,
};
export type { PublishTaskRecoveryCheckpointInput } from './task-recovery-checkpoint.js';

/**
 * Result of an exact lookup in the canonical mailbox JSON file. This is a
 * guard-only reader and intentionally never falls back to legacy JSONL.
 */
export type StrictCanonicalMailboxMessageReadResult =
  | { kind: 'valid'; message: TeamMailboxMessage }
  | { kind: 'store_missing' }
  | { kind: 'malformed_store'; cause: 'json' | 'non_object' | 'messages_non_array' }
  | { kind: 'wrong_owner' }
  | { kind: 'malformed_message'; messageIndex: number; field: string }
  | { kind: 'message_missing' }
  | { kind: 'duplicate_message_id'; messageId: string; messageIndexes: number[] }
  | { kind: 'recipient_mismatch'; messageIndex: number }
  | { kind: 'replay_suppressed'; message: TeamMailboxMessage; marker: 'notified_at' | 'delivered_at' };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function teamDir(teamName: string, cwd: string): string {
  return absPath(cwd, TeamPaths.root(teamName));
}

function normalizeTaskId(taskId: string): string {
  const raw = String(taskId).trim();
  const normalized = raw.startsWith('task-') ? raw.slice('task-'.length) : raw;
  if (!TASK_ID_SAFE_PATTERN.test(normalized)) throw new Error(`invalid_task_id:${taskId}`);
  return normalized;
}

function canonicalTaskFilePath(teamName: string, taskId: string, cwd: string): string {
  const normalizedTaskId = normalizeTaskId(taskId);
  return join(absPath(cwd, TeamPaths.tasks(teamName)), `task-${normalizedTaskId}.json`);
}

function legacyTaskFilePath(teamName: string, taskId: string, cwd: string): string {
  const normalizedTaskId = normalizeTaskId(taskId);
  return join(absPath(cwd, TeamPaths.tasks(teamName)), `${normalizedTaskId}.json`);
}

function taskFileCandidates(teamName: string, taskId: string, cwd: string): string[] {
  const canonical = canonicalTaskFilePath(teamName, taskId, cwd);
  const legacy = legacyTaskFilePath(teamName, taskId, cwd);
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tmp, data, 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function readJsonSafe<T>(path: string): Promise<T | null> {
  try {
    if (!existsSync(path)) return null;
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

type PersistedJsonRead<T> =
  | { kind: 'missing' }
  | { kind: 'value'; value: T }
  | { kind: 'invalid'; cause: 'json' | 'unreadable'; error?: unknown };

async function readPersistedJson<T>(path: string): Promise<PersistedJsonRead<T>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'invalid', cause: 'unreadable', error };
  }
  try {
    return { kind: 'value', value: JSON.parse(raw) as T };
  } catch (error) {
    return { kind: 'invalid', cause: 'json', error };
  }
}

async function readTaskPersistedJson(path: string): Promise<PersistedJsonRead<unknown>> {
  let fileStat: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStat = await lstat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'invalid', cause: 'unreadable', error };
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    return { kind: 'invalid', cause: 'unreadable' };
  }
  return readPersistedJson<unknown>(path);
}

function persistedStateError(path: string, cause: 'json' | 'schema' | 'unreadable'): Error {
  return new Error(`invalid_persisted_state:${cause}:${path}`);
}

function normalizeTask(task: TeamTask): TeamTaskV2 {
  const normalized: TeamTaskV2 = { ...task, version: task.version ?? 1 };
  if (normalized.owner === null) delete normalized.owner;
  if (normalized.result === null) delete normalized.result;
  if (normalized.error === null) delete normalized.error;
  return normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTaskRecoveryReservation(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return isNonEmptyText(value.recovery_id)
    && isNonEmptyText(value.request_id)
    && isPositiveSafeInteger(value.continuation_sequence)
    && isNonEmptyText(value.checkpoint_path)
    && isNonEmptyText(value.checkpoint_hash)
    && isNonEmptyText(value.replacement_worker)
    && isPositiveSafeInteger(value.replacement_generation)
    && isNonEmptyText(value.adoption_token_hash)
    && typeof value.reserved_at === 'string'
    && Number.isFinite(Date.parse(value.reserved_at));
}

function isTaskRecoveryAdoption(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return isNonEmptyText(value.recovery_id)
    && isNonEmptyText(value.request_id)
    && isPositiveSafeInteger(value.continuation_sequence)
    && isNonEmptyText(value.checkpoint_path)
    && isNonEmptyText(value.checkpoint_hash)
    && isNonEmptyText(value.replacement_worker)
    && isPositiveSafeInteger(value.replacement_generation)
    && typeof value.adopted_at === 'string'
    && Number.isFinite(Date.parse(value.adopted_at));
}

function isTeamTask(value: unknown): value is TeamTask {
  if (!isPlainRecord(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !TASK_ID_SAFE_PATTERN.test(v.id)
    || typeof v.subject !== 'string' || typeof v.description !== 'string'
    || typeof v.created_at !== 'string' || !Number.isFinite(Date.parse(v.created_at))
    || typeof v.status !== 'string' || !TEAM_TASK_STATUSES.includes(v.status as TeamTaskStatus)) {
    return false;
  }
  if (v.version !== undefined && (!Number.isSafeInteger(v.version) || (v.version as number) < 1)) return false;
  if (v.owner !== undefined && v.owner !== null && (typeof v.owner !== 'string' || v.owner.trim() === '')) return false;
  try {
    validateTaskDependencies(v, 'invalid_task_dependencies');
  } catch {
    return false;
  }
  if (v.completed_at !== undefined && (typeof v.completed_at !== 'string' || !Number.isFinite(Date.parse(v.completed_at)))) return false;
  if (v.result !== undefined && v.result !== null && typeof v.result !== 'string') return false;
  if (v.error !== undefined && v.error !== null && typeof v.error !== 'string') return false;
  if (v.metadata !== undefined && !isPlainRecord(v.metadata)) return false;
  if (v.recovery_reservation !== undefined && !isTaskRecoveryReservation(v.recovery_reservation)) return false;
  if (v.recovery_adoption !== undefined && !isTaskRecoveryAdoption(v.recovery_adoption)) return false;
  const claim = v.claim;
  if (claim !== undefined) {
    if (!isPlainRecord(claim)
      || typeof claim.owner !== 'string' || claim.owner.trim() === ''
      || typeof claim.token !== 'string' || claim.token.trim() === ''
      || typeof claim.leased_until !== 'string' || !Number.isFinite(Date.parse(claim.leased_until))
      || (claim.launch_attempt_id !== undefined && typeof claim.launch_attempt_id !== 'string')) {
      return false;
    }
  }
  return true;
}

/**
 * Validate and canonicalize a task record at a persistence boundary.
 *
 * The runtime and public task APIs must share this guard so malformed task
 * fields cannot be published while nullable wire fields are normalized.
 */
export function normalizeTaskRecord(value: unknown): TeamTaskV2 {
  if (!isTeamTask(value)) throw new Error('invalid_task_schema');
  return normalizeTask(value);
}

// Process-identity lock: live holders are never stolen by elapsed time alone.
async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    const value = await withProcessIdentityFileLock(lockPath, fn, 100);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Error && error.message === 'process_identity_lock_timeout') return { ok: false };
    throw error;
  }
}

export async function withTaskClaimLock<T>(teamName: string, taskId: string, cwd: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const lockDir = join(teamDir(teamName, cwd), 'tasks', `.lock-${normalizeTaskId(taskId)}`);
  return withLock(lockDir, fn);
}

async function withMailboxLock<T>(teamName: string, workerName: string, cwd: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = absPath(cwd, TeamPaths.mailboxLockDir(teamName, workerName));
  const timeoutMs = 5_000;
  const deadline = Date.now() + timeoutMs;
  let delayMs = 20;

  while (Date.now() < deadline) {
    const result = await withLock(lockDir, fn);
    if (result.ok) return result.value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 200);
  }

  throw new Error(`Failed to acquire mailbox lock for ${workerName} after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Team lifecycle
// ---------------------------------------------------------------------------

function configFromManifest(manifest: TeamManifestV2): TeamConfig {
  return {
    name: manifest.name,
    task: manifest.task,
    agent_type: 'claude',
    policy: manifest.policy,
    governance: manifest.governance,
    worker_launch_mode: manifest.policy.worker_launch_mode,
    worker_count: manifest.worker_count,
    max_workers: 20,
    workers: manifest.workers,
    created_at: manifest.created_at,
    tmux_session: manifest.tmux_session,
    next_task_id: manifest.next_task_id,
    leader_cwd: manifest.leader_cwd,
    team_state_root: manifest.team_state_root,
    workspace_mode: manifest.workspace_mode,
    worktree_mode: manifest.worktree_mode,
    leader_pane_id: manifest.leader_pane_id,
    hud_pane_id: manifest.hud_pane_id,
    resize_hook_name: manifest.resize_hook_name,
    resize_hook_target: manifest.resize_hook_target,
    next_worker_index: manifest.next_worker_index,
    resolved_routing: manifest.resolved_routing,
    resolved_routing_roles: manifest.resolved_routing_roles,
    external_models_defaults: manifest.external_models_defaults,
  };
}

function mergeTeamConfigSources(config: TeamConfig | null, manifest: TeamManifestV2 | null): TeamConfig | null {
  if (!config && !manifest) return null;
  if (config && typeof config.state_revision === 'number' && Number.isSafeInteger(config.state_revision)) {
    return canonicalizeTeamConfigWorkers(config);
  }
  if (!manifest) return config ? canonicalizeTeamConfigWorkers(config) : null;
  if (!config) return canonicalizeTeamConfigWorkers(configFromManifest(manifest));

  return canonicalizeTeamConfigWorkers({
    ...configFromManifest(manifest),
    ...config,
    workers: [...(config.workers ?? []), ...(manifest.workers ?? [])],
    worker_count: Math.max(config.worker_count ?? 0, manifest.worker_count ?? 0),
    next_task_id: Math.max(config.next_task_id ?? 1, manifest.next_task_id ?? 1),
    max_workers: resolveMaxWorkers(config.max_workers),
  });
}

export async function teamReadConfig(teamName: string, cwd: string): Promise<TeamConfig | null> {
  const configPath = absPath(cwd, TeamPaths.config(teamName));
  const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
  const [manifest, config] = await Promise.all([
    teamReadManifest(teamName, cwd),
    readJsonSafe<TeamConfig & { agentTypes?: unknown[] }>(configPath),
  ]);
  if (!config && existsSync(configPath)) throw new Error('invalid_persisted_state');
  if (config && !isValidPersistedMaxWorkers(config.max_workers)) throw new Error('invalid_persisted_state');
  // Preserve raw V1 agentTypes provenance before any worker canonicalization.
  // Canonicalization must not erase the only signal used to route legacy cleanup.
  if (config && Array.isArray((config as { agentTypes?: unknown[] }).agentTypes)) {
    const agentTypes = (config as { agentTypes: unknown[] }).agentTypes;
    // Do not inject empty workers that would reclassify this as V2.
    const { workers: _drop, ...rest } = config as TeamConfig & { workers?: unknown; agentTypes?: unknown[] };
    // Preserve agentTypes provenance; only keep workers if the raw file already had them.
    const rawWorkers = (config as { workers?: unknown }).workers;
    return {
      ...rest,
      agentTypes,
      workers: Array.isArray(rawWorkers) ? rawWorkers as TeamConfig['workers'] : [],
    } as unknown as TeamConfig;
  }
  if (config && typeof config.state_revision === 'number' && Number.isSafeInteger(config.state_revision)) {
    return canonicalizeTeamConfigWorkers(config);
  }
  if (!manifest && existsSync(manifestPath)) throw new Error('invalid_persisted_state');
  return mergeTeamConfigSources(config, manifest);
}

export async function teamReadManifest(teamName: string, cwd: string): Promise<TeamManifestV2 | null> {
  const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
  const manifest = await readJsonSafe<TeamManifestV2>(manifestPath);
  if (!manifest && existsSync(manifestPath)) throw new Error('invalid_persisted_state');
  return manifest ? normalizeTeamManifest(manifest) : null;
}

export async function teamCleanup(teamName: string, cwd: string): Promise<void> {
  await rm(teamDir(teamName, cwd), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Worker operations
// ---------------------------------------------------------------------------

export async function teamWriteWorkerIdentity(
  teamName: string,
  workerName: string,
  identity: WorkerInfo,
  cwd: string,
): Promise<void> {
  const p = absPath(cwd, TeamPaths.workerIdentity(teamName, workerName));
  await writeAtomic(p, JSON.stringify(identity, null, 2));
}

export async function teamReadWorkerHeartbeat(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<WorkerHeartbeat | null> {
  const p = absPath(cwd, TeamPaths.heartbeat(teamName, workerName));
  return readJsonSafe<WorkerHeartbeat>(p);
}

export async function teamUpdateWorkerHeartbeat(
  teamName: string,
  workerName: string,
  heartbeat: WorkerHeartbeat,
  cwd: string,
): Promise<void> {
  const p = absPath(cwd, TeamPaths.heartbeat(teamName, workerName));
  await writeAtomic(p, JSON.stringify(heartbeat, null, 2));
}

export async function teamReadWorkerStatus(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<WorkerStatus> {
  const unknownStatus: WorkerStatus = { state: 'unknown', updated_at: '1970-01-01T00:00:00.000Z' };
  const p = absPath(cwd, TeamPaths.workerStatus(teamName, workerName));
  const status = await readJsonSafe<WorkerStatus>(p);
  return status ?? unknownStatus;
}

export async function teamWriteWorkerInbox(
  teamName: string,
  workerName: string,
  prompt: string,
  cwd: string,
): Promise<void> {
  const p = absPath(cwd, TeamPaths.inbox(teamName, workerName));
  await writeAtomic(p, prompt);
}

// ---------------------------------------------------------------------------
// Task operations
// ---------------------------------------------------------------------------

export async function teamCreateTask(
  teamName: string,
  task: Omit<TeamTask, 'id' | 'created_at'>,
  cwd: string,
): Promise<TeamTaskV2> {
  // Reject malformed dependency fields before entering the config/task
  // transaction. The assigned task id is checked again below for self-links.
  const requestedDependencies = {
    depends_on: task.depends_on,
    blocked_by: task.blocked_by,
  };
  validateTaskDependencies(requestedDependencies, 'invalid_task_dependencies');
  const preflightConfig = await teamReadConfig(teamName, cwd);
  if (preflightConfig?.next_task_id !== undefined) {
    validateTaskDependencies({
      ...requestedDependencies,
      id: String(preflightConfig.next_task_id),
    }, 'invalid_task_dependencies');
  }
  const lockDir = join(teamDir(teamName, cwd), '.lock-create-task');
  const timeoutMs = 5_000;
  const deadline = Date.now() + timeoutMs;
  let delayMs = 20;

  while (Date.now() < deadline) {
    const result = await withLock(lockDir, async () => {
      const revisioned = await migrateTeamConfigRevision(teamName, cwd);
      if (!revisioned) throw new Error(`Team ${teamName} not found`);
      if (revisioned.config.lifecycle_state === 'shutting_down' || revisioned.config.lifecycle_state === 'stopped') {
        throw new Error('team_mutation_busy');
      }

      const nextId = String(revisioned.config.next_task_id ?? 1);
      validateTaskDependencies({
        id: nextId,
        ...requestedDependencies,
      }, 'invalid_task_dependencies');
      const created = createTaskRecord(nextId, task);
      const normalized = normalizeTaskRecord(created);
      const serializedTask = JSON.stringify(normalized, null, 2);
      const createdTaskPath = canonicalTaskFilePath(teamName, nextId, cwd);
      const taskLock = await withTaskClaimLock(teamName, nextId, cwd, async () => {
        await mkdir(dirname(createdTaskPath), { recursive: true });
        await writeAtomic(createdTaskPath, serializedTask);

        const nextConfig: TeamConfig = {
          ...revisioned.config,
          next_task_id: Number(nextId) + 1,
          state_revision: revisioned.stateRevision + 1,
        };
        try {
          if (!await saveTeamConfigAtRevision(nextConfig, revisioned.stateRevision, cwd)) {
            throw new Error('stale_state_revision');
          }
        } catch (error) {
          // A manifest projection can fail after config.json commits. Preserve a task
          // that the authoritative counter/revision already admits.
          const persisted = await readRevisionedTeamConfig(teamName, cwd).catch(() => null);
          const configCommitted = persisted?.stateRevision === nextConfig.state_revision
            && persisted?.config.next_task_id === nextConfig.next_task_id;
          if (!configCommitted && await readFile(createdTaskPath, 'utf8').catch(() => null) === serializedTask) {
            await rm(createdTaskPath, { force: true });
          }
          throw error;
        }
        return normalized;
      });
      if (!taskLock.ok) throw new Error(`Failed to acquire task claim lock for task ${nextId}`);
      return taskLock.value;
    });
    if (result.ok) return result.value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 200);
  }

  throw new Error(`Failed to acquire task creation lock for team ${teamName} after ${timeoutMs}ms`);
}

export async function teamReadTask(teamName: string, taskId: string, cwd: string): Promise<TeamTask | null> {
  const normalizedId = normalizeTaskId(taskId);
  for (const candidate of taskFileCandidates(teamName, normalizedId, cwd)) {
    const state = await readTaskPersistedJson(candidate);
    if (state.kind === 'missing') continue;
    if (state.kind === 'invalid') throw persistedStateError(candidate, state.cause);
    if (!isTeamTask(state.value) || state.value.id !== normalizedId) {
      throw persistedStateError(candidate, 'schema');
    }
    return normalizeTask(state.value);
  }
  return null;
}

export async function teamListTasks(teamName: string, cwd: string): Promise<TeamTask[]> {
  return listTasksImpl(teamName, cwd, {
    teamDir: (tn: string, c: string) => teamDir(tn, c),
    isTeamTask,
    normalizeTask,
    stateError: persistedStateError,
  });
}

export async function teamUpdateTask(
  teamName: string,
  taskId: string,
  updates: Record<string, unknown>,
  cwd: string,
): Promise<TeamTask | null> {
  const timeoutMs = 5_000;
  const deadline = Date.now() + timeoutMs;
  let delayMs = 20;

  while (Date.now() < deadline) {
    const result = await withTaskClaimLock(teamName, taskId, cwd, async () => {
      const existing = await teamReadTask(teamName, taskId, cwd);
      if (!existing) return null;

      const hasDependsOn = Object.prototype.hasOwnProperty.call(updates, 'depends_on');
      const hasBlockedBy = Object.prototype.hasOwnProperty.call(updates, 'blocked_by');
      if ((hasDependsOn && updates.depends_on === undefined)
        || (hasBlockedBy && updates.blocked_by === undefined)) {
        throw new Error('invalid_task_dependencies');
      }

      let dependencyUpdates: { depends_on?: string[]; blocked_by?: string[] } = {};
      if (hasDependsOn || hasBlockedBy) {
        const dependencyIds = validateTaskDependencies({
          id: existing.id,
          ...(hasDependsOn ? { depends_on: updates.depends_on } : {}),
          ...(hasBlockedBy ? { blocked_by: updates.blocked_by } : {}),
        }, 'invalid_task_dependencies');
        dependencyUpdates = {
          depends_on: [...dependencyIds],
          blocked_by: [...dependencyIds],
        };
      }

      const merged: TeamTaskV2 = {
        ...normalizeTask(existing),
        ...updates as Partial<TeamTask>,
        ...dependencyUpdates,
        id: existing.id,
        created_at: existing.created_at,
        version: Math.max(1, existing.version ?? 1) + 1,
      };
      validateTaskDependencies(merged, 'invalid_task_dependencies');
      const normalized = normalizeTaskRecord(merged);

      const p = canonicalTaskFilePath(teamName, taskId, cwd);
      await writeAtomic(p, JSON.stringify(normalized, null, 2));
      return normalized;
    });
    if (result.ok) return result.value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 200);
  }

  throw new Error(`Failed to acquire task update lock for task ${taskId} in team ${teamName} after ${timeoutMs}ms`);
}

export async function teamClaimTask(
  teamName: string,
  taskId: string,
  workerName: string,
  expectedVersion: number | null,
  cwd: string,
): Promise<ClaimTaskResult> {
  const config = await teamReadConfig(teamName, cwd);
  const governance = normalizeTeamGovernance(config?.governance, config?.policy);
  if (governance.plan_approval_required) {
    const task = await teamReadTask(teamName, taskId, cwd);
    if (task?.requires_code_change) {
      const approval = await teamReadTaskApproval(teamName, taskId, cwd);
      if (!approval || approval.status !== 'approved') {
        return { ok: false, error: 'blocked_dependency', dependencies: ['approval-required'] };
      }
    }
  }

  return claimTaskImpl(taskId, workerName, expectedVersion, {
    teamName,
    cwd,
    readTask: teamReadTask,
    readTeamConfig: async (tn: string, c: string) => {
      const cfg = await teamReadConfig(tn, c);
      if (!cfg) return null;
      if (cfg.workers.length > 0) return cfg;

      const match = /^worker-(\d+)$/.exec(workerName);
      const workerIndex = match ? Number.parseInt(match[1], 10) : 0;
      if (workerIndex >= 1 && workerIndex <= (cfg.worker_count ?? 0)) {
        return {
          ...cfg,
          workers: Array.from({ length: cfg.worker_count ?? 0 }, (_, index) => ({
            name: `worker-${index + 1}`,
          })),
        };
      }
      return cfg;
    },
    withTaskClaimLock,
    normalizeTask,
    isTerminalTaskStatus: isTerminalTeamTaskStatus,
    taskFilePath: (tn: string, tid: string, c: string) => canonicalTaskFilePath(tn, tid, c),
    writeAtomic,
    launchAttemptId: process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID,
  });
}

export async function teamTransitionTaskStatus(
  teamName: string,
  taskId: string,
  from: TeamTaskStatus,
  to: TeamTaskStatus,
  claimToken: string,
  cwd: string,
  terminalData?: { result?: string; error?: string; metadata?: Record<string, unknown> },
): Promise<TransitionTaskResult> {
  return transitionTaskStatusImpl(taskId, from, to, claimToken, terminalData, {
    teamName,
    cwd,
    readTask: teamReadTask,
    readTeamConfig: teamReadConfig as (tn: string, c: string) => Promise<{ workers: Array<{ name: string }> } | null>,
    withTaskClaimLock,
    normalizeTask,
    isTerminalTaskStatus: isTerminalTeamTaskStatus,
    canTransitionTaskStatus: canTransitionTeamTaskStatus,
    taskFilePath: (tn: string, tid: string, c: string) => canonicalTaskFilePath(tn, tid, c),
    writeAtomic,
    appendTeamEvent: teamAppendEvent,
    markTaskCompleted: teamMarkTaskCompleted,
  });
}

export async function teamReleaseTaskClaim(
  teamName: string,
  taskId: string,
  claimToken: string,
  workerName: string,
  cwd: string,
): Promise<ReleaseTaskClaimResult> {
  return releaseTaskClaimImpl(taskId, claimToken, workerName, {
    teamName,
    cwd,
    readTask: teamReadTask,
    readTeamConfig: teamReadConfig as (tn: string, c: string) => Promise<{ workers: Array<{ name: string }> } | null>,
    withTaskClaimLock,
    normalizeTask,
    isTerminalTaskStatus: isTerminalTeamTaskStatus,
    taskFilePath: (tn: string, tid: string, c: string) => canonicalTaskFilePath(tn, tid, c),
    writeAtomic,
  });
}

function recoveryTransitionDeps(teamName: string, cwd: string, launchAttemptId?: string) {
  return {
    teamName, cwd, readTask: teamReadTask,
    readTeamConfig: teamReadConfig as (tn: string, c: string) => Promise<{ workers: Array<{ name: string }> } | null>,
    withTaskClaimLock, normalizeTask, isTerminalTaskStatus: isTerminalTeamTaskStatus,
    taskFilePath: (tn: string, tid: string, c: string) => canonicalTaskFilePath(tn, tid, c), writeAtomic,
    ...(launchAttemptId ? { launchAttemptId } : {}),
    readRecoverySidecar: async (tn: string, recoveryId: string, tid: string, c: string): Promise<TaskRecoveryRequeueSidecar | null | 'malformed'> => {
      const path = absPath(c, TeamPaths.taskRecoverySidecar(tn, recoveryId, tid));
      if (!existsSync(path)) return null;
      try { return JSON.parse(await readFile(path, 'utf8')) as TaskRecoveryRequeueSidecar; } catch { return 'malformed'; }
    },
    writeRecoverySidecar: (tn: string, recoveryId: string, tid: string, sidecar: TaskRecoveryRequeueSidecar, c: string) => writeAtomic(absPath(c, TeamPaths.taskRecoverySidecar(tn, recoveryId, tid)), JSON.stringify(sidecar, null, 2)),
    selectRecoveryCheckpoint: selectTaskRecoveryCheckpoint, readRecoveryCheckpoint: readTaskRecoveryCheckpoint,
    verifyAdoptionToken: (token: string, hash: string) => createHash('sha256').update(token).digest('hex') === hash,
  };
}

export async function teamPublishTaskRecoveryCheckpoint(input: PublishTaskRecoveryCheckpointInput, cwd: string) {
  return publishTaskRecoveryCheckpointImpl(input, cwd, { readTask: async (tn, tid, c) => {
    const task = await teamReadTask(tn, tid, c); return task ? normalizeTask(task) : null;
  }, withTaskLock: withTaskClaimLock });
}

export async function teamRequeueRecoveredTask(teamName: string, cwd: string, input: { recoveryId: string; requestId: string; taskId: string; replacementWorker: string; replacementGeneration: number; adoptionTokenHash: string }): Promise<TaskRecoveryRequeueResult> {
  return requeueRecoveredTaskImpl(input, recoveryTransitionDeps(teamName, cwd));
}

/** Runtime-owner-only continuation adoption; call before provider launch. */
export async function teamAdoptRecoveryReservations(teamName: string, cwd: string, taskIds: string[], workerName: string, proof: TaskRecoveryAdoptionProof, launchAttemptId?: string): Promise<TaskRecoveryAdoptionResult[]> {
  return adoptRecoveryReservationsImpl(taskIds, workerName, proof, recoveryTransitionDeps(teamName, cwd, launchAttemptId));
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function normalizeLegacyMailboxMessage(raw: Record<string, unknown>): TeamMailboxMessage | null {
  if (raw.type === 'notified') return null;
  const messageId = typeof raw.message_id === 'string' && raw.message_id.trim() !== ''
    ? raw.message_id
    : (typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : '');
  const fromWorker = typeof raw.from_worker === 'string' && raw.from_worker.trim() !== ''
    ? raw.from_worker
    : (typeof raw.from === 'string' ? raw.from : '');
  const toWorker = typeof raw.to_worker === 'string' && raw.to_worker.trim() !== ''
    ? raw.to_worker
    : (typeof raw.to === 'string' ? raw.to : '');
  const body = typeof raw.body === 'string' ? raw.body : '';
  const createdAt = typeof raw.created_at === 'string' && raw.created_at.trim() !== ''
    ? raw.created_at
    : (typeof raw.createdAt === 'string' ? raw.createdAt : '');

  if (!messageId || !fromWorker || !toWorker || !body || !createdAt) return null;
  return {
    message_id: messageId,
    from_worker: fromWorker,
    to_worker: toWorker,
    body,
    created_at: createdAt,
    ...(typeof raw.notified_at === 'string' ? { notified_at: raw.notified_at } : {}),
    ...(typeof raw.notifiedAt === 'string' ? { notified_at: raw.notifiedAt } : {}),
    ...(typeof raw.delivered_at === 'string' ? { delivered_at: raw.delivered_at } : {}),
    ...(typeof raw.deliveredAt === 'string' ? { delivered_at: raw.deliveredAt } : {}),
  };
}

async function readLegacyMailboxJsonl(teamName: string, workerName: string, cwd: string): Promise<TeamMailbox> {
  const legacyPath = absPath(cwd, TeamPaths.mailbox(teamName, workerName).replace(/\.json$/i, '.jsonl'));
  if (!existsSync(legacyPath)) return { worker: workerName, messages: [] };

  try {
    const raw = await readFile(legacyPath, 'utf8');
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    const byMessageId = new Map<string, TeamMailboxMessage>();
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const normalized = normalizeLegacyMailboxMessage(parsed as Record<string, unknown>);
      if (!normalized) continue;
      byMessageId.set(normalized.message_id, normalized);
    }
    return { worker: workerName, messages: [...byMessageId.values()] };
  } catch {
    return { worker: workerName, messages: [] };
  }
}

async function readMailbox(teamName: string, workerName: string, cwd: string): Promise<TeamMailbox> {
  const p = absPath(cwd, TeamPaths.mailbox(teamName, workerName));
  const mailbox = await readJsonSafe<TeamMailbox>(p);
  if (mailbox && Array.isArray(mailbox.messages)) {
    return { worker: workerName, messages: mailbox.messages };
  }
  return readLegacyMailboxJsonl(teamName, workerName, cwd);
}

function isStrictCanonicalMailboxRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isStrictCanonicalMailboxText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim();
}

function isStrictCanonicalMailboxTimestamp(value: unknown): value is string {
  return isStrictCanonicalMailboxText(value) && Number.isFinite(Date.parse(value));
}

function materializeStrictCanonicalMailboxMessage(raw: Record<string, unknown>): TeamMailboxMessage {
  const message: TeamMailboxMessage = {
    message_id: raw.message_id as string,
    from_worker: raw.from_worker as string,
    to_worker: raw.to_worker as string,
    body: raw.body as string,
    created_at: raw.created_at as string,
  };
  if ('notified_at' in raw) message.notified_at = raw.notified_at as string;
  if ('delivered_at' in raw) message.delivered_at = raw.delivered_at as string;
  return message;
}

function validateStrictCanonicalMailboxMessage(
  raw: unknown,
  messageIndex: number,
): TeamMailboxMessage | Extract<StrictCanonicalMailboxMessageReadResult, { kind: 'malformed_message' }> {
  if (!isStrictCanonicalMailboxRecord(raw)) return { kind: 'malformed_message', messageIndex, field: '$' };
  if (!isStrictCanonicalMailboxText(raw.message_id)) return { kind: 'malformed_message', messageIndex, field: 'message_id' };
  if (!isStrictCanonicalMailboxText(raw.from_worker)) return { kind: 'malformed_message', messageIndex, field: 'from_worker' };
  if (!isStrictCanonicalMailboxText(raw.to_worker)) return { kind: 'malformed_message', messageIndex, field: 'to_worker' };
  if (!isStrictCanonicalMailboxText(raw.body)) return { kind: 'malformed_message', messageIndex, field: 'body' };
  if (!isStrictCanonicalMailboxTimestamp(raw.created_at)) return { kind: 'malformed_message', messageIndex, field: 'created_at' };
  if ('notified_at' in raw && !isStrictCanonicalMailboxTimestamp(raw.notified_at)) {
    return { kind: 'malformed_message', messageIndex, field: 'notified_at' };
  }
  if ('delivered_at' in raw && !isStrictCanonicalMailboxTimestamp(raw.delivered_at)) {
    return { kind: 'malformed_message', messageIndex, field: 'delivered_at' };
  }
  return materializeStrictCanonicalMailboxMessage(raw);
}

/**
 * Reads one exact message from the canonical JSON mailbox without using the
 * compatibility JSONL fallback. It validates every canonical record first so
 * a corrupt or ambiguous mailbox cannot authorize a pane notification.
 */
export async function teamReadCanonicalMailboxMessageStrict(
  teamName: string,
  workerName: string,
  messageId: string,
  cwd: string,
): Promise<StrictCanonicalMailboxMessageReadResult> {
  const path = absPath(cwd, TeamPaths.mailbox(teamName, workerName));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { kind: 'store_missing' }
      : { kind: 'malformed_store', cause: 'json' };
  }
  if (!isStrictCanonicalMailboxRecord(parsed)) return { kind: 'malformed_store', cause: 'non_object' };
  if (parsed.worker !== workerName) return { kind: 'wrong_owner' };
  if (!Array.isArray(parsed.messages)) return { kind: 'malformed_store', cause: 'messages_non_array' };

  const messages: TeamMailboxMessage[] = [];
  for (let messageIndex = 0; messageIndex < parsed.messages.length; messageIndex += 1) {
    const validated = validateStrictCanonicalMailboxMessage(parsed.messages[messageIndex], messageIndex);
    if (!('message_id' in validated)) return validated;
    messages.push(validated);
  }

  const indexesByMessageId = new Map<string, number[]>();
  for (const [messageIndex, message] of messages.entries()) {
    const indexes = indexesByMessageId.get(message.message_id) ?? [];
    indexes.push(messageIndex);
    indexesByMessageId.set(message.message_id, indexes);
  }
  const requestedIndexes = indexesByMessageId.get(messageId) ?? [];
  if (requestedIndexes.length > 1) {
    return { kind: 'duplicate_message_id', messageId, messageIndexes: requestedIndexes };
  }
  const duplicate = [...indexesByMessageId.entries()].find(([, indexes]) => indexes.length > 1);
  if (duplicate) return { kind: 'duplicate_message_id', messageId: duplicate[0], messageIndexes: duplicate[1] };
  if (requestedIndexes.length === 0) return { kind: 'message_missing' };

  const messageIndex = requestedIndexes[0]!;
  const message = messages[messageIndex]!;
  if (message.to_worker !== workerName) return { kind: 'recipient_mismatch', messageIndex };
  if (message.notified_at) return { kind: 'replay_suppressed', message: { ...message }, marker: 'notified_at' };
  if (message.delivered_at) return { kind: 'replay_suppressed', message: { ...message }, marker: 'delivered_at' };
  return { kind: 'valid', message: { ...message } };
}

async function writeMailbox(teamName: string, workerName: string, mailbox: TeamMailbox, cwd: string): Promise<void> {
  const p = absPath(cwd, TeamPaths.mailbox(teamName, workerName));
  await writeAtomic(p, JSON.stringify(mailbox, null, 2));
}

export async function teamSendMessage(
  teamName: string,
  fromWorker: string,
  toWorker: string,
  body: string,
  cwd: string,
): Promise<TeamMailboxMessage> {
  return withMailboxLock(teamName, toWorker, cwd, async () => {
    const mailbox = await readMailbox(teamName, toWorker, cwd);
    const message: TeamMailboxMessage = {
      message_id: randomUUID(),
      from_worker: fromWorker,
      to_worker: toWorker,
      body,
      created_at: new Date().toISOString(),
    };
    mailbox.messages.push(message);
    await writeMailbox(teamName, toWorker, mailbox, cwd);

    await teamAppendEvent(teamName, {
      type: 'message_received',
      worker: toWorker,
      message_id: message.message_id,
    }, cwd);

    return message;
  });
}

export async function teamBroadcast(
  teamName: string,
  fromWorker: string,
  body: string,
  cwd: string,
): Promise<TeamMailboxMessage[]> {
  const cfg = await teamReadConfig(teamName, cwd);
  if (!cfg) throw new Error(`Team ${teamName} not found`);

  const messages: TeamMailboxMessage[] = [];
  for (const worker of cfg.workers) {
    if (worker.name === fromWorker) continue;
    const msg = await teamSendMessage(teamName, fromWorker, worker.name, body, cwd);
    messages.push(msg);
  }
  return messages;
}

export async function teamListMailbox(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<TeamMailboxMessage[]> {
  const mailbox = await readMailbox(teamName, workerName, cwd);
  return mailbox.messages;
}

export async function teamMarkMessageDelivered(
  teamName: string,
  workerName: string,
  messageId: string,
  cwd: string,
): Promise<boolean> {
  return withMailboxLock(teamName, workerName, cwd, async () => {
    const mailbox = await readMailbox(teamName, workerName, cwd);
    const msg = mailbox.messages.find((m) => m.message_id === messageId);
    if (!msg) return false;
    msg.delivered_at = new Date().toISOString();
    await writeMailbox(teamName, workerName, mailbox, cwd);
    return true;
  });
}

export async function teamMarkMessageNotified(
  teamName: string,
  workerName: string,
  messageId: string,
  cwd: string,
): Promise<boolean> {
  return withMailboxLock(teamName, workerName, cwd, async () => {
    const mailbox = await readMailbox(teamName, workerName, cwd);
    const msg = mailbox.messages.find((m) => m.message_id === messageId);
    if (!msg) return false;
    msg.notified_at = new Date().toISOString();
    await writeMailbox(teamName, workerName, mailbox, cwd);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function teamAppendEvent(
  teamName: string,
  event: Omit<TeamEvent, 'event_id' | 'created_at' | 'team'>,
  cwd: string,
): Promise<TeamEvent> {
  const full: TeamEvent = {
    event_id: randomUUID(),
    team: teamName,
    created_at: new Date().toISOString(),
    ...event,
  };
  const p = absPath(cwd, TeamPaths.events(teamName));
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, `${JSON.stringify(full)}\n`, 'utf8');
  return full;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function teamReadTaskApproval(
  teamName: string,
  taskId: string,
  cwd: string,
): Promise<TaskApprovalRecord | null> {
  const p = absPath(cwd, TeamPaths.approval(teamName, taskId));
  return readJsonSafe<TaskApprovalRecord>(p);
}

export async function teamWriteTaskApproval(
  teamName: string,
  approval: TaskApprovalRecord,
  cwd: string,
): Promise<void> {
  const p = absPath(cwd, TeamPaths.approval(teamName, approval.task_id));
  await writeAtomic(p, JSON.stringify(approval, null, 2));

  await teamAppendEvent(teamName, {
    type: 'approval_decision',
    worker: approval.reviewer,
    task_id: approval.task_id,
    reason: `${approval.status}: ${approval.decision_reason}`,
  }, cwd);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export async function teamGetSummary(teamName: string, cwd: string): Promise<TeamSummary | null> {
  const startMs = Date.now();
  const cfg = await teamReadConfig(teamName, cwd);
  if (!cfg) return null;

  const tasksStartMs = Date.now();
  const tasks = await teamListTasks(teamName, cwd);
  const tasksLoadedMs = Date.now() - tasksStartMs;

  const counts = {
    total: tasks.length,
    pending: 0,
    blocked: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
  };
  for (const t of tasks) {
    if (t.status in counts) counts[t.status as keyof typeof counts]++;
  }

  const workersStartMs = Date.now();
  const workerEntries: TeamSummary['workers'] = [];
  const nonReporting: string[] = [];

  for (const w of cfg.workers) {
    const hb = await teamReadWorkerHeartbeat(teamName, w.name, cwd);
    const baseWorkerSummary = {
      name: w.name,
      working_dir: w.working_dir,
      worktree_repo_root: w.worktree_repo_root,
      worktree_path: w.worktree_path,
      worktree_branch: w.worktree_branch,
      worktree_detached: w.worktree_detached,
      worktree_created: w.worktree_created,
      team_state_root: w.team_state_root,
    };
    if (!hb) {
      nonReporting.push(w.name);
      workerEntries.push({ ...baseWorkerSummary, alive: false, lastTurnAt: null, turnsWithoutProgress: 0 });
    } else {
      workerEntries.push({
        ...baseWorkerSummary,
        alive: hb.alive,
        lastTurnAt: hb.last_turn_at,
        turnsWithoutProgress: 0,
      });
    }
  }
  const workersPollMs = Date.now() - workersStartMs;

  const performance: TeamSummaryPerformance = {
    total_ms: Date.now() - startMs,
    tasks_loaded_ms: tasksLoadedMs,
    workers_polled_ms: workersPollMs,
    task_count: tasks.length,
    worker_count: cfg.workers.length,
  };

  return {
    teamName,
    workerCount: cfg.workers.length,
    team_state_root: cfg.team_state_root,
    workspace_mode: cfg.workspace_mode,
    worktree_mode: cfg.worktree_mode,
    tasks: counts,
    workers: workerEntries,
    nonReportingWorkers: nonReporting,
    performance,
  };
}

// ---------------------------------------------------------------------------
// Shutdown control
// ---------------------------------------------------------------------------

export async function teamWriteShutdownRequest(
  teamName: string,
  workerName: string,
  requestedBy: string,
  cwd: string,
): Promise<void> {
  const p = absPath(cwd, TeamPaths.shutdownRequest(teamName, workerName));
  await writeAtomic(p, JSON.stringify({ requested_at: new Date().toISOString(), requested_by: requestedBy }, null, 2));
}

export async function teamReadShutdownAck(
  teamName: string,
  workerName: string,
  cwd: string,
  minUpdatedAt?: string,
): Promise<ShutdownAck | null> {
  const ackPath = absPath(cwd, TeamPaths.shutdownAck(teamName, workerName));
  const parsed = await readJsonSafe<ShutdownAck>(ackPath);
  if (!parsed || (parsed.status !== 'accept' && parsed.status !== 'reject')) return null;

  if (typeof minUpdatedAt === 'string' && minUpdatedAt.trim() !== '') {
    const minTs = Date.parse(minUpdatedAt);
    const ackTs = Date.parse(parsed.updated_at ?? '');
    if (!Number.isFinite(minTs) || !Number.isFinite(ackTs) || ackTs < minTs) return null;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Monitor snapshot
// ---------------------------------------------------------------------------

function isMonitorSnapshotState(value: unknown): value is TeamMonitorSnapshotState {
  if (!isPlainRecord(value)) return false;
  const recordValuesAre = (field: string, predicate: (entry: unknown) => boolean): boolean => {
    const map = value[field];
    return map === undefined
      || (isPlainRecord(map) && Object.values(map).every(predicate));
  };
  const mapFields = [
    'taskStatusById',
    'workerAliveByName',
    'workerStateByName',
    'workerTurnCountByName',
    'workerTaskIdByName',
    'mailboxNotifiedByMessageId',
    'completedEventTaskIds',
  ] as const;
  if (!isPlainRecord(value.completedEventTaskIds)) return false;
  if (!mapFields.every((field) => value[field] === undefined || isPlainRecord(value[field]))) return false;
  if (value.workerLivenessByName !== undefined && !isPlainRecord(value.workerLivenessByName)) return false;
  if (!recordValuesAre('taskStatusById', (entry) => typeof entry === 'string')
    || !recordValuesAre('workerAliveByName', (entry) => typeof entry === 'boolean')
    || !recordValuesAre('workerLivenessByName', (entry) => entry === 'alive' || entry === 'dead' || entry === 'unknown')
    || !recordValuesAre('workerStateByName', (entry) => typeof entry === 'string')
    || !recordValuesAre('workerTurnCountByName', (entry) => typeof entry === 'number' && Number.isFinite(entry))
    || !recordValuesAre('workerTaskIdByName', (entry) => typeof entry === 'string')
    || !recordValuesAre('mailboxNotifiedByMessageId', (entry) => typeof entry === 'string')
    || !recordValuesAre('completedEventTaskIds', (entry) => typeof entry === 'boolean')) {
    return false;
  }
  if (value.monitorTimings !== undefined) {
    if (!isPlainRecord(value.monitorTimings)
      || typeof value.monitorTimings.list_tasks_ms !== 'number'
      || typeof value.monitorTimings.worker_scan_ms !== 'number'
      || typeof value.monitorTimings.mailbox_delivery_ms !== 'number'
      || typeof value.monitorTimings.total_ms !== 'number'
      || typeof value.monitorTimings.updated_at !== 'string') {
      return false;
    }
  }
  return true;
}

export async function teamReadMonitorSnapshot(
  teamName: string,
  cwd: string,
): Promise<TeamMonitorSnapshotState | null> {
  const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
  const state = await readPersistedJson<unknown>(p);
  if (state.kind === 'missing') return null;
  // The monitor snapshot is a rebuildable cache. Task files remain
  // authoritative, so malformed or unreadable cache state is treated as
  // absent and can be replaced by the next successful writer.
  if (state.kind === 'invalid' || !isMonitorSnapshotState(state.value)) return null;
  return {
    taskStatusById: state.value.taskStatusById ?? {},
    workerAliveByName: state.value.workerAliveByName ?? {},
    workerLivenessByName: state.value.workerLivenessByName ?? {},
    workerStateByName: state.value.workerStateByName ?? {},
    workerTurnCountByName: state.value.workerTurnCountByName ?? {},
    workerTaskIdByName: state.value.workerTaskIdByName ?? {},
    mailboxNotifiedByMessageId: state.value.mailboxNotifiedByMessageId ?? {},
    completedEventTaskIds: state.value.completedEventTaskIds,
    ...(state.value.monitorTimings ? { monitorTimings: state.value.monitorTimings } : {}),
  };
}

export async function teamWriteMonitorSnapshot(
  teamName: string,
  snapshot: TeamMonitorSnapshotState,
  cwd: string,
): Promise<void> {
  const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
  if (!isMonitorSnapshotState(snapshot)) throw persistedStateError(p, 'schema');
  const lockPath = join(teamDir(teamName, cwd), '.monitor-snapshot.lock');
  await withProcessIdentityFileLock(lockPath, async () => {
    const currentState = await readPersistedJson<unknown>(p);
    // A stale/corrupt cache must not make task state unusable. Replace it
    // with the caller's current projection while preserving any valid
    // completion markers that survived from the previous cache.
    const current: TeamMonitorSnapshotState | null = currentState.kind === 'value' && isMonitorSnapshotState(currentState.value)
      ? currentState.value
      : null;
    const completedEventTaskIds = { ...snapshot.completedEventTaskIds };
    for (const [taskId, completed] of Object.entries(current?.completedEventTaskIds ?? {})) {
      if (completed) completedEventTaskIds[taskId] = true;
    }
    await writeAtomic(p, JSON.stringify({ ...snapshot, completedEventTaskIds }, null, 2));
  }, 5_000);
}

/**
 * Persist only the completion marker for a task. The latest monitor snapshot
 * is read while holding the snapshot lock, so an older completion operation
 * cannot overwrite fresh monitor-owned fields.
 */
export async function teamMarkTaskCompleted(
  teamName: string,
  taskId: string,
  cwd: string,
): Promise<void> {
  const normalizedTaskId = normalizeTaskId(taskId);
  const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
  const lockPath = join(teamDir(teamName, cwd), '.monitor-snapshot.lock');
  await withProcessIdentityFileLock(lockPath, async () => {
    const state = await readPersistedJson<unknown>(p);
    const current = state.kind === 'value' && isMonitorSnapshotState(state.value)
      ? state.value
      : null;
    const next: TeamMonitorSnapshotState = current
      ? {
          ...current,
          completedEventTaskIds: {
            ...current.completedEventTaskIds,
            [normalizedTaskId]: true,
          },
        }
      : {
          taskStatusById: {},
          workerAliveByName: {},
          workerLivenessByName: {},
          workerStateByName: {},
          workerTurnCountByName: {},
          workerTaskIdByName: {},
          mailboxNotifiedByMessageId: {},
          completedEventTaskIds: { [normalizedTaskId]: true },
        };
    await writeAtomic(p, JSON.stringify(next, null, 2));
  }, 5_000);
}

// Atomic write re-export for other modules
export { writeAtomic };
