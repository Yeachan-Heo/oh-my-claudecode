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
import type { TeamConfig, TeamManifestV2, TeamTask, TeamTaskDelegationPlan, WorkerInfo, WorkerStatus, WorkerHeartbeat } from './types.js';
import type { TeamPhase } from './phase-controller.js';
import type { CliAgentType } from './model-contract.js';
import { type WorkerPaneLiveness } from './tmux-session.js';
import type { CanonicalTeamRole, PluginConfig, RoleAssignment, TeamRoleAssignmentSpec } from '../shared/types.js';
import { type CliWorkerOutputPayload } from './cli-worker-contract.js';
import { type RecoveryDurableOutcome } from './recovery-request-store.js';
import { type RecoverDeadWorkerOwnerInput } from './runtime-owner-client.js';
import type { RecoverDeadWorkerV2Result } from './types.js';
export interface RecoverDeadWorkerV2Options {
    workerName: string;
    requestId?: string;
    timeoutMs?: number;
}
export interface RuntimeOwnerRecoveryClient {
    requestRuntimeOwnerRecovery(input: {
        requestId: string;
        cwd: string;
        teamName: string;
        workerName: string;
        timeoutMs?: number;
    }): Promise<RecoverDeadWorkerV2Result>;
}
/** Runtime integration point; production may bind its owner client after startup. */
export declare function setRuntimeOwnerRecoveryClient(client: RuntimeOwnerRecoveryClient | undefined): void;
/** Queue recovery with the runtime owner; this process never runs the owner saga. */
export declare function recoverDeadWorkerV2(teamName: string, cwd: string, { workerName, requestId, timeoutMs }: RecoverDeadWorkerV2Options): Promise<RecoverDeadWorkerV2Result>;
/** Reads only the canonical durable terminal result for a request. */
export declare function readRecoverDeadWorkerV2Result(requestId: string, cwd?: string): Promise<RecoverDeadWorkerV2Result | null>;
/** Compatibility/internal reader that may return an in-progress durable outcome. */
export declare function readRecoverDeadWorkerV2Outcome(cwd: string, requestId: string): RecoveryDurableOutcome | null;
export declare function reconcileCommittedTeamServices(config: TeamConfig, cwd: string): Promise<'synced' | 'repair_required'>;
export { isRuntimeV2Enabled } from './runtime-flags.js';
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
        liveness: WorkerPaneLiveness;
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
/**
 * Resolve a per-task routing assignment from the team's routing snapshot.
 *
 * Resolution order:
 *   1. Explicit `task.role` (if present) → normalize alias → snapshot lookup.
 *   2. `routeTaskToRole(subject, description, fallbackRole)` intent inference.
 *   3. Fallback to the `fallbackAgent` round-robin pick if snapshot lookup
 *      fails (role outside canonical vocabulary or snapshot missing).
 *
 * Returns the primary assignment by default; callers swap to the Claude
 * fallback if the primary provider's CLI binary is missing at spawn time.
 */
export declare function resolveTaskAssignment(task: {
    subject: string;
    description: string;
    role?: string;
}, resolvedRouting: Record<CanonicalTeamRole, {
    primary: RoleAssignment;
    fallback: RoleAssignment;
}>, roleRoutingConfig: Partial<Record<CanonicalTeamRole, TeamRoleAssignmentSpec>> | undefined, resolvedBinaryPaths: Partial<Record<CliAgentType, string>>, fallbackAgent: CliAgentType): {
    agentType: CliAgentType;
    model: string;
    role: CanonicalTeamRole | null;
};
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
        delegation?: TeamTaskDelegationPlan;
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
    /**
     * v2-only: when true, start the merge orchestrator. Forces worktreeMode to
     * 'named' (worker branches must exist) and rejects 'main'/'master' leader
     * branch. See merge-orchestrator.ts.
     */
    autoMerge?: boolean;
}
interface RecoveryOwnerFinalizationDeps {
    readRevisionedConfig: (teamName: string, cwd: string) => Promise<{
        config: TeamConfig;
        stateRevision: number;
    } | null>;
    saveConfigAtRevision: (config: TeamConfig, expectedRevision: number, cwd: string, afterCommit?: () => Promise<void> | void) => Promise<boolean>;
    withConfigLock?: <T>(teamName: string, cwd: string, fn: () => Promise<T> | T) => Promise<T>;
    publishFinal: (input: RecoverDeadWorkerOwnerInput, recoveryId: string, result: RecoverDeadWorkerV2Result) => RecoverDeadWorkerV2Result;
    readDurableContinuation?: (cwd: string, requestId: string, recoveryId: string) => 'none' | 'selected' | 'reserved' | 'adopted';
}
export declare function finalizeRecoveryOwnerResult(input: RecoverDeadWorkerOwnerInput, recoveryId: string, result: RecoverDeadWorkerV2Result, deps?: RecoveryOwnerFinalizationDeps): Promise<RecoverDeadWorkerV2Result>;
export declare function selectRecoveryReplayTasks(tasks: TeamTask[], workerName: string, recoveryId: string, committedPaneLiveness: WorkerPaneLiveness | null): TeamTask[];
export declare function resolveCommittedRecoveryManifestSync(readManifest: () => Promise<TeamManifestV2 | null>, expected: {
    workerName: string;
    paneId: string;
    paneAttemptId: string;
    recoveryId: string;
    replacementGeneration: number;
}): Promise<'synced' | 'repair_required'>;
export declare function resolveCommittedRecoveryPaneAttempt(activeRecovery: TeamConfig['active_recovery'], recoveryId: string, replacementGeneration: number, worker: WorkerInfo): {
    paneId: string;
    paneAttemptId: string;
} | null;
interface BootstrapRecoveryEvidenceWaitOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    now?: () => number;
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}
/** Establish the exact successor/config binding before a detached owner may execute or maintain. */
export declare function prepareRecoveryOwnerBootstrap(input: RecoverDeadWorkerOwnerInput, waitOptions?: BootstrapRecoveryEvidenceWaitOptions): Promise<void>;
/** Private runtime-owner executor. It never calls the public recovery facade. */
export declare function executeRecoverDeadWorkerV2Owner(input: RecoverDeadWorkerOwnerInput): Promise<RecoverDeadWorkerV2Result>;
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
 * Compatibility wrapper that routes legacy dead-worker requeue requests through
 * the strict runtime-owner recovery transaction.
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