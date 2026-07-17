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
    pollIntervalMs: number;
    taskTimeoutMs: number;
    maxConsecutiveErrors: number;
    outboxMaxLines: number;
    maxRetries?: number;
    permissionEnforcement?: 'off' | 'audit' | 'enforce';
    permissions?: BridgeWorkerPermissions;
}
/** Permission scoping embedded in BridgeConfig (mirrors WorkerPermissions shape) */
export interface BridgeWorkerPermissions {
    allowedPaths: string[];
    deniedPaths: string[];
    allowedCommands: string[];
    maxFileSize: number;
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
    agentId: string;
    name: string;
    agentType: string;
    model: string;
    joinedAt: number;
    tmuxPaneId: string;
    cwd: string;
    backendType: 'tmux';
    subscriptions: string[];
}
/** Heartbeat file content */
export interface HeartbeatData {
    workerName: string;
    teamName: string;
    provider: 'codex' | 'gemini' | 'claude' | 'cursor' | 'grok' | 'antigravity';
    pid: number;
    lastPollAt: string;
    currentTaskId?: string;
    consecutiveErrors: number;
    status: 'ready' | 'polling' | 'executing' | 'shutdown' | 'quarantined';
}
/** Offset cursor for JSONL consumption */
export interface InboxCursor {
    bytesRead: number;
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
export type WorkerBackend = 'claude-native' | 'mcp-codex' | 'mcp-gemini' | 'tmux-claude' | 'tmux-codex' | 'tmux-gemini' | 'tmux-cursor' | 'tmux-grok' | 'tmux-antigravity';
/** Worker capability tag */
export type WorkerCapability = 'code-edit' | 'code-review' | 'security-review' | 'architecture' | 'testing' | 'documentation' | 'ui-design' | 'refactoring' | 'research' | 'general';
/** Team task with required version for optimistic concurrency */
export interface TeamTaskV2 extends TeamTask {
    version: number;
}
export type TeamTaskDelegationMode = 'none' | 'optional' | 'auto' | 'required';
export type TeamTaskChildModelPolicy = 'standard' | 'fast' | 'inherit' | 'frontier';
export interface TeamTaskDelegationComplianceEvidence {
    status: 'spawned' | 'skipped';
    source: 'terminal_result';
    detail: string;
    recorded_at: string;
}
export interface TeamTaskDelegationPlan {
    mode: TeamTaskDelegationMode;
    max_parallel_subtasks?: number;
    required_parallel_probe?: boolean;
    spawn_before_serial_search_threshold?: number;
    child_model_policy?: TeamTaskChildModelPolicy;
    child_model?: string;
    subtask_candidates?: string[];
    child_report_format?: 'bullets' | 'json';
    skip_allowed_reason_required?: boolean;
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
    delegation?: TeamTaskDelegationPlan;
    delegation_compliance?: TeamTaskDelegationComplianceEvidence;
    recovery_reservation?: TeamTaskRecoveryReservation;
    recovery_adoption?: TaskRecoveryAdoption;
}
/** Immutable safe-boundary continuation checkpoint, scoped to one live claim. */
export interface TaskRecoveryCheckpoint {
    schema_version: 1;
    team_name: string;
    task_id: string;
    worker_name: string;
    sequence: number;
    task_version: number;
    claim_token: string;
    resume_payload_hash: string;
    resume_payload: unknown;
    updated_at: string;
}
/** Reservation installed when a dead worker's claimed task is safely requeued. */
export interface TeamTaskRecoveryReservation {
    recovery_id: string;
    request_id: string;
    continuation_sequence: number;
    checkpoint_path: string;
    checkpoint_hash: string;
    replacement_worker: string;
    replacement_generation: number;
    adoption_token_hash: string;
    reserved_at: string;
}
/** Durable evidence that a reservation was consumed by its replacement claim. */
export interface TaskRecoveryAdoption {
    recovery_id: string;
    request_id: string;
    continuation_sequence: number;
    checkpoint_path: string;
    checkpoint_hash: string;
    replacement_worker: string;
    replacement_generation: number;
    adopted_at: string;
}
export interface TaskRecoveryRequeueSidecar {
    schema_version: 1;
    recovery_id: string;
    request_id: string;
    task_id: string;
    old_task_version: number;
    old_owner: string;
    old_claim_token: string;
    old_claim_leased_until: string;
    continuation_sequence: number;
    checkpoint_path: string;
    checkpoint_hash: string;
    replacement_worker: string;
    replacement_generation: number;
    adoption_token_hash: string;
    created_at: string;
}
export type TaskRecoveryCheckpointValidation = {
    ok: true;
    checkpoint: TaskRecoveryCheckpoint;
    path: string;
} | {
    ok: false;
    error: 'missing' | 'malformed' | 'stale' | 'ambiguous';
};
export interface TaskRecoveryAdoptionProof {
    recoveryId: string;
    requestId: string;
    replacementGeneration: number;
    adoptionToken: string;
}
export type TaskRecoveryRequeueResult = {
    ok: true;
    task: TeamTaskV2;
    reservation: TeamTaskRecoveryReservation;
    replayed: boolean;
} | {
    ok: false;
    error: 'task_not_found' | 'task_requeue_failed' | 'checkpoint_missing' | 'checkpoint_malformed' | 'checkpoint_stale' | 'checkpoint_ambiguous' | 'claim_conflict';
};
export type TaskRecoveryAdoptionResult = {
    ok: true;
    task: TeamTaskV2;
    claimToken: string;
    checkpoint: TaskRecoveryCheckpoint;
    replayed: boolean;
} | {
    ok: false;
    error: 'task_not_found' | 'claim_conflict' | 'checkpoint_missing' | 'checkpoint_malformed' | 'checkpoint_stale' | 'checkpoint_ambiguous';
};
export type RecoverDeadWorkerV2Warning = 'projection_repair_required' | 'identity_repair_required' | 'services_pending' | 'event_repair_required' | 'result_repair_required';
export type RecoverDeadWorkerV2Error = 'invalid_input' | 'team_not_found' | 'worker_not_found' | 'runtime_v2_required' | 'invalid_persisted_state' | 'runtime_owner_unavailable' | 'runtime_owner_fence_lost' | 'recovery_request_timeout' | 'recovery_attempt_conflict' | 'team_mutation_busy' | 'team_mutation_resume_required' | 'team_shutting_down' | 'team_session_dead' | 'worker_liveness_unknown' | 'recovery_checkpoint_missing' | 'recovery_checkpoint_malformed' | 'recovery_checkpoint_ambiguous' | 'recovery_checkpoint_stale' | 'task_requeue_failed' | 'launch_metadata_incomplete' | 'launch_descriptor_unresolvable' | 'spawn_failed' | 'startup_ack_timeout' | 'worker_activation_failed' | 'auto_merge_unavailable' | 'stale_state_revision' | 'config_commit_failed';
export interface RecoverDeadWorkerV2OutcomeBase {
    requestId: string;
    recoveryId: string;
    teamName: string;
    workerName: string;
    committed: boolean;
    updatedAt: string;
}
export interface RecoverDeadWorkerV2Success extends RecoverDeadWorkerV2OutcomeBase {
    outcome: 'recovered' | 'already_running';
    committed: true;
    oldPaneId: string | null;
    newPaneId: string;
    requeuedTaskIds: string[];
    continuationSequenceByTask: Record<string, number>;
    stateRevision: number;
    activation: 'active' | 'services_pending';
    manifestSync: 'synced' | 'repair_required';
    servicesSync: 'synced' | 'repair_required';
    warnings: RecoverDeadWorkerV2Warning[];
}
export interface RecoverDeadWorkerV2Failure extends RecoverDeadWorkerV2OutcomeBase {
    outcome: 'failed' | 'commit_unknown';
    committed: false;
    error: RecoverDeadWorkerV2Error;
    message?: string;
    reservationsWritten?: boolean;
}
export type RecoverDeadWorkerV2Result = RecoverDeadWorkerV2Success | RecoverDeadWorkerV2Failure;
export interface TeamRuntimeOwnerEpoch {
    epoch: number;
    nonce: string;
    pid: number;
    process_started_at: string;
    created_at: string;
}
/** Durable lifecycle fence for a scale-up operation. */
export interface TeamScaleUpAttempt {
    operation_id: string;
    phase: 'reserved' | 'effects' | 'failed';
    pid: number;
    process_started_at: string;
    state_revision: number;
    created_at: string;
    updated_at: string;
    failure_reason?: string;
}
export interface TeamRecoveryAttempt {
    request_id: string;
    recovery_id: string;
    worker_name: string;
    owner_epoch: number;
    owner_nonce: string;
    phase: 'reserved' | 'requeued' | 'ready' | 'active' | 'services_pending' | 'adopted' | 'failed';
    /** Pane identity of the worker before a recovery replaces its config row. */
    original_pane_id?: string;
    state_revision: number;
    created_at: string;
    updated_at: string;
}
export interface WorkerLaunchDescriptor {
    schema_version: 1;
    provider: 'claude' | 'codex' | 'gemini' | 'cursor' | 'grok' | 'antigravity';
    model: string | null;
    binary: string;
    args: string[];
}
export type TeamCadencePolicy = 'disabled' | 'worker-auto-commit-v1';
export interface TeamServiceDescriptor {
    schema_version: 1;
    service_generation: number;
    service_attempt_id: string;
    auto_merge_enabled: boolean;
    workspace_root: string;
    leader_branch?: string;
    cadence_policy: TeamCadencePolicy;
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
    state_revision?: number;
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
    worktree_mode?: 'disabled' | 'detached' | 'named';
    lifecycle_profile?: 'default' | 'linked_ralph';
    leader_pane_id: string | null;
    hud_pane_id: string | null;
    resize_hook_name: string | null;
    resize_hook_target: string | null;
    next_worker_index?: number;
    service_descriptor?: TeamServiceDescriptor;
}
/** Worker info within a team config */
export interface WorkerInfo {
    name: string;
    index: number;
    role: string;
    worker_cli?: 'codex' | 'claude' | 'gemini' | 'cursor' | 'grok' | 'antigravity';
    assigned_tasks: string[];
    pid?: number;
    pane_id?: string;
    working_dir?: string;
    worktree_repo_root?: string;
    worktree_path?: string;
    worktree_branch?: string;
    worktree_detached?: boolean;
    worktree_created?: boolean;
    team_state_root?: string;
    /**
     * Verdict-output file path for CLI-worker output contract (AC-7).
     * Set when the worker was spawned for a reviewer role on codex/gemini/grok.
     * Consumed by the worker-completion handler in runtime-v2.
     */
    output_file?: string;
    recovery_id?: string;
    replacement_generation?: number;
    pane_attempt_id?: string;
    operational_state?: 'starting' | 'active' | 'dead' | 'stopped';
    launch_descriptor?: WorkerLaunchDescriptor;
}
export interface TeamScaleDownAttempt {
    operation_id: string;
    phase: 'draining' | 'effects' | 'failed';
    pid: number;
    process_started_at: string;
    workers: Array<{
        name: string;
        pane_id?: string;
        worktree_path?: string;
        worktree_created?: boolean;
    }>;
    state_revision: number;
    created_at: string;
    updated_at: string;
    failure_reason?: string;
}
export interface TeamShutdownAttempt {
    nonce: string;
    pid: number;
    process_started_at: string;
    state_revision: number;
    created_at: string;
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
    worktree_mode?: 'disabled' | 'detached' | 'named';
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
    resolved_routing?: Record<CanonicalTeamRole, {
        primary: RoleAssignment;
        fallback: RoleAssignment;
    }>;
    state_revision?: number;
    runtime_owner_epoch?: TeamRuntimeOwnerEpoch;
    active_recovery?: TeamRecoveryAttempt;
    active_scale_down?: TeamScaleDownAttempt;
    active_scale_up?: TeamScaleUpAttempt;
    last_recovery?: TeamRecoveryAttempt;
    all_dead_recovery?: {
        detected_at: string;
        deadline_at: string;
        state_revision: number;
    };
    service_descriptor?: TeamServiceDescriptor;
    lifecycle_state?: 'active' | 'shutting_down' | 'stopped';
    shutdown_attempt?: TeamShutdownAttempt;
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
    type: 'task_completed' | 'task_failed' | 'worker_idle' | 'worker_stopped' | 'message_received' | 'shutdown_ack' | 'shutdown_gate' | 'shutdown_gate_forced' | 'approval_decision' | 'team_leader_nudge';
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
export type TaskReadiness = {
    ready: true;
} | {
    ready: false;
    reason: 'blocked_dependency';
    dependencies: string[];
};
/** Result of claiming a task */
export type ClaimTaskResult = {
    ok: true;
    task: TeamTaskV2;
    claimToken: string;
} | {
    ok: false;
    error: 'claim_conflict' | 'blocked_dependency' | 'task_not_found' | 'already_terminal' | 'worker_not_found';
    dependencies?: string[];
};
/** Result of transitioning a task status */
export type TransitionTaskResult = {
    ok: true;
    task: TeamTaskV2;
} | {
    ok: false;
    error: 'claim_conflict' | 'invalid_transition' | 'task_not_found' | 'already_terminal' | 'lease_expired' | 'missing_delegation_compliance_evidence';
};
/** Result of releasing a task claim */
export type ReleaseTaskClaimResult = {
    ok: true;
    task: TeamTaskV2;
} | {
    ok: false;
    error: 'claim_conflict' | 'task_not_found' | 'already_terminal' | 'lease_expired';
};
/** Team summary for monitoring */
export interface TeamSummary {
    teamName: string;
    workerCount: number;
    team_state_root?: string;
    workspace_mode?: 'single' | 'worktree';
    worktree_mode?: 'disabled' | 'detached' | 'named';
    tasks: {
        total: number;
        pending: number;
        blocked: number;
        in_progress: number;
        completed: number;
        failed: number;
    };
    workers: Array<{
        name: string;
        alive: boolean;
        lastTurnAt: string | null;
        turnsWithoutProgress: number;
        working_dir?: string;
        worktree_repo_root?: string;
        worktree_path?: string;
        worktree_branch?: string;
        worktree_detached?: boolean;
        worktree_created?: boolean;
        team_state_root?: string;
    }>;
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
    workerLivenessByName?: Record<string, 'alive' | 'dead' | 'unknown'>;
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
    transitions: Array<{
        from: string;
        to: string;
        at: string;
        reason?: string;
    }>;
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
export declare const DEFAULT_MAX_WORKERS = 20;
export declare const ABSOLUTE_MAX_WORKERS = 20;
//# sourceMappingURL=types.d.ts.map