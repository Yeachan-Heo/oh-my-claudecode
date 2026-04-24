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
import type { PluginConfig } from '../shared/types.js';
import { type CliWorkerOutputPayload } from './cli-worker-contract.js';
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
        working_dir?: string;
        worktree_repo_root?: string;
        worktree_path?: string;
        worktree_branch?: string;
        worktree_detached?: boolean;
        worktree_created?: boolean;
        team_state_root?: string;
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
        role?: string;
    }>;
    cwd: string;
    newWindow?: boolean;
    workerRoles?: string[];
    roleName?: string;
    rolePrompt?: string;
    /**
     * Optional pre-loaded plugin config. When omitted, `loadConfig()` is called
     * at startup. Exposed so callers (tests, bridges) can inject a config.
     * The resolved routing snapshot derived from this config is persisted to
     * `TeamConfig.resolved_routing` and is IMMUTABLE for the team's lifetime —
     * subsequent edits to the on-disk config do NOT affect an already-started
     * team (stickiness guarantee per plan AC-10 / R11).
     */
    pluginConfig?: PluginConfig;
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
export type CliWorkerVerdictStatus = 'completed' | 'failed' | 'file_missing' | 'parse_failed' | 'no_in_progress_task' | 'already_terminal' | 'skipped';
export interface CliWorkerVerdictResult {
    workerName: string;
    taskId: string | null;
    status: CliWorkerVerdictStatus;
    verdict?: CliWorkerOutputPayload['verdict'];
    reason?: string;
}
/**
 * Post-exit handler for CLI workers that emitted a structured verdict
 * (AC-7). Scans workers whose panes have exited and whose WorkerInfo
 * carries `output_file`. For each:
 *   - Reads + validates the JSON payload via `parseCliWorkerVerdict`.
 *   - Locates the worker's in_progress task and writes a terminal status
 *     (completed for `approve`, failed for `revise`/`reject`) plus verdict
 *     metadata directly to the task file — the worker process is gone and
 *     cannot re-enter `transitionTaskStatus` with its claim token.
 *   - Renames `verdict.json` to `verdict.processed.json` so a subsequent
 *     monitor cycle does not reprocess it.
 *   - Emits a team event describing the outcome.
 * On parse failure, emits a warning event and leaves the task untouched
 * for human review (per plan AC-7).
 */
export declare function processCliWorkerVerdicts(teamName: string, cwd: string): Promise<CliWorkerVerdictResult[]>;
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