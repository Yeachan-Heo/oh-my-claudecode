/**
 * Event-driven team runtime v2 — replaces the polling watchdog from runtime.ts.
 *
 * Runtime selection:
 * - Default: v2 enabled
 * - Opt-out: set OMC_RUNTIME_V2=0|false|no|off to force legacy v1
 * NO done.json polling. Completion is detected via:
 * - CLI API lifecycle transitions (claim-task, transition-task-status)
 * - Event-driven monitor snapshots
 * - Worker heartbeat/status files
 *
 * Preserves: sentinel gate, circuit breaker, failure sidecars.
 * Removes: done.json watchdog loop, sleep-based polling.
 *
 * Architecture mirrors runtime.ts: startTeam, monitorTeam, shutdownTeam,
 * assignTask, resumeTeam as discrete operations driven by the caller.
 */
import type { TeamConfig, TeamTask, WorkerStatus, WorkerHeartbeat } from './types.js';
import type { TeamPhase } from './phase-controller.js';
export declare function isRuntimeV2Enabled(env?: NodeJS.ProcessEnv): boolean;
export interface TeamRuntimeV2 {
    teamName: string;
    sanitizedName: string;
    sessionName: string;
    config: TeamConfig;
    cwd: string;
    ownsWindow: boolean;
}
export interface TeamSnapshotV2 {
    teamName: string;
    phase: TeamPhase;
    workers: Array<{
        name: string;
        alive: boolean;
        status: WorkerStatus;
        heartbeat: WorkerHeartbeat | null;
        assignedTasks: string[];
        turnsWithoutProgress: number;
    }>;
    tasks: {
        total: number;
        pending: number;
        blocked: number;
        in_progress: number;
        completed: number;
        failed: number;
        items: TeamTask[];
    };
    allTasksTerminal: boolean;
    deadWorkers: string[];
    nonReportingWorkers: string[];
    recommendations: string[];
    performance: {
        list_tasks_ms: number;
        worker_scan_ms: number;
        total_ms: number;
        updated_at: string;
    };
}
export interface ShutdownOptionsV2 {
    force?: boolean;
    ralph?: boolean;
    timeoutMs?: number;
}
export interface StartTeamV2Config {
    teamName: string;
    workerCount: number;
    agentTypes: string[];
    tasks: Array<{
        subject: string;
        description: string;
        owner?: string;
        blocked_by?: string[];
    }>;
    cwd: string;
    newWindow?: boolean;
    roleName?: string;
    rolePrompt?: string;
}
/**
 * Start a team with the v2 event-driven runtime.
 * Creates state directories, writes config + task files, spawns workers via
 * tmux split-panes, and writes CLI API inbox instructions. NO done.json.
 * NO watchdog polling — the leader drives monitoring via monitorTeamV2().
 */
export declare function startTeamV2(config: StartTeamV2Config): Promise<TeamRuntimeV2>;
export declare function writeWatchdogFailedMarker(teamName: string, cwd: string, reason: string): Promise<void>;
/**
 * Circuit breaker context for tracking consecutive monitor failures.
 * The caller (runtime-cli v2 loop) should call recordSuccess on each
 * successful monitor cycle and recordFailure on each error. When the
 * threshold is reached, the breaker trips and writes watchdog-failed.json.
 */
export declare class CircuitBreakerV2 {
    private readonly teamName;
    private readonly cwd;
    private readonly threshold;
    private consecutiveFailures;
    private tripped;
    constructor(teamName: string, cwd: string, threshold?: number);
    recordSuccess(): void;
    recordFailure(reason: string): Promise<boolean>;
    isTripped(): boolean;
}
/**
 * Requeue tasks from dead workers by writing failure sidecars and resetting
 * task status back to pending so they can be claimed by other workers.
 */
export declare function requeueDeadWorkerTasks(teamName: string, deadWorkerNames: string[], cwd: string): Promise<string[]>;
/**
 * Take a single monitor snapshot of team state.
 * Caller drives the loop (e.g., runtime-cli poll interval or event trigger).
 */
export declare function monitorTeamV2(teamName: string, cwd: string): Promise<TeamSnapshotV2 | null>;
/**
 * Graceful team shutdown:
 * 1. Shutdown gate check (unless force)
 * 2. Send shutdown request to all workers via inbox
 * 3. Wait for ack or timeout
 * 4. Force kill remaining tmux panes
 * 5. Clean up state
 */
export declare function shutdownTeamV2(teamName: string, cwd: string, options?: ShutdownOptionsV2): Promise<void>;
export declare function resumeTeamV2(teamName: string, cwd: string): Promise<TeamRuntimeV2 | null>;
export declare function findActiveTeamsV2(cwd: string): Promise<string[]>;
//# sourceMappingURL=runtime-v2.d.ts.map