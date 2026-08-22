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
import type { TeamConfig, TeamManifestV2, TeamMonitorSnapshotState, TeamPhaseState, WorkerStatus, WorkerHeartbeat, WorkerInfo, TeamTask, TeamSummary } from './types.js';
export declare function isValidPersistedMaxWorkers(value: unknown): value is number | undefined;
export declare function alignActiveFenceRevisions(config: TeamConfig, revision: number): TeamConfig;
/** Accept only a complete revisioned authoritative config; return null for malformed values. */
export declare function validateRevisionedTeamConfig(value: unknown, expectedTeamName?: string): TeamConfig | null;
/** Legacy configs predate revision authority and require the complete historical core shape. */
export declare function validateLegacyTeamConfig(value: unknown, expectedTeamName?: string): TeamConfig | null;
export declare function readTeamConfig(teamName: string, cwd: string): Promise<TeamConfig | null>;
/** Recovery readers keep revisioned config authoritative without changing legacy reads. */
export declare function readRevisionedTeamConfig(teamName: string, cwd: string): Promise<{
    config: TeamConfig;
    stateRevision: number;
} | null>;
/** Reject a stale recovery writer before projecting config/manifest. */
export declare function withTeamConfigMutationLock<T>(teamName: string, cwd: string, fn: () => Promise<T> | T): Promise<T>;
/** Establish revision authority from a locked re-read of a legacy config. */
export declare function migrateTeamConfigRevision(teamName: string, cwd: string): Promise<{
    config: TeamConfig;
    stateRevision: number;
} | null>;
/** Fence families protected by the CAS ownership trust boundary. */
export type ActiveFenceFamily = 'active_scale_up' | 'active_scale_down' | 'active_recovery' | 'shutdown_attempt' | 'all_dead_recovery';
export type FenceReclaimAuthorization = Partial<Record<ActiveFenceFamily, true>>;
export interface SaveTeamConfigAtRevisionOptions {
    /**
     * Authorizes foreign-owner replacement for specific fence families after the
     * caller has verified reclaim eligibility (e.g. dead owner). Without this,
     * only same-owner phase transitions / revision rebases are permitted.
     */
    reclaim?: FenceReclaimAuthorization;
    /**
     * Authorizes clearing a fence. Release is never implied by numeric revision CAS alone.
     */
    release?: FenceReclaimAuthorization;
}
/**
 * Trust boundary: a proposed config may only retain/replace active fences when
 * ownership identity matches the authoritative fence and the phase transition is
 * allowed, or when an explicit reclaim/release authorization is supplied.
 * Revision rebasing alone must never launder foreign ownership.
 */
export declare function assertActiveFenceOwnershipTransition(current: TeamConfig, proposed: TeamConfig, options?: SaveTeamConfigAtRevisionOptions): void;
export declare function saveTeamConfigAtRevision(config: TeamConfig, expectedRevision: number, cwd: string, afterCommit?: () => Promise<void> | void, options?: SaveTeamConfigAtRevisionOptions): Promise<boolean>;
export declare function readTeamManifest(teamName: string, cwd: string): Promise<TeamManifestV2 | null>;
export declare function readWorkerStatus(teamName: string, workerName: string, cwd: string): Promise<WorkerStatus>;
export declare function writeWorkerStatus(teamName: string, workerName: string, status: WorkerStatus, cwd: string): Promise<void>;
export declare function readWorkerHeartbeat(teamName: string, workerName: string, cwd: string): Promise<WorkerHeartbeat | null>;
export declare function readMonitorSnapshot(teamName: string, cwd: string): Promise<TeamMonitorSnapshotState | null>;
export declare function writeMonitorSnapshot(teamName: string, snapshot: TeamMonitorSnapshotState, cwd: string): Promise<void>;
export declare function readTeamPhaseState(teamName: string, cwd: string): Promise<TeamPhaseState | null>;
export declare function writeTeamPhaseState(teamName: string, phaseState: TeamPhaseState, cwd: string): Promise<void>;
export declare function writeShutdownRequest(teamName: string, workerName: string, fromWorker: string, cwd: string): Promise<void>;
export declare function readShutdownAck(teamName: string, workerName: string, cwd: string, requestedAfter?: string): Promise<{
    status: 'accept' | 'reject';
    reason?: string;
    updated_at?: string;
} | null>;
export declare function writeWorkerIdentity(teamName: string, workerName: string, workerInfo: WorkerInfo, cwd: string): Promise<void>;
export declare function listTasksFromFiles(teamName: string, cwd: string): Promise<TeamTask[]>;
export declare function writeWorkerInbox(teamName: string, workerName: string, content: string, cwd: string): Promise<void>;
export declare function getTeamSummary(teamName: string, cwd: string): Promise<TeamSummary | null>;
export declare function saveTeamConfig(config: TeamConfig, cwd: string, expectedRevision?: number): Promise<void>;
export declare function withScalingLock<T>(teamName: string, cwd: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
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
export declare function diffSnapshots(prev: TeamMonitorSnapshotState, current: TeamMonitorSnapshotState): DerivedEvent[];
export declare function cleanupTeamState(teamName: string, cwd: string): Promise<boolean>;
//# sourceMappingURL=monitor.d.ts.map