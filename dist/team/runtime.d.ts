import type { CliAgentType } from './model-contract.js';
import { type WorkerPaneOwnership } from './tmux-session.js';
import { type TeamInstanceId, type TmuxServerIdentity } from './types.js';
export interface TeamConfig {
    teamName: string;
    instance_id?: TeamInstanceId;
    workerCount: number;
    agentTypes: CliAgentType[];
    tasks: Array<{
        subject: string;
        description: string;
    }>;
    cwd: string;
    newWindow?: boolean;
    tmuxSession?: string;
    leaderPaneId?: string;
    tmuxOwnsWindow?: boolean;
    tmuxServerIdentity?: TmuxServerIdentity;
    workerNames?: string[];
    workerPaneIds?: string[];
    workerPaneByName?: Record<string, string>;
}
export interface ActiveWorkerState {
    paneId: string;
    taskId: string;
    spawnedAt: number;
}
export interface TeamRuntime {
    teamName: string;
    sessionName: string;
    leaderPaneId: string;
    ownsWindow?: boolean;
    config: TeamConfig;
    workerNames: string[];
    workerPaneIds: string[];
    activeWorkers: Map<string, ActiveWorkerState>;
    cwd: string;
    instanceId?: TeamInstanceId;
    tmuxServerIdentity?: TmuxServerIdentity;
    workerPaneOwnership?: Map<string, WorkerPaneOwnership>;
    workerPaneByName?: Map<string, string>;
}
export interface WorkerStatus {
    workerName: string;
    alive: boolean;
    paneId: string;
    currentTaskId?: string;
    lastHeartbeat?: string;
    stalled: boolean;
}
export interface TeamSnapshot {
    teamName: string;
    phase: string;
    workers: WorkerStatus[];
    taskCounts: {
        pending: number;
        inProgress: number;
        completed: number;
        failed: number;
    };
    deadWorkers: string[];
    monitorPerformance: {
        listTasksMs: number;
        workerScanMs: number;
        totalMs: number;
    };
}
/**
 * Reject unsupported legacy startup before any effects.
 */
export declare function startTeam(_config: TeamConfig): Promise<TeamRuntime>;
/**
 * Monitor team: poll worker health, detect stalls, return snapshot.
 */
export declare function monitorTeam(teamName: string, cwd: string, workerPaneIds: string[]): Promise<TeamSnapshot>;
/**
 * Gracefully shut down all workers and clean up.
 *
 * The legacy runtime is intentionally destructive only when the caller
 * supplies an instance identity backed by the durable reservation protocol.
 * Omitting the identity preserves state rather than falling back to names or
 * pane IDs.
 */
export declare function shutdownTeam(teamName: string, sessionName: string, cwd: string, timeoutMs?: number, workerPaneIds?: string[], leaderPaneId?: string, ownsWindow?: boolean, instanceId?: TeamInstanceId): Promise<boolean>;
/**
 * Resume an existing team from persisted state.
 * Reconstructs activeWorkers by scanning task files for in_progress tasks
 * for read-only status consumers. No legacy mutation loop is resumed.
 */
export declare function resumeTeam(teamName: string, cwd: string): Promise<TeamRuntime | null>;
//# sourceMappingURL=runtime.d.ts.map