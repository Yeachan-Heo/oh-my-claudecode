/**
 * Snapshot-based team monitor — mirrors OMX monitorTeam semantics.
 *
 * Reads team config, tasks, worker heartbeats/status, computes deltas
 * against previous snapshot, emits events, delivers mailbox messages,
 * and persists the new snapshot for the next cycle.
 *
 * NO polling watchdog. The caller (runtime-v2 or runtime-cli) drives
 * the monitor loop.
 */

import { existsSync } from 'fs';
import { readFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { performance } from 'perf_hooks';
import { CANONICAL_TEAM_ROLES, KNOWN_AGENT_NAMES } from '../shared/types.js';
import type { RoleAssignment } from '../shared/types.js';

import { WORKER_NAME_SAFE_PATTERN } from './contracts.js';

import { TeamPaths, absPath } from './state-paths.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import type {
  TeamConfig,
  TeamManifestV2,
  TeamMonitorSnapshotState,
  TeamPhaseState,
  WorkerStatus,
  WorkerHeartbeat,
  WorkerInfo,
  TeamTask,
  TeamSummary,
  TeamSummaryPerformance,
} from './types.js';
import type { TeamPhase } from './phase-controller.js';
import { normalizeTeamManifest } from './governance.js';
import { canonicalizeTeamConfigWorkers } from './worker-canonicalization.js';

// ---------------------------------------------------------------------------
// State I/O helpers (self-contained, no external deps beyond fs)
// ---------------------------------------------------------------------------

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    if (!existsSync(filePath)) return null;
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

type JsonFileState<T> = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'value'; value: T };

async function readJsonFileState<T>(filePath: string): Promise<JsonFileState<T>> {
  try {
    return { kind: 'value', value: JSON.parse(await readFile(filePath, 'utf8')) as T };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
  }
}

async function writeAtomic(filePath: string, data: string): Promise<void> {
  const { writeFile } = await import('fs/promises');
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, data, 'utf-8');
  const { rename } = await import('fs/promises');
  await rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Config / Manifest readers
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
    service_descriptor: manifest.service_descriptor,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isWorkerInfo(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== 'string' || !WORKER_NAME_SAFE_PATTERN.test(value.name) || !isSafeCounter(value.index) || value.index < 1) return false;
  return (value.role === undefined || typeof value.role === 'string')
    && (value.assigned_tasks === undefined || isStringArray(value.assigned_tasks))
    && (value.worker_cli === undefined || ['claude', 'codex', 'gemini', 'cursor', 'grok', 'antigravity'].includes(value.worker_cli as string))
    && (value.pid === undefined || (isSafeCounter(value.pid) && value.pid > 0))
    && (value.pane_id === undefined || typeof value.pane_id === 'string')
    && (value.working_dir === undefined || typeof value.working_dir === 'string')
    && (value.worktree_repo_root === undefined || typeof value.worktree_repo_root === 'string')
    && (value.worktree_path === undefined || typeof value.worktree_path === 'string')
    && (value.worktree_branch === undefined || typeof value.worktree_branch === 'string')
    && (value.worktree_detached === undefined || typeof value.worktree_detached === 'boolean')
    && (value.worktree_created === undefined || typeof value.worktree_created === 'boolean')
    && (value.team_state_root === undefined || typeof value.team_state_root === 'string')
    && (value.output_file === undefined || typeof value.output_file === 'string')
    && (value.recovery_id === undefined || isNonEmptyString(value.recovery_id))
    && (value.replacement_generation === undefined || isSafeCounter(value.replacement_generation))
    && (value.pane_attempt_id === undefined || isNonEmptyString(value.pane_attempt_id))
    && (value.operational_state === undefined || ['starting', 'active', 'dead', 'stopped'].includes(value.operational_state as string))
    && (value.launch_descriptor === undefined || isLaunchDescriptor(value.launch_descriptor));
}

function isLaunchDescriptor(value: unknown): boolean {
  return isRecord(value) && value.schema_version === 1
    && ['claude', 'codex', 'gemini', 'cursor', 'grok', 'antigravity'].includes(value.provider as string)
    && (value.model === null || typeof value.model === 'string')
    && isNonEmptyString(value.binary) && isStringArray(value.args);
}

function isOwnerEpoch(value: unknown): boolean {
  return isRecord(value) && isSafeCounter(value.epoch) && value.epoch > 0 && isNonEmptyString(value.nonce)
    && isSafeCounter(value.pid) && value.pid > 0 && isNonEmptyString(value.process_started_at) && isTimestamp(value.created_at);
}

function isRecoveryAttempt(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.request_id) && isNonEmptyString(value.recovery_id)
    && isNonEmptyString(value.worker_name) && isSafeCounter(value.owner_epoch) && value.owner_epoch > 0
    && isNonEmptyString(value.owner_nonce) && ['reserved', 'requeued', 'ready', 'active', 'services_pending', 'adopted', 'failed'].includes(value.phase as string)
    && (value.original_pane_id === undefined || typeof value.original_pane_id === 'string')
    && isSafeCounter(value.state_revision) && isTimestamp(value.created_at) && isTimestamp(value.updated_at);
}

function isScaleUpAttempt(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.operation_id) && ['reserved', 'effects', 'failed'].includes(value.phase as string)
    && isSafeCounter(value.pid) && value.pid > 0 && isNonEmptyString(value.process_started_at) && isSafeCounter(value.state_revision)
    && isTimestamp(value.created_at) && isTimestamp(value.updated_at)
    && (value.failure_reason === undefined || typeof value.failure_reason === 'string');
}

function isScaleDownAttempt(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.operation_id) && ['draining', 'effects', 'failed'].includes(value.phase as string)
    && isSafeCounter(value.pid) && value.pid > 0 && isNonEmptyString(value.process_started_at) && Array.isArray(value.workers)
    && value.workers.every(worker => isRecord(worker) && isNonEmptyString(worker.name)
      && (worker.pane_id === undefined || typeof worker.pane_id === 'string')
      && (worker.worktree_path === undefined || typeof worker.worktree_path === 'string')
      && (worker.worktree_created === undefined || typeof worker.worktree_created === 'boolean'))
    && isSafeCounter(value.state_revision) && isTimestamp(value.created_at) && isTimestamp(value.updated_at)
    && (value.failure_reason === undefined || typeof value.failure_reason === 'string');
}

function isServiceDescriptor(value: unknown): boolean {
  return isRecord(value) && value.schema_version === 1 && isSafeCounter(value.service_generation)
    && isNonEmptyString(value.service_attempt_id) && typeof value.auto_merge_enabled === 'boolean'
    && isNonEmptyString(value.workspace_root) && (value.leader_branch === undefined || typeof value.leader_branch === 'string')
    && ['disabled', 'worker-auto-commit-v1'].includes(value.cadence_policy as string);
}

function isShutdownAttempt(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.nonce) && isSafeCounter(value.pid) && value.pid > 0
    && isNonEmptyString(value.process_started_at) && isSafeCounter(value.state_revision) && isTimestamp(value.created_at);
}

function isAllDeadRecovery(value: unknown): boolean {
  return isRecord(value) && isTimestamp(value.detected_at) && isTimestamp(value.deadline_at) && isSafeCounter(value.state_revision);
}

function isTeamConfig(value: unknown, requireRevision: boolean, expectedTeamName?: string): value is TeamConfig {
  if (!isRecord(value) || !isNonEmptyString(value.name) || (expectedTeamName !== undefined && value.name !== expectedTeamName)
    || !isNonEmptyString(value.agent_type)
    || (value.task !== undefined && typeof value.task !== 'string')
    || (value.worker_launch_mode !== undefined && !['interactive', 'prompt'].includes(value.worker_launch_mode as string))
    || !isSafeCounter(value.worker_count)
    || (value.max_workers !== undefined && !isSafeCounter(value.max_workers))
    || !Array.isArray(value.workers) || value.worker_count !== value.workers.length
    || !value.workers.every(isWorkerInfo) || !hasUniqueWorkerIdentity(value.workers)
    || !isTimestamp(value.created_at) || !isNonEmptyString(value.tmux_session)
    || (value.next_task_id !== undefined && !isSafeCounter(value.next_task_id))
    || !isOptionalPolicy(value.policy) || !isOptionalGovernance(value.governance)
    || !isOptionalWorkspaceShape(value) || !isOptionalPaneShape(value)
    || !isOptionalRouting(value.resolved_routing)) return false;
  if (requireRevision ? !isSafeCounter(value.state_revision) : value.state_revision !== undefined && !isSafeCounter(value.state_revision)) return false;
  if (!requireRevision && Object.hasOwn(value, 'state_revision')) return false;
  return (value.lifecycle_state === undefined || ['active', 'shutting_down', 'stopped'].includes(value.lifecycle_state as string))
    && (value.runtime_owner_epoch === undefined || isOwnerEpoch(value.runtime_owner_epoch))
    && (value.active_recovery === undefined || isRecoveryAttempt(value.active_recovery))
    && (value.last_recovery === undefined || isRecoveryAttempt(value.last_recovery))
    && (value.active_scale_up === undefined || isScaleUpAttempt(value.active_scale_up))
    && (value.active_scale_down === undefined || isScaleDownAttempt(value.active_scale_down))
    && (value.service_descriptor === undefined || isServiceDescriptor(value.service_descriptor))
    && (value.shutdown_attempt === undefined || isShutdownAttempt(value.shutdown_attempt))
    && (value.all_dead_recovery === undefined || isAllDeadRecovery(value.all_dead_recovery))
    && hasMatchingActiveFenceRevisions(value);
}

function hasUniqueWorkerIdentity(workers: unknown[]): boolean {
  const names = new Set<string>();
  const indices = new Set<number>();
  return workers.every(worker => {
    if (!isRecord(worker) || typeof worker.name !== 'string' || !WORKER_NAME_SAFE_PATTERN.test(worker.name) || typeof worker.index !== 'number') return false;
    if (names.has(worker.name) || indices.has(worker.index)) return false;
    names.add(worker.name);
    indices.add(worker.index);
    return true;
  });
}

function isOptionalPolicy(value: unknown): boolean {
  return value === undefined || (isRecord(value)
    && ['split_pane', 'auto'].includes(value.display_mode as string)
    && ['interactive', 'prompt'].includes(value.worker_launch_mode as string)
    && ['hook_preferred_with_fallback', 'transport_direct'].includes(value.dispatch_mode as string)
    && isSafeCounter(value.dispatch_ack_timeout_ms));
}

function isOptionalGovernance(value: unknown): boolean {
  return value === undefined || (isRecord(value)
    && typeof value.delegation_only === 'boolean'
    && typeof value.plan_approval_required === 'boolean'
    && typeof value.nested_teams_allowed === 'boolean'
    && typeof value.one_team_per_leader_session === 'boolean'
    && typeof value.cleanup_requires_all_workers_inactive === 'boolean');
}

function isOptionalWorkspaceShape(value: Record<string, unknown>): boolean {
  return (value.leader_cwd === undefined || typeof value.leader_cwd === 'string')
    && (value.team_state_root === undefined || typeof value.team_state_root === 'string')
    && (value.workspace_mode === undefined || ['single', 'worktree'].includes(value.workspace_mode as string))
    && (value.worktree_mode === undefined || ['disabled', 'detached', 'named'].includes(value.worktree_mode as string))
    && (value.lifecycle_profile === undefined || ['default', 'linked_ralph'].includes(value.lifecycle_profile as string));
}

function isOptionalPaneShape(value: Record<string, unknown>): boolean {
  return (value.leader_pane_id === undefined || value.leader_pane_id === null || typeof value.leader_pane_id === 'string')
    && (value.hud_pane_id === undefined || value.hud_pane_id === null || typeof value.hud_pane_id === 'string')
    && (value.resize_hook_name === undefined || value.resize_hook_name === null || typeof value.resize_hook_name === 'string')
    && (value.resize_hook_target === undefined || value.resize_hook_target === null || typeof value.resize_hook_target === 'string')
    && (value.next_worker_index === undefined || (isSafeCounter(value.next_worker_index) && value.next_worker_index > 0));
}

function isOptionalRouting(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || Object.keys(value).length !== CANONICAL_TEAM_ROLES.length) return false;
  return CANONICAL_TEAM_ROLES.every(role => isResolvedRoleRoute(value[role]));
}

function isResolvedRoleRoute(value: unknown): value is { primary: RoleAssignment; fallback: RoleAssignment } {
  return isRecord(value) && isRoleAssignment(value.primary) && isRoleAssignment(value.fallback);
}

function isRoleAssignment(value: unknown): value is RoleAssignment {
  return isRecord(value)
    && ['claude', 'codex', 'gemini', 'grok', 'cursor', 'antigravity'].includes(value.provider as string)
    && isNonEmptyString(value.model)
    && KNOWN_AGENT_NAMES.some(agent => agent === value.agent);
}

function hasMatchingActiveFenceRevisions(value: Record<string, unknown>): boolean {
  if (!isSafeCounter(value.state_revision)) return true;
  const revision = value.state_revision;
  return [value.active_recovery, value.active_scale_up, value.active_scale_down, value.shutdown_attempt, value.all_dead_recovery]
    .every(fence => fence === undefined || (isRecord(fence) && fence.state_revision === revision));
}

function alignActiveFenceRevisions(config: TeamConfig, revision: number): TeamConfig {
  return {
    ...config,
    ...(config.active_recovery ? { active_recovery: { ...config.active_recovery, state_revision: revision } } : {}),
    ...(config.active_scale_up ? { active_scale_up: { ...config.active_scale_up, state_revision: revision } } : {}),
    ...(config.active_scale_down ? { active_scale_down: { ...config.active_scale_down, state_revision: revision } } : {}),
    ...(config.shutdown_attempt ? { shutdown_attempt: { ...config.shutdown_attempt, state_revision: revision } } : {}),
    ...(config.all_dead_recovery ? { all_dead_recovery: { ...config.all_dead_recovery, state_revision: revision } } : {}),
  };
}

/** Accept only a complete revisioned authoritative config; return null for malformed values. */
export function validateRevisionedTeamConfig(value: unknown, expectedTeamName?: string): TeamConfig | null {
  return isTeamConfig(value, true, expectedTeamName) ? value : null;
}

/** Legacy configs predate revision authority and require the complete historical core shape. */
export function validateLegacyTeamConfig(value: unknown, expectedTeamName?: string): TeamConfig | null {
  return isTeamConfig(value, false, expectedTeamName) ? value : null;
}

async function assertPersistedConfigPathBinding(teamName: string, cwd: string, includeManifestWhenAbsent = false): Promise<void> {
  const state = await readJsonFileState<TeamConfig>(absPath(cwd, TeamPaths.config(teamName)));
  if (state.kind === 'invalid') throw new Error('invalid_persisted_state');
  if (state.kind === 'value') {
    const valid = Object.hasOwn(state.value, 'state_revision')
      ? validateRevisionedTeamConfig(state.value, teamName)
      : validateLegacyTeamConfig(state.value, teamName);
    if (!valid) throw new Error('invalid_persisted_state');
    return;
  }
  if (!includeManifestWhenAbsent) return;
  const manifestState = await readJsonFileState<TeamManifestV2>(absPath(cwd, TeamPaths.manifest(teamName)));
  if (manifestState.kind === 'invalid') throw new Error('invalid_persisted_state');
  if (manifestState.kind === 'value' && !validateLegacyTeamConfig(configFromManifest(normalizeTeamManifest(manifestState.value)), teamName)) {
    throw new Error('invalid_persisted_state');
  }
}

export async function readTeamConfig(teamName: string, cwd: string): Promise<TeamConfig | null> {
  const [configState, manifestState] = await Promise.all([
    readJsonFileState<TeamConfig>(absPath(cwd, TeamPaths.config(teamName))),
    readJsonFileState<TeamManifestV2>(absPath(cwd, TeamPaths.manifest(teamName))),
  ]);
  if (configState.kind === 'invalid') throw new Error('invalid_persisted_state');
  const config = configState.kind === 'value' ? configState.value : null;
  if (config && Object.hasOwn(config, 'state_revision')) {
    const revisioned = validateRevisionedTeamConfig(config, teamName);
    if (!revisioned) throw new Error('invalid_persisted_state');
    return canonicalizeTeamConfigWorkers(revisioned);
  }
  if (config && !validateLegacyTeamConfig(config, teamName)) throw new Error('invalid_persisted_state');
  if (manifestState.kind === 'invalid') throw new Error('invalid_persisted_state');
  const manifest = manifestState.kind === 'value' ? normalizeTeamManifest(manifestState.value) : null;
  if (!config && !manifest) return null;
  if (!manifest) return config ? canonicalizeTeamConfigWorkers(config) : null;
  if (!config) return canonicalizeTeamConfigWorkers(configFromManifest(manifest));
  return canonicalizeTeamConfigWorkers({
    ...configFromManifest(manifest),
    ...config,
    workers: [...(config.workers ?? []), ...(manifest.workers ?? [])],
    worker_count: Math.max(config.worker_count ?? 0, manifest.worker_count ?? 0),
    next_task_id: Math.max(config.next_task_id ?? 1, manifest.next_task_id ?? 1),
    max_workers: Math.max(config.max_workers ?? 0, 20),
  });
}

/** Recovery readers keep revisioned config authoritative without changing legacy reads. */
export async function readRevisionedTeamConfig(teamName: string, cwd: string): Promise<{ config: TeamConfig; stateRevision: number } | null> {
  const state = await readJsonFileState<TeamConfig>(absPath(cwd, TeamPaths.config(teamName)));
  if (state.kind === 'invalid') throw new Error('invalid_persisted_state');
  if (state.kind === 'missing') return null;
  const revisioned = validateRevisionedTeamConfig(state.value, teamName);
  if (revisioned) return { config: canonicalizeTeamConfigWorkers(revisioned), stateRevision: revisioned.state_revision! };
  if (!validateLegacyTeamConfig(state.value, teamName)) throw new Error('invalid_persisted_state');
  return null;
}

/** Reject a stale recovery writer before projecting config/manifest. */
export function withTeamConfigMutationLock<T>(teamName: string, cwd: string, fn: () => Promise<T> | T): Promise<T> {
  return withProcessIdentityFileLock(absPath(cwd, TeamPaths.configMutationLock(teamName)), fn);
}

/** Establish revision authority from a locked re-read of a legacy config. */
export async function migrateTeamConfigRevision(teamName: string, cwd: string): Promise<{ config: TeamConfig; stateRevision: number } | null> {
  await assertPersistedConfigPathBinding(teamName, cwd, true);
  return withTeamConfigMutationLock(teamName, cwd, async () => {

    const configState = await readJsonFileState<TeamConfig>(absPath(cwd, TeamPaths.config(teamName)));
    if (configState.kind === 'invalid') throw new Error('invalid_persisted_state');
    let current: TeamConfig;
    if (configState.kind === 'value') {
      const legacy = validateLegacyTeamConfig(configState.value, teamName);
      if (legacy) {
        current = legacy;
      } else {
        const revisioned = validateRevisionedTeamConfig(configState.value, teamName);
        if (!revisioned) throw new Error('invalid_persisted_state');
        return { config: canonicalizeTeamConfigWorkers(revisioned), stateRevision: revisioned.state_revision! };
      }
    } else {
      const manifestState = await readJsonFileState<TeamManifestV2>(absPath(cwd, TeamPaths.manifest(teamName)));
      if (manifestState.kind === 'invalid') throw new Error('invalid_persisted_state');
      if (manifestState.kind === 'missing') return null;
      current = configFromManifest(normalizeTeamManifest(manifestState.value));
    }
    const revisioned = validateRevisionedTeamConfig(current, teamName);
    if (revisioned) return { config: canonicalizeTeamConfigWorkers(revisioned), stateRevision: revisioned.state_revision! };
    if (!validateLegacyTeamConfig(current, teamName)) throw new Error('invalid_persisted_state');
    current.state_revision = 0;
    current.lifecycle_state ??= 'active';
    if (!validateRevisionedTeamConfig(current, teamName)) throw new Error('invalid_persisted_state');
    await saveTeamConfigUnlocked(current, cwd);
    return { config: canonicalizeTeamConfigWorkers(current), stateRevision: 0 };
  });
}

export async function saveTeamConfigAtRevision(
  config: TeamConfig,
  expectedRevision: number,
  cwd: string,
  afterCommit?: () => Promise<void> | void,
): Promise<boolean> {
  if (!validateRevisionedTeamConfig(config, config.name)) throw new Error('invalid_persisted_state');
  await assertPersistedConfigPathBinding(config.name, cwd);
  return withTeamConfigMutationLock(config.name, cwd, async () => {

    const current = await readRevisionedTeamConfig(config.name, cwd);
    if (!current || current.stateRevision !== expectedRevision) return false;
    if (!validateRevisionedTeamConfig(config, config.name)) throw new Error('invalid_persisted_state');
    await saveTeamConfigUnlocked(config, cwd);
    const verified = await readRevisionedTeamConfig(config.name, cwd);
    if (verified?.stateRevision !== config.state_revision) return false;
    await afterCommit?.();
    return true;
  });
}

export async function readTeamManifest(teamName: string, cwd: string): Promise<TeamManifestV2 | null> {
  const state = await readJsonFileState<TeamManifestV2>(absPath(cwd, TeamPaths.manifest(teamName)));
  if (state.kind === 'invalid') throw new Error('invalid_persisted_state');
  return state.kind === 'value' ? normalizeTeamManifest(state.value) : null;
}

// ---------------------------------------------------------------------------
// Worker status / heartbeat readers
// ---------------------------------------------------------------------------

export async function readWorkerStatus(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<WorkerStatus> {
  const data = await readJsonSafe<WorkerStatus>(absPath(cwd, TeamPaths.workerStatus(teamName, workerName)));
  return data ?? { state: 'unknown', updated_at: '' };
}

export async function writeWorkerStatus(
  teamName: string,
  workerName: string,
  status: WorkerStatus,
  cwd: string,
): Promise<void> {
  await writeAtomic(absPath(cwd, TeamPaths.workerStatus(teamName, workerName)), JSON.stringify(status, null, 2));
}

export async function readWorkerHeartbeat(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<WorkerHeartbeat | null> {
  return readJsonSafe<WorkerHeartbeat>(absPath(cwd, TeamPaths.heartbeat(teamName, workerName)));
}

// ---------------------------------------------------------------------------
// Monitor snapshot persistence
// ---------------------------------------------------------------------------

export async function readMonitorSnapshot(
  teamName: string,
  cwd: string,
): Promise<TeamMonitorSnapshotState | null> {
  const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TeamMonitorSnapshotState>;
    if (!parsed || typeof parsed !== 'object') return null;
    const monitorTimings = (() => {
      const candidate = parsed.monitorTimings as TeamMonitorSnapshotState['monitorTimings'];
      if (!candidate || typeof candidate !== 'object') return undefined;
      if (
        typeof candidate.list_tasks_ms !== 'number' ||
        typeof candidate.worker_scan_ms !== 'number' ||
        typeof candidate.mailbox_delivery_ms !== 'number' ||
        typeof candidate.total_ms !== 'number' ||
        typeof candidate.updated_at !== 'string'
      ) {
        return undefined;
      }
      return candidate;
    })();
    return {
      taskStatusById: parsed.taskStatusById ?? {},
      workerAliveByName: parsed.workerAliveByName ?? {},
      workerLivenessByName: parsed.workerLivenessByName ?? {},
      workerStateByName: parsed.workerStateByName ?? {},
      workerTurnCountByName: parsed.workerTurnCountByName ?? {},
      workerTaskIdByName: parsed.workerTaskIdByName ?? {},
      mailboxNotifiedByMessageId: parsed.mailboxNotifiedByMessageId ?? {},
      completedEventTaskIds: parsed.completedEventTaskIds ?? {},
      monitorTimings,
    };
  } catch {
    return null;
  }
}

export async function writeMonitorSnapshot(
  teamName: string,
  snapshot: TeamMonitorSnapshotState,
  cwd: string,
): Promise<void> {
  await writeAtomic(absPath(cwd, TeamPaths.monitorSnapshot(teamName)), JSON.stringify(snapshot, null, 2));
}

// ---------------------------------------------------------------------------
// Phase state persistence
// ---------------------------------------------------------------------------

export async function readTeamPhaseState(teamName: string, cwd: string): Promise<TeamPhaseState | null> {
  const p = absPath(cwd, TeamPaths.phaseState(teamName));
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TeamPhaseState>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      current_phase: (parsed.current_phase as TeamPhase) ?? 'executing',
      max_fix_attempts: typeof parsed.max_fix_attempts === 'number' ? parsed.max_fix_attempts : 3,
      current_fix_attempt: typeof parsed.current_fix_attempt === 'number' ? parsed.current_fix_attempt : 0,
      transitions: Array.isArray(parsed.transitions) ? parsed.transitions : [],
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function writeTeamPhaseState(
  teamName: string,
  phaseState: TeamPhaseState,
  cwd: string,
): Promise<void> {
  await writeAtomic(absPath(cwd, TeamPaths.phaseState(teamName)), JSON.stringify(phaseState, null, 2));
}

// ---------------------------------------------------------------------------
// Shutdown request / ack I/O
// ---------------------------------------------------------------------------

export async function writeShutdownRequest(
  teamName: string,
  workerName: string,
  fromWorker: string,
  cwd: string,
): Promise<void> {
  const data = {
    from: fromWorker,
    requested_at: new Date().toISOString(),
  };
  await writeAtomic(absPath(cwd, TeamPaths.shutdownRequest(teamName, workerName)), JSON.stringify(data, null, 2));
}

export async function readShutdownAck(
  teamName: string,
  workerName: string,
  cwd: string,
  requestedAfter?: string,
): Promise<{ status: 'accept' | 'reject'; reason?: string; updated_at?: string } | null> {
  const ack = await readJsonSafe<{ status: 'accept' | 'reject'; reason?: string; updated_at?: string }>(
    absPath(cwd, TeamPaths.shutdownAck(teamName, workerName)),
  );
  if (!ack) return null;
  if (requestedAfter && ack.updated_at) {
    if (new Date(ack.updated_at).getTime() < new Date(requestedAfter).getTime()) {
      return null; // Stale ack from a previous request
    }
  }
  return ack;
}

// ---------------------------------------------------------------------------
// Worker identity I/O
// ---------------------------------------------------------------------------

export async function writeWorkerIdentity(
  teamName: string,
  workerName: string,
  workerInfo: WorkerInfo,
  cwd: string,
): Promise<void> {
  await writeAtomic(absPath(cwd, TeamPaths.workerIdentity(teamName, workerName)), JSON.stringify(workerInfo, null, 2));
}

// ---------------------------------------------------------------------------
// Task listing (reads task files from the tasks directory)
// ---------------------------------------------------------------------------

export async function listTasksFromFiles(
  teamName: string,
  cwd: string,
): Promise<TeamTask[]> {
  const tasksDir = absPath(cwd, TeamPaths.tasks(teamName));
  if (!existsSync(tasksDir)) return [];
  const { readdir } = await import('fs/promises');
  const entries = await readdir(tasksDir);
  const tasks: TeamTask[] = [];
  for (const entry of entries) {
    const match = /^(?:task-)?(\d+)\.json$/.exec(entry);
    if (!match) continue;
    const task = await readJsonSafe<TeamTask>(absPath(cwd, `${TeamPaths.tasks(teamName)}/${entry}`));
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => Number(a.id) - Number(b.id));
}

// ---------------------------------------------------------------------------
// Worker inbox I/O
// ---------------------------------------------------------------------------

export async function writeWorkerInbox(
  teamName: string,
  workerName: string,
  content: string,
  cwd: string,
): Promise<void> {
  await writeAtomic(absPath(cwd, TeamPaths.inbox(teamName, workerName)), content);
}

// ---------------------------------------------------------------------------
// Team summary (lightweight status for HUD/monitoring)
// ---------------------------------------------------------------------------

export async function getTeamSummary(
  teamName: string,
  cwd: string,
): Promise<TeamSummary | null> {
  const summaryStartMs = performance.now();
  const config = await readTeamConfig(teamName, cwd);
  if (!config) return null;

  const tasksStartMs = performance.now();
  const tasks = await listTasksFromFiles(teamName, cwd);
  const tasksLoadedMs = performance.now() - tasksStartMs;

  const counts = { total: tasks.length, pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 };
  for (const t of tasks) {
    if (t.status === 'pending') counts.pending++;
    else if (t.status === 'blocked') counts.blocked++;
    else if (t.status === 'in_progress') counts.in_progress++;
    else if (t.status === 'completed') counts.completed++;
    else if (t.status === 'failed') counts.failed++;
  }

  const workerSummaries: TeamSummary['workers'] = [];
  const nonReportingWorkers: string[] = [];

  const workerPollStartMs = performance.now();
  const workerSignals = await Promise.all(
    config.workers.map(async (worker) => {
      const [hb, status] = await Promise.all([
        readWorkerHeartbeat(teamName, worker.name, cwd),
        readWorkerStatus(teamName, worker.name, cwd),
      ]);
      return { worker, hb, status };
    }),
  );
  const workersPolledMs = performance.now() - workerPollStartMs;

  for (const { worker, hb, status } of workerSignals) {
    const alive = hb?.alive ?? false;
    const lastTurnAt = hb?.last_turn_at ?? null;
    const turnsWithoutProgress = 0; // Simplified; full delta tracking done in monitorTeam

    if (alive && status.state === 'working' && (hb?.turn_count ?? 0) > 5) {
      nonReportingWorkers.push(worker.name);
    }

    workerSummaries.push({
      name: worker.name,
      alive,
      lastTurnAt,
      turnsWithoutProgress,
      working_dir: worker.working_dir,
      worktree_repo_root: worker.worktree_repo_root,
      worktree_path: worker.worktree_path,
      worktree_branch: worker.worktree_branch,
      worktree_detached: worker.worktree_detached,
      worktree_created: worker.worktree_created,
      team_state_root: worker.team_state_root,
    });
  }

  const perf: TeamSummaryPerformance = {
    total_ms: Number((performance.now() - summaryStartMs).toFixed(2)),
    tasks_loaded_ms: Number(tasksLoadedMs.toFixed(2)),
    workers_polled_ms: Number(workersPolledMs.toFixed(2)),
    task_count: tasks.length,
    worker_count: config.workers.length,
  };

  return {
    teamName: config.name,
    workerCount: config.worker_count,
    team_state_root: config.team_state_root,
    workspace_mode: config.workspace_mode,
    worktree_mode: config.worktree_mode,
    tasks: counts,
    workers: workerSummaries,
    nonReportingWorkers,
    performance: perf,
  };
}

// ---------------------------------------------------------------------------
// Team config save
// ---------------------------------------------------------------------------

async function saveTeamConfigUnlocked(config: TeamConfig, cwd: string): Promise<void> {
  const manifestPath = absPath(cwd, TeamPaths.manifest(config.name));
  const manifestState = await readJsonFileState<TeamManifestV2>(manifestPath);
  if (manifestState.kind === 'invalid') throw new Error('invalid_persisted_state');
  const existingManifest = manifestState.kind === 'value' ? manifestState.value : null;
  if (existingManifest) {
    const nextManifest = normalizeTeamManifest({
      ...existingManifest,
      workers: config.workers,
      worker_count: config.worker_count,
      tmux_session: config.tmux_session,
      next_task_id: config.next_task_id,
      created_at: config.created_at,
      leader_cwd: config.leader_cwd,
      team_state_root: config.team_state_root,
      workspace_mode: config.workspace_mode,
      worktree_mode: config.worktree_mode,
      leader_pane_id: config.leader_pane_id,
      hud_pane_id: config.hud_pane_id,
      resize_hook_name: config.resize_hook_name,
      resize_hook_target: config.resize_hook_target,
      next_worker_index: config.next_worker_index,
      policy: config.policy ?? existingManifest.policy,
      governance: config.governance ?? existingManifest.governance,
      state_revision: config.state_revision,
      service_descriptor: config.service_descriptor,
    });
    // Config is authoritative. Publish its projection first so a projection
    // failure cannot leave callers uncertain whether the config commit won.
    await writeAtomic(manifestPath, JSON.stringify(nextManifest, null, 2));
  }
  await writeAtomic(absPath(cwd, TeamPaths.config(config.name)), JSON.stringify(config, null, 2));
}

export async function saveTeamConfig(config: TeamConfig, cwd: string, expectedRevision?: number): Promise<void> {
  const inputIsRevisioned = Object.hasOwn(config, 'state_revision');
  if (!(inputIsRevisioned ? validateRevisionedTeamConfig(config, config.name) : validateLegacyTeamConfig(config, config.name))) {
    throw new Error('invalid_persisted_state');
  }
  await assertPersistedConfigPathBinding(config.name, cwd);
  await withTeamConfigMutationLock(config.name, cwd, async () => {
    const currentState = await readJsonFileState<TeamConfig>(absPath(cwd, TeamPaths.config(config.name)));
    if (currentState.kind === 'invalid') throw new Error('invalid_persisted_state');
    const current = currentState.kind === 'value' ? currentState.value : null;
    if (current && Object.hasOwn(current, 'state_revision') && !validateRevisionedTeamConfig(current, config.name)) throw new Error('invalid_persisted_state');
    if (current && !Object.hasOwn(current, 'state_revision') && !validateLegacyTeamConfig(current, config.name)) throw new Error('invalid_persisted_state');
    const currentRevision = current?.state_revision;
    let nextRevision: number;
    if (typeof currentRevision === 'number' && Number.isSafeInteger(currentRevision)) {
      if (expectedRevision !== currentRevision || config.state_revision !== expectedRevision) {
        throw new Error('stale_state_revision');
      }
      nextRevision = currentRevision + 1;
    } else if (current) {
      if (expectedRevision !== undefined) throw new Error('stale_state_revision');
      nextRevision = 0;
    } else {
      nextRevision = config.state_revision ?? 0;
    }
    const committed = alignActiveFenceRevisions({ ...config, state_revision: nextRevision }, nextRevision);
    if (!validateRevisionedTeamConfig(committed, config.name)) throw new Error('invalid_persisted_state');
    await saveTeamConfigUnlocked(committed, cwd);
    Object.assign(config, committed);
  });
}

// ---------------------------------------------------------------------------
// Scaling lock (file-based mutex for scale up/down)
// ---------------------------------------------------------------------------

export async function withScalingLock<T>(
  teamName: string,
  cwd: string,
  fn: () => Promise<T>,
  timeoutMs: number = 10_000,
): Promise<T> {
  return withProcessIdentityFileLock(absPath(cwd, TeamPaths.scalingLock(teamName)), fn, timeoutMs);
}

// ---------------------------------------------------------------------------
// Snapshot diffing — derive events from two consecutive snapshots
// ---------------------------------------------------------------------------

export interface DerivedEvent {
  type: 'task_completed' | 'task_failed' | 'worker_idle' | 'worker_stopped';
  worker: string;
  task_id?: string;
  reason: string;
}

/**
 * Compare two consecutive monitor snapshots and derive events.
 * O(N) where N = max(task count, worker count).
 */
export function diffSnapshots(
  prev: TeamMonitorSnapshotState,
  current: TeamMonitorSnapshotState,
): DerivedEvent[] {
  const events: DerivedEvent[] = [];

  // Task status transitions
  for (const [taskId, currentStatus] of Object.entries(current.taskStatusById)) {
    const prevStatus = prev.taskStatusById[taskId];
    if (!prevStatus || prevStatus === currentStatus) continue;

    if (currentStatus === 'completed' && !prev.completedEventTaskIds[taskId]) {
      events.push({
        type: 'task_completed',
        worker: 'leader-fixed',
        task_id: taskId,
        reason: `status_transition:${prevStatus}->${currentStatus}`,
      });
    } else if (currentStatus === 'failed') {
      events.push({
        type: 'task_failed',
        worker: 'leader-fixed',
        task_id: taskId,
        reason: `status_transition:${prevStatus}->${currentStatus}`,
      });
    }
  }

  // Worker state transitions
  for (const [workerName, currentAlive] of Object.entries(current.workerAliveByName)) {
    const prevAlive = prev.workerAliveByName[workerName];
    const currentLiveness = current.workerLivenessByName?.[workerName] ?? (currentAlive ? 'alive' : 'dead');
    if (prevAlive === true && currentLiveness === 'dead') {
      events.push({
        type: 'worker_stopped',
        worker: workerName,
        reason: 'pane_exited',
      });
    }
  }

  for (const [workerName, currentState] of Object.entries(current.workerStateByName)) {
    const prevState = prev.workerStateByName[workerName];
    if (prevState === 'working' && currentState === 'idle') {
      events.push({
        type: 'worker_idle',
        worker: workerName,
        reason: `state_transition:${prevState}->${currentState}`,
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// State cleanup
// ---------------------------------------------------------------------------

export async function cleanupTeamState(teamName: string, cwd: string): Promise<void> {
  const root = absPath(cwd, TeamPaths.root(teamName));
  const { rm } = await import('fs/promises');
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
