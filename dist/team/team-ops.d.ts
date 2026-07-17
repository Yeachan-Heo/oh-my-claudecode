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
import type { TeamTaskStatus } from './contracts.js';
import type { TeamTask, TeamTaskV2, TeamTaskClaim, TeamConfig, TeamManifestV2, WorkerInfo, WorkerStatus, WorkerHeartbeat, TeamEvent, TeamMailboxMessage, TeamMailbox, TaskApprovalRecord, ClaimTaskResult, TransitionTaskResult, ReleaseTaskClaimResult, TaskReadiness, TeamSummary, ShutdownAck, TeamMonitorSnapshotState, TaskRecoveryAdoptionProof, TaskRecoveryAdoptionResult, TaskRecoveryCheckpoint, TaskRecoveryRequeueResult, TaskRecoveryRequeueSidecar, TaskRecoveryCheckpointValidation, TeamTaskRecoveryReservation, RecoverDeadWorkerV2Error, RecoverDeadWorkerV2Result, RecoverDeadWorkerV2Warning } from './types.js';
import { type PublishTaskRecoveryCheckpointInput } from './task-recovery-checkpoint.js';
export type { TeamConfig, WorkerInfo, WorkerHeartbeat, WorkerStatus, TeamTask, TeamTaskV2, TeamTaskClaim, TeamManifestV2, TeamEvent, TeamMailboxMessage, TeamMailbox, TaskApprovalRecord, ClaimTaskResult, TransitionTaskResult, ReleaseTaskClaimResult, TaskReadiness, TeamSummary, ShutdownAck, TeamMonitorSnapshotState, TaskRecoveryAdoptionProof, TaskRecoveryAdoptionResult, TaskRecoveryCheckpoint, TaskRecoveryRequeueResult, TaskRecoveryRequeueSidecar, TaskRecoveryCheckpointValidation, TeamTaskRecoveryReservation, RecoverDeadWorkerV2Error, RecoverDeadWorkerV2Result, RecoverDeadWorkerV2Warning, };
export type { PublishTaskRecoveryCheckpointInput } from './task-recovery-checkpoint.js';
/**
 * Result of an exact lookup in the canonical mailbox JSON file. This is a
 * guard-only reader and intentionally never falls back to legacy JSONL.
 */
export type StrictCanonicalMailboxMessageReadResult = {
    kind: 'valid';
    message: TeamMailboxMessage;
} | {
    kind: 'store_missing';
} | {
    kind: 'malformed_store';
    cause: 'json' | 'non_object' | 'messages_non_array';
} | {
    kind: 'wrong_owner';
} | {
    kind: 'malformed_message';
    messageIndex: number;
    field: string;
} | {
    kind: 'message_missing';
} | {
    kind: 'duplicate_message_id';
    messageId: string;
    messageIndexes: number[];
} | {
    kind: 'recipient_mismatch';
    messageIndex: number;
} | {
    kind: 'replay_suppressed';
    message: TeamMailboxMessage;
    marker: 'notified_at' | 'delivered_at';
};
declare function writeAtomic(path: string, data: string): Promise<void>;
export declare function withTaskClaimLock<T>(teamName: string, taskId: string, cwd: string, fn: () => Promise<T>): Promise<{
    ok: true;
    value: T;
} | {
    ok: false;
}>;
export declare function teamReadConfig(teamName: string, cwd: string): Promise<TeamConfig | null>;
export declare function teamReadManifest(teamName: string, cwd: string): Promise<TeamManifestV2 | null>;
export declare function teamCleanup(teamName: string, cwd: string): Promise<void>;
export declare function teamWriteWorkerIdentity(teamName: string, workerName: string, identity: WorkerInfo, cwd: string): Promise<void>;
export declare function teamReadWorkerHeartbeat(teamName: string, workerName: string, cwd: string): Promise<WorkerHeartbeat | null>;
export declare function teamUpdateWorkerHeartbeat(teamName: string, workerName: string, heartbeat: WorkerHeartbeat, cwd: string): Promise<void>;
export declare function teamReadWorkerStatus(teamName: string, workerName: string, cwd: string): Promise<WorkerStatus>;
export declare function teamWriteWorkerInbox(teamName: string, workerName: string, prompt: string, cwd: string): Promise<void>;
export declare function teamCreateTask(teamName: string, task: Omit<TeamTask, 'id' | 'created_at'>, cwd: string): Promise<TeamTaskV2>;
export declare function teamReadTask(teamName: string, taskId: string, cwd: string): Promise<TeamTask | null>;
export declare function teamListTasks(teamName: string, cwd: string): Promise<TeamTask[]>;
export declare function teamUpdateTask(teamName: string, taskId: string, updates: Record<string, unknown>, cwd: string): Promise<TeamTask | null>;
export declare function teamClaimTask(teamName: string, taskId: string, workerName: string, expectedVersion: number | null, cwd: string): Promise<ClaimTaskResult>;
export declare function teamTransitionTaskStatus(teamName: string, taskId: string, from: TeamTaskStatus, to: TeamTaskStatus, claimToken: string, cwd: string, terminalData?: {
    result?: string;
    error?: string;
}): Promise<TransitionTaskResult>;
export declare function teamReleaseTaskClaim(teamName: string, taskId: string, claimToken: string, workerName: string, cwd: string): Promise<ReleaseTaskClaimResult>;
export declare function teamPublishTaskRecoveryCheckpoint(input: PublishTaskRecoveryCheckpointInput, cwd: string): Promise<import("./task-recovery-checkpoint.js").PublishTaskRecoveryCheckpointResult>;
export declare function teamRequeueRecoveredTask(teamName: string, cwd: string, input: {
    recoveryId: string;
    requestId: string;
    taskId: string;
    replacementWorker: string;
    replacementGeneration: number;
    adoptionTokenHash: string;
}): Promise<TaskRecoveryRequeueResult>;
/** Runtime-owner-only continuation adoption; call before provider launch. */
export declare function teamAdoptRecoveryReservations(teamName: string, cwd: string, taskIds: string[], workerName: string, proof: TaskRecoveryAdoptionProof): Promise<TaskRecoveryAdoptionResult[]>;
/**
 * Reads one exact message from the canonical JSON mailbox without using the
 * compatibility JSONL fallback. It validates every canonical record first so
 * a corrupt or ambiguous mailbox cannot authorize a pane notification.
 */
export declare function teamReadCanonicalMailboxMessageStrict(teamName: string, workerName: string, messageId: string, cwd: string): Promise<StrictCanonicalMailboxMessageReadResult>;
export declare function teamSendMessage(teamName: string, fromWorker: string, toWorker: string, body: string, cwd: string): Promise<TeamMailboxMessage>;
export declare function teamBroadcast(teamName: string, fromWorker: string, body: string, cwd: string): Promise<TeamMailboxMessage[]>;
export declare function teamListMailbox(teamName: string, workerName: string, cwd: string): Promise<TeamMailboxMessage[]>;
export declare function teamMarkMessageDelivered(teamName: string, workerName: string, messageId: string, cwd: string): Promise<boolean>;
export declare function teamMarkMessageNotified(teamName: string, workerName: string, messageId: string, cwd: string): Promise<boolean>;
export declare function teamAppendEvent(teamName: string, event: Omit<TeamEvent, 'event_id' | 'created_at' | 'team'>, cwd: string): Promise<TeamEvent>;
export declare function teamReadTaskApproval(teamName: string, taskId: string, cwd: string): Promise<TaskApprovalRecord | null>;
export declare function teamWriteTaskApproval(teamName: string, approval: TaskApprovalRecord, cwd: string): Promise<void>;
export declare function teamGetSummary(teamName: string, cwd: string): Promise<TeamSummary | null>;
export declare function teamWriteShutdownRequest(teamName: string, workerName: string, requestedBy: string, cwd: string): Promise<void>;
export declare function teamReadShutdownAck(teamName: string, workerName: string, cwd: string, minUpdatedAt?: string): Promise<ShutdownAck | null>;
export declare function teamReadMonitorSnapshot(teamName: string, cwd: string): Promise<TeamMonitorSnapshotState | null>;
export declare function teamWriteMonitorSnapshot(teamName: string, snapshot: TeamMonitorSnapshotState, cwd: string): Promise<void>;
export { writeAtomic };
//# sourceMappingURL=team-ops.d.ts.map