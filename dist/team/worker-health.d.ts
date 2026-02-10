/**
 * Worker health dashboard utility.
 * Aggregates heartbeat, tmux session, task history, and audit log data
 * to provide a comprehensive health report for each worker.
 */
import type { HeartbeatData } from './types.js';
export interface WorkerHealthReport {
    workerName: string;
    isAlive: boolean;
    tmuxSessionAlive: boolean;
    heartbeatAge: number | null;
    status: HeartbeatData['status'] | 'dead' | 'unknown';
    consecutiveErrors: number;
    currentTaskId: string | null;
    totalTasksCompleted: number;
    totalTasksFailed: number;
    uptimeMs: number | null;
}
/**
 * Generate health report for all workers in a team.
 * Combines: heartbeat freshness, tmux session check, task history, audit log.
 */
export declare function getWorkerHealthReports(teamName: string, workingDirectory: string, heartbeatMaxAgeMs?: number): WorkerHealthReport[];
/**
 * Check if a specific worker needs intervention.
 * Returns reason string if intervention needed, null otherwise.
 */
export declare function checkWorkerHealth(teamName: string, workerName: string, workingDirectory: string, heartbeatMaxAgeMs?: number): string | null;
//# sourceMappingURL=worker-health.d.ts.map