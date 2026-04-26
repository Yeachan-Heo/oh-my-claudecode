export interface WorkerCadenceContext {
    teamName: string;
    workerName: string;
    worktreePath: string;
    agentType: 'claude' | 'codex' | 'gemini';
    enabled: boolean;
}
export type CadenceMethod = 'hook' | 'fallback-poll' | 'none';
/**
 * Writes `{worktreePath}/.claude/settings.json` containing a PostToolUse hook
 * that auto-commits after every Write/Edit/MultiEdit.
 *
 * Skips installation if the .hook-paused sentinel is present.
 */
export declare function installPostToolUseHook(worktreePath: string, workerName: string): Promise<void>;
/**
 * Touches `{worktreePath}/.hook-paused` to suppress auto-commits.
 * Idempotent — no error if already paused.
 */
export declare function pauseHookViaSentinel(worktreePath: string): Promise<void>;
/**
 * Removes `{worktreePath}/.hook-paused` to re-enable auto-commits.
 * Idempotent — no error if already absent.
 */
export declare function resumeHookViaSentinel(worktreePath: string): Promise<void>;
/**
 * Returns true when the .hook-paused sentinel is present (auto-commits suppressed).
 * Synchronous for use inside shell-hook preamble checks and tight loops.
 */
export declare function isHookPaused(worktreePath: string): boolean;
export interface FallbackPollerHandle {
    stop: () => void;
}
/**
 * Starts a filesystem watcher on `worktreePath` with a debounce.
 * On each debounce-fire, runs the same auto-commit command respecting the
 * .hook-paused sentinel. Returns a stop handle.
 *
 * Intended for codex/gemini workers that lack PostToolUse hook support.
 */
export declare function startFallbackPoller(worktreePath: string, workerName: string, opts?: {
    intervalMs?: number;
}): FallbackPollerHandle;
/**
 * Installs the appropriate commit cadence for the worker agent type.
 * - claude  → PostToolUse hook in .claude/settings.json
 * - codex / gemini → fallback fs-watch poller (caller owns the handle)
 *
 * Returns the chosen method. The fallback-poll handle is NOT started here;
 * callers that need the poller should call startFallbackPoller directly.
 */
export declare function installCommitCadence(ctx: WorkerCadenceContext): Promise<{
    method: CadenceMethod;
}>;
/**
 * Removes the auto-commit PostToolUse hook from .claude/settings.json.
 * For fallback-poll workers the caller is responsible for stopping the poller handle.
 */
export declare function uninstallCommitCadence(ctx: WorkerCadenceContext): Promise<void>;
/**
 * Pauses commit cadence by touching the sentinel file.
 * Used by the orchestrator before fanning out a rebase.
 */
export declare function pauseCommitCadence(ctx: WorkerCadenceContext): Promise<void>;
/**
 * Resumes commit cadence by removing the sentinel file.
 * Used by the orchestrator after rebase conflict resolution.
 */
export declare function resumeCommitCadence(ctx: WorkerCadenceContext): Promise<void>;
//# sourceMappingURL=worker-commit-cadence.d.ts.map