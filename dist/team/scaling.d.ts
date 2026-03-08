/**
 * Dynamic worker scaling for team mode — Phase 1: Manual Scaling.
 *
 * Provides scale_up (add workers mid-session) and scale_down (drain + remove idle workers).
 * Gated behind the OMC_TEAM_SCALING_ENABLED environment variable.
 *
 * Key design decisions:
 * - Monotonic worker index counter (next_worker_index in config) ensures unique names
 * - File-based scaling lock prevents concurrent scale operations
 * - 'draining' worker status for graceful transitions during scale_down
 */
import { type WorkerInfo } from './team-ops.js';
export declare function isScalingEnabled(env?: NodeJS.ProcessEnv): boolean;
export interface ScaleUpResult {
    ok: true;
    addedWorkers: WorkerInfo[];
    newWorkerCount: number;
    nextWorkerIndex: number;
}
export interface ScaleDownResult {
    ok: true;
    removedWorkers: string[];
    newWorkerCount: number;
}
export interface ScaleError {
    ok: false;
    error: string;
}
/**
 * Add workers to a running team mid-session.
 *
 * Acquires the file-based scaling lock, reads the current config,
 * validates capacity, creates new tmux panes, and bootstraps workers.
 */
export declare function scaleUp(teamName: string, count: number, agentType: string, tasks: Array<{
    subject: string;
    description: string;
    owner?: string;
    blocked_by?: string[];
    role?: string;
}>, cwd: string, env?: NodeJS.ProcessEnv): Promise<ScaleUpResult | ScaleError>;
export interface ScaleDownOptions {
    /** Worker names to remove. If empty, removes idle workers up to `count`. */
    workerNames?: string[];
    /** Number of idle workers to remove (used when workerNames is not specified). */
    count?: number;
    /** Force kill without waiting for drain. Default: false. */
    force?: boolean;
    /** Drain timeout in milliseconds. Default: 30000. */
    drainTimeoutMs?: number;
}
/**
 * Remove workers from a running team.
 *
 * Sets targeted workers to 'draining' status, waits for them to finish
 * current work (or force kills), then removes tmux panes and updates config.
 */
export declare function scaleDown(teamName: string, cwd: string, options?: ScaleDownOptions, env?: NodeJS.ProcessEnv): Promise<ScaleDownResult | ScaleError>;
//# sourceMappingURL=scaling.d.ts.map