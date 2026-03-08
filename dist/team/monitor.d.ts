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
export declare function readTeamConfig(teamName: string, cwd: string): Promise<TeamConfig | null>;
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
export declare function saveTeamConfig(config: TeamConfig, cwd: string): Promise<void>;
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
export declare function cleanupTeamState(teamName: string, cwd: string): Promise<void>;
//# sourceMappingURL=monitor.d.ts.map