import type { CliAgentType } from './model-contract.js';
export interface TeamConfig {
    teamName: string;
    workerCount: number;
    agentTypes: CliAgentType[];
    tasks: Array<{
        subject: string;
        description: string;
    }>;
    cwd: string;
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
    config: TeamConfig;
    workerNames: string[];
    workerPaneIds: string[];
    activeWorkers: Map<string, ActiveWorkerState>;
    cwd: string;
    stopWatchdog?: () => void;
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
export interface WatchdogCompletionEvent {
    workerName: string;
    taskId: string;
    status: 'completed' | 'failed';
    summary: string;
}
export declare function allTasksTerminal(runtime: TeamRuntime): Promise<boolean>;
/**
 * Start a new team: create tmux session, spawn workers, wait for ready.
 */
export declare function startTeam(config: TeamConfig): Promise<TeamRuntime>;
/**
 * Monitor team: poll worker health, detect stalls, return snapshot.
 */
export declare function monitorTeam(teamName: string, cwd: string, workerPaneIds: string[]): Promise<TeamSnapshot>;
/**
 * Runtime-owned worker watchdog/orchestrator loop.
 * Handles done.json completion, dead pane failures, and next-task spawning.
 */
export declare function watchdogCliWorkers(runtime: TeamRuntime, intervalMs: number): () => void;
/**
 * Spawn a worker pane for an explicit task assignment.
 */
export declare function spawnWorkerForTask(runtime: TeamRuntime, workerNameValue: string, taskIndex: number): Promise<string>;
/**
 * Kill a single worker pane and update runtime state.
 */
export declare function killWorkerPane(runtime: TeamRuntime, workerNameValue: string, paneId: string): Promise<void>;
/**
 * Assign a task to a specific worker via inbox + tmux trigger.
 */
export declare function assignTask(teamName: string, taskId: string, targetWorkerName: string, paneId: string, sessionName: string, cwd: string): Promise<void>;
/**
 * Gracefully shut down all workers and clean up.
 */
export declare function shutdownTeam(teamName: string, sessionName: string, cwd: string, timeoutMs?: number, workerPaneIds?: string[], leaderPaneId?: string): Promise<void>;
/**
 * Resume an existing team from persisted state.
 * Reconstructs activeWorkers by scanning task files for in_progress tasks
 * so the watchdog loop can continue processing without stalling.
 */
export declare function resumeTeam(teamName: string, cwd: string): Promise<TeamRuntime | null>;
//# sourceMappingURL=runtime.d.ts.map