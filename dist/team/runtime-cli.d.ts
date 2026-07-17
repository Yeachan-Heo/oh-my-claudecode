/**
 * CLI entry point for team runtime.
 * Reads JSON config from stdin, runs startTeam/monitorTeam/shutdownTeam,
 * writes structured JSON result to stdout.
 *
 * Bundled as CJS via esbuild (scripts/build-runtime-cli.mjs).
 */
import type { TeamRuntime } from './runtime.js';
import type { TeamConfig as PersistedTeamConfig } from './types.js';
import type { TeamSnapshotV2 } from './runtime-v2.js';
import { type RecoverDeadWorkerOwnerInput } from './runtime-owner-client.js';
import type { RecoverDeadWorkerV2Result } from './types.js';
import { type OwnerFence } from './team-owner-epoch.js';
export interface RuntimeWorkerPaneRefresh {
    authoritativePaneIds: string[];
    allWorkerPaneIdsKnown: boolean;
}
/**
 * Retain startup panes for explicit cleanup, but include committed recovery
 * replacements from the revisioned config before publishing cleanup evidence.
 */
export declare function refreshRuntimeWorkerPaneIds(runtime: Pick<TeamRuntime, 'workerPaneIds'>, teamName: string, cwd: string): Promise<RuntimeWorkerPaneRefresh | null>;
export type AllDeadRecoveryEvidence = 'all_dead' | 'alive' | 'unknown' | 'clear';
export declare function classifyAllDeadRecoveryEvidence(refresh: RuntimeWorkerPaneRefresh, workers: TeamSnapshotV2['workers'], hasOutstanding: boolean): AllDeadRecoveryEvidence;
export declare function areAllAuthoritativeWorkersDead(refresh: RuntimeWorkerPaneRefresh, workers: TeamSnapshotV2['workers']): boolean;
/** Private owner dispatch entry point used by durable recovery admission. */
export declare function handleRecoverDeadWorkerV2Owner(input: RecoverDeadWorkerOwnerInput, execute?: (ownerInput: RecoverDeadWorkerOwnerInput) => Promise<RecoverDeadWorkerV2Result>): Promise<RecoverDeadWorkerV2Result>;
export declare function processPendingRecoveryIntents(teamName: string, cwd: string, execute?: (input: RecoverDeadWorkerOwnerInput) => Promise<RecoverDeadWorkerV2Result>): Promise<void>;
export declare function updateAllDeadRecoveryGrace(teamName: string, cwd: string, evidence: AllDeadRecoveryEvidence, nowMs?: number): Promise<{
    deadlineAt: number | null;
    expired: boolean;
}>;
export declare function hasPendingRecoveryIntentBeforeDeadline(teamName: string, cwd: string, deadlineAt: number): boolean;
export declare function hasPendingRecoveryAdmissionBeforeDeadline(teamName: string, cwd: string, deadlineAt: number): boolean;
export declare function fenceAllDeadRecoveryExpiry(teamName: string, cwd: string, deadlineAt: number): Promise<boolean>;
export interface PersistentRecoveryOwnerLoopOptions {
    expectedEpoch?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    execute?: (input: RecoverDeadWorkerOwnerInput) => Promise<RecoverDeadWorkerV2Result>;
    processIntents?: (teamName: string, cwd: string) => Promise<void>;
    reconcileServices?: (config: PersistedTeamConfig, cwd: string) => Promise<'synced' | 'repair_required'>;
    monitor?: (teamName: string, cwd: string) => Promise<TeamSnapshotV2 | null>;
    verifyFence?: (input: RecoverDeadWorkerOwnerInput, fence: OwnerFence, expectedEpoch?: number) => boolean;
    shouldContinue?: (iteration: number) => boolean;
    shutdown?: (teamName: string, cwd: string, options: {
        force: boolean;
    }) => Promise<void>;
}
/**
 * Keep a detached successor alive as a normal v2 owner. It never starts a
 * team: it drains durable recovery intent, reconciles durable services, and
 * maintains persisted all-dead grace while its exact epoch is authoritative.
 */
export declare function runPersistentRecoveryOwnerLoop(input: RecoverDeadWorkerOwnerInput, options?: PersistentRecoveryOwnerLoopOptions): Promise<void>;
export declare function assertAutoMergeRuntimeSupported(useV2: boolean, autoMerge: boolean): void;
interface TaskResult {
    taskId: string;
    status: string;
    summary: string;
}
interface CliOutput {
    status: 'completed' | 'failed';
    teamName: string;
    taskResults: TaskResult[];
    duration: number;
    workerCount: number;
}
export type TerminalPhaseResult = 'complete' | 'failed' | 'cancelled';
export interface TerminalCliResult {
    output: CliOutput;
    exitCode: number;
    notice: string;
}
type TerminalStatus = 'completed' | 'failed' | null;
export declare function getTerminalStatus(taskCounts: {
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
}, expectedTaskCount: number): TerminalStatus;
export declare function checkWatchdogFailedMarker(stateRoot: string, startTime: number): Promise<{
    failed: boolean;
    reason?: string;
}>;
export declare function writeResultArtifact(output: CliOutput, finishedAt: string, jobId?: string | undefined, omcJobsDir?: string | undefined): Promise<void>;
export declare function buildCliOutput(stateRoot: string, teamName: string, status: 'completed' | 'failed', workerCount: number, startTimeMs: number): CliOutput;
export declare function buildTerminalCliResult(stateRoot: string, teamName: string, phase: TerminalPhaseResult, workerCount: number, startTimeMs: number): TerminalCliResult;
/**
 * A task "final" is terse when it carries no substantive content: empty/
 * whitespace, or a bare acknowledgement like "Done." / "Ready." / "OK".
 * Such finals hide the real work that lives in the task's `.output` file,
 * so they are candidates for substitution. Anything else is treated as a
 * substantive final and preserved as-is.
 */
export declare function isTerseFinalSummary(summary: string): boolean;
/**
 * Locate the newest `.output` file recorded for a task under the team's
 * outputs directory and return its (bounded) content. Returns null when no
 * non-empty output file exists. Best-effort: never throws.
 */
export declare function readTaskOutputFallback(outputsDir: string, teamName: string, taskId: string): string | null;
/**
 * Preserve watchdog quiescence before capturing terminal output, then tear down
 * the team and publish that immutable snapshot. Shutdown may remove v1 state.
 */
export declare function finalizeRuntimeShutdown<T>(runtime: Pick<TeamRuntime, 'stopWatchdog'> | null, useV2: boolean, collectOutput: () => Promise<T>, shutdown: () => Promise<void>, publishOutput: (output: T) => Promise<void>): Promise<T>;
/** Detached durable recovery-owner entry point. It remains the persistent v2 owner until its fence or team lifecycle is lost. */
export declare function runRecoveryOwnerFromEnvironment(): Promise<void>;
export {};
//# sourceMappingURL=runtime-cli.d.ts.map