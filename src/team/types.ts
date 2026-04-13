// src/team/types.ts

/**
 * MCP Team Bridge - Shared TypeScript interfaces
 *
 * All types used across the team bridge module for MCP worker orchestration.
 */

import type { TeamTaskStatus } from './contracts.js';
import type { TeamPhase } from './phase-controller.js';
import type { TeamLeaderNextAction } from './leader-nudge-guidance.js';
import type { CanonicalTeamRole, RoleAssignment } from '../shared/types.js';

/** Bridge daemon configuration — passed via --config file to bridge-entry.ts */
export interface BridgeConfig {
  teamName: string;
  workerName: string;
  provider: 'codex' | 'gemini';
  model?: string;
  workingDirectory: string;
  pollIntervalMs: number;       // default: 3000
  taskTimeoutMs: number;        // default: 600000 (10 min)
  maxConsecutiveErrors: number;  // default: 3 — self-quarantine threshold
  outboxMaxLines: number;       // default: 500 — rotation trigger
  maxRetries?: number;          // default: 5 — max task retry attempts
  permissionEnforcement?: 'off' | 'audit' | 'enforce'; // default: 'off'
  permissions?: BridgeWorkerPermissions;
}

/** Permission scoping embedded in BridgeConfig (mirrors WorkerPermissions shape) */
export interface BridgeWorkerPermissions {
  allowedPaths: string[];   // glob patterns relative to workingDirectory
  deniedPaths: string[];    // glob patterns that override allowed
  allowedCommands: string[]; // command prefixes (e.g., 'npm test', 'tsc')
  maxFileSize: number;      // max bytes per file write
}

/** Mirrors the JSON structure of {cwd}/.omc/state/team/{team}/tasks/{id}.json */
export interface TaskFile {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TeamTaskStatus;
  owner: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
  claimedBy?: string;
  claimedAt?: number;
  claimPid?: number;
}

/** Partial update for a task file (only fields being changed) */
export type TaskFileUpdate = Partial<Pick<TaskFile, 'status' | 'owner' | 'metadata' | 'claimedBy' | 'claimedAt' | 'claimPid'>>;

/** JSONL message from lead -> worker (inbox) */
export interface InboxMessage {
  type: 'message' | 'context';
  content: string;
  timestamp: string;
}

/** JSONL message from worker -> lead (outbox) */
export interface OutboxMessage {
  type: 'ready' | 'task_complete' | 'task_failed' | 'idle' | 'shutdown_ack' | 'drain_ack' | 'heartbeat' | 'error' | 'all_tasks_complete';
  taskId?: string;
  summary?: string;
  message?: string;
  error?: string;
  requestId?: string;
  timestamp: string;
}

/** Shutdown signal file content */
export interface ShutdownSignal {
  requestId: string;
  reason: string;
  timestamp: string;
}

/** Drain signal: finish current task, then shut down gracefully */
export interface DrainSignal {
  requestId: string;
  reason: string;
  timestamp: string;
}

/** MCP worker member entry for config.json or shadow registry */
export interface McpWorkerMember {
  agentId: string;          // "{workerName}@{teamName}"
  name: string;             // workerName
  agentType: string;        // "mcp-codex" | "mcp-gemini"
  model: string;
  joinedAt: number;         // Date.now()
  tmuxPaneId: string;       // tmux session name
  cwd: string;
  backendType: 'tmux';
  subscriptions: string[];
}

/** Heartbeat file content */
export interface HeartbeatData {
  workerName: string;
  teamName: string;
  provider: 'codex' | 'gemini' | 'claude';
  pid: number;
  lastPollAt: string;       // ISO timestamp of last poll cycle
  currentTaskId?: string;   // task being executed, if any
  consecutiveErrors: number;
  status: 'ready' | 'polling' | 'executing' | 'shutdown' | 'quarantined';
}

/** Offset cursor for JSONL consumption */
export interface InboxCursor {
  bytesRead: number;        // file offset in bytes
}

/** Result of config.json schema probe */
export interface ConfigProbeResult {
  probeResult: 'pass' | 'fail' | 'partial';
  probedAt: string;
  version: string;
}

/** Sidecar mapping task IDs to execution modes */
export interface TaskModeMap {
  teamName: string;
  taskModes: Record<string, 'mcp_codex' | 'mcp_gemini' | 'claude_worker'>;
}

/** Failure sidecar for a task */
export interface TaskFailureSidecar {
  taskId: string;
  lastError: string;
  retryCount: number;
  lastFailedAt: string;
}

/** Worker backend type */
export type WorkerBackend = 'claude-native' | 'mcp-codex' | 'mcp-gemini' | 'tmux-claude' | 'tmux-codex' | 'tmux-gemini';

/** Worker capability tag */
export type WorkerCapability =
  | 'code-edit'
  | 'code-review'
  | 'security-review'
  | 'architecture'
  | 'testing'
  | 'documentation'
  | 'ui-design'
  | 'refactoring'
  | 'research'
  | 'general';

// ---------------------------------------------------------------------------
// OMX-aligned types for event-driven team coordination
// ---------------------------------------------------------------------------

/** Team task with required version for optimistic concurrency */
export interface TeamTaskV2 extends TeamTask {
  version: number;
}

/** Claim metadata attached to a task */
export interface TeamTaskClaim {
  owner: string;
  token: string;
  leased_until: string;
}

/** Base team task matching OMX shape */
export interface TeamTask {
  id: string;
  subject: string;
  description: string;
  status: TeamTaskStatus;
  requires_code_change?: boolean;
  role?: string;
  owner?: string;
  result?: string;
  error?: string;
  blocked_by?: string[];
  depends_on?: string[];
  version?: number;
  claim?: TeamTaskClaim;
  created_at: string;
  completed_at?: string;
}

/** Team leader identity */
export interface TeamLeader {
  session_id: string;
  thread_id?: string;
  worker_id: string;
  role: string;
}

/** Team transport/runtime policy configuration */
export interface TeamTransportPolicy {
  display_mode: 'split_pane' | 'auto';
  worker_launch_mode: 'interactive' | 'prompt';
  dispatch_mode: 'hook_preferred_with_fallback' | 'transport_direct';
  dispatch_ack_timeout_ms: number;
}

/** Team governance controls independent from transport/runtime policy */
export interface TeamGovernance {
  delegation_only: boolean;
  plan_approval_required: boolean;
  nested_teams_allowed: boolean;
  one_team_per_leader_session: boolean;
  cleanup_requires_all_workers_inactive: boolean;
}

/** Legacy alias kept for backwards compatibility when reading old manifests */
export type TeamPolicy = TeamTransportPolicy & Partial<TeamGovernance>;

/** Permissions snapshot captured at team creation */
export interface PermissionsSnapshot {
  approval_mode: string;
  sandbox_mode: string;
  network_access: boolean;
}

/** V2 team manifest matching OMX schema */
export interface TeamManifestV2 {
  schema_version: 2;
  name: string;
  task: string;
  leader: TeamLeader;
  policy: TeamTransportPolicy;
  governance: TeamGovernance;
  permissions_snapshot: PermissionsSnapshot;
  tmux_session: string;
  worker_count: number;
  workers: WorkerInfo[];
  next_task_id: number;
  created_at: string;
  leader_cwd?: string;
  team_state_root?: string;
  workspace_mode?: 'single' | 'worktree';
  lifecycle_profile?: 'default' | 'linked_ralph';
  leader_pane_id: string | null;
  hud_pane_id: string | null;
  resize_hook_name: string | null;
  resize_hook_target: string | null;
  next_worker_index?: number;
}

/** Worker info within a team config */
export interface WorkerInfo {
  name: string;
  index: number;
  role: string;
  worker_cli?: 'codex' | 'claude' | 'gemini';
  assigned_tasks: string[];
  pid?: number;
  pane_id?: string;
  working_dir?: string;
  worktree_path?: string;
  worktree_branch?: string;
  worktree_detached?: boolean;
  team_state_root?: string;
  /**
   * Verdict-output file path for CLI-worker output contract (AC-7).
   * Set when the worker was spawned for a reviewer role on codex/gemini.
   * Consumed by the worker-completion handler in runtime-v2.
   */
  output_file?: string;
}

/** Team configuration (V1 compat) */
export interface TeamConfig {
  name: string;
  task: string;
  agent_type: string;
  worker_launch_mode: 'interactive' | 'prompt';
  policy?: TeamTransportPolicy;
  governance?: TeamGovernance;
  worker_count: number;
  max_workers: number;
  workers: WorkerInfo[];
  created_at: string;
  tmux_session: string;
  tmux_window_owned?: boolean;
  next_task_id: number;
  leader_cwd?: string;
  team_state_root?: string;
  workspace_mode?: 'single' | 'worktree';
  lifecycle_profile?: 'default' | 'linked_ralph';
  leader_pane_id: string | null;
  hud_pane_id: string | null;
  resize_hook_name: string | null;
  resize_hook_target: string | null;
  next_worker_index?: number;
  /**
   * Per-team resolved routing snapshot (Option E).
   * Populated at team creation by `buildResolvedRoutingSnapshot()`; read by
   * `scaleUp`, worker restart, and spawn paths. Immutable for the team's lifetime.
   */
  resolved_routing?: Record<CanonicalTeamRole, { primary: RoleAssignment; fallback: RoleAssignment }>;
}

/** Dispatch request kinds */
export type TeamDispatchRequestKind = 'inbox' | 'mailbox' | 'nudge';
export type TeamDispatchRequestStatus = 'pending' | 'notified' | 'delivered' | 'failed';
export type TeamDispatchTransportPreference = 'hook_preferred_with_fallback' | 'transport_direct' | 'prompt_stdin';

/** Dispatch request for worker notification */
export interface TeamDispatchRequest {
  request_id: string;
  kind: TeamDispatchRequestKind;
  team_name: string;
  to_worker: string;
  worker_index?: number;
  pane_id?: string;
  trigger_message: string;
  message_id?: string;
  inbox_correlation_key?: string;
  transport_preference: TeamDispatchTransportPreference;
  fallback_allowed: boolean;
  status: TeamDispatchRequestStatus;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  notified_at?: string;
  delivered_at?: string;
  failed_at?: string;
  last_reason?: string;
}

/** Input for creating a dispatch request */
export interface TeamDispatchRequestInput {
  kind: TeamDispatchRequestKind;
  to_worker: string;
  worker_index?: number;
  pane_id?: string;
  trigger_message: string;
  message_id?: string;
  inbox_correlation_key?: string;
  transport_preference?: TeamDispatchTransportPreference;
  fallback_allowed?: boolean;
  last_reason?: string;
}

/** Team event emitted by the event bus */
export interface TeamEvent {
  event_id: string;
  team: string;
  type:
    | 'task_completed'
    | 'task_failed'
    | 'worker_idle'
    | 'worker_stopped'
    | 'message_received'
    | 'shutdown_ack'
    | 'shutdown_gate'
    | 'shutdown_gate_forced'
    | 'approval_decision'
    | 'team_leader_nudge';
  worker: string;
  task_id?: string;
  message_id?: string | null;
  reason?: string;
  next_action?: TeamLeaderNextAction;
  message?: string;
  created_at: string;
}

/** Mailbox message between workers */
export interface TeamMailboxMessage {
  message_id: string;
  from_worker: string;
  to_worker: string;
  body: string;
  created_at: string;
  notified_at?: string;
  delivered_at?: string;
}

/** Worker's mailbox */
export interface TeamMailbox {
  worker: string;
  messages: TeamMailboxMessage[];
}

/** Approval record for a task */
export interface TaskApprovalRecord {
  task_id: string;
  required: boolean;
  status: 'pending' | 'approved' | 'rejected';
  reviewer: string;
  decision_reason: string;
  decided_at: string;
}

/** Task readiness check result */
export type TaskReadiness =
  | { ready: true }
  | { ready: false; reason: 'blocked_dependency'; dependencies: string[] };

/** Result of claiming a task */
export type ClaimTaskResult =
  | { ok: true; task: TeamTaskV2; claimToken: string }
  | { ok: false; error: 'claim_conflict' | 'blocked_dependency' | 'task_not_found' | 'already_terminal' | 'worker_not_found'; dependencies?: string[] };

/** Result of transitioning a task status */
export type TransitionTaskResult =
  | { ok: true; task: TeamTaskV2 }
  | { ok: false; error: 'claim_conflict' | 'invalid_transition' | 'task_not_found' | 'already_terminal' | 'lease_expired' };

/** Result of releasing a task claim */
export type ReleaseTaskClaimResult =
  | { ok: true; task: TeamTaskV2 }
  | { ok: false; error: 'claim_conflict' | 'task_not_found' | 'already_terminal' | 'lease_expired' };

/** Team summary for monitoring */
export interface TeamSummary {
  teamName: string;
  workerCount: number;
  tasks: {
    total: number;
    pending: number;
    blocked: number;
    in_progress: number;
    completed: number;
    failed: number;
  };
  workers: Array<{ name: string; alive: boolean; lastTurnAt: string | null; turnsWithoutProgress: number }>;
  nonReportingWorkers: string[];
  performance?: TeamSummaryPerformance;
}

/** Performance metrics for team summary */
export interface TeamSummaryPerformance {
  total_ms: number;
  tasks_loaded_ms: number;
  workers_polled_ms: number;
  task_count: number;
  worker_count: number;
}

/** Shutdown acknowledgment from a worker */
export interface ShutdownAck {
  status: 'accept' | 'reject';
  reason?: string;
  updated_at?: string;
}

/** Monitor snapshot state for delta detection */
export interface TeamMonitorSnapshotState {
  taskStatusById: Record<string, string>;
  workerAliveByName: Record<string, boolean>;
  workerStateByName: Record<string, string>;
  workerTurnCountByName: Record<string, number>;
  workerTaskIdByName: Record<string, string>;
  mailboxNotifiedByMessageId: Record<string, string>;
  completedEventTaskIds: Record<string, boolean>;
  monitorTimings?: {
    list_tasks_ms: number;
    worker_scan_ms: number;
    mailbox_delivery_ms: number;
    total_ms: number;
    updated_at: string;
  };
}

/** Phase state for team pipeline */
export interface TeamPhaseState {
  current_phase: TeamPhase;
  max_fix_attempts: number;
  current_fix_attempt: number;
  transitions: Array<{ from: string; to: string; at: string; reason?: string }>;
  updated_at: string;
}

/** Worker status for event-driven coordination */
export interface WorkerStatus {
  state: 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'draining' | 'unknown';
  current_task_id?: string;
  reason?: string;
  updated_at: string;
}

/** Worker heartbeat for liveness detection */
export interface WorkerHeartbeat {
  pid: number;
  last_turn_at: string;
  turn_count: number;
  alive: boolean;
}

export const DEFAULT_MAX_WORKERS = 20;
export const ABSOLUTE_MAX_WORKERS = 20;
