export interface SessionEndInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    hook_event_name: 'SessionEnd';
    reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}
export interface SessionMetrics {
    session_id: string;
    started_at?: string;
    ended_at: string;
    reason: string;
    duration_ms?: number;
    agents_spawned: number;
    agents_completed: number;
    modes_used: string[];
}
export interface HookOutput {
    continue: boolean;
}
interface SessionOwnedTeamCleanupResult {
    attempted: string[];
    cleaned: string[];
    failed: Array<{
        teamName: string;
        error: string;
    }>;
}
export interface SessionEndCleanupWorkerPayload {
    directory: string;
    sessionId: string;
    transcriptPath: string;
    cleanupBudgetMs: number;
    initialTeamNames?: string[];
}
export declare function resolveSessionEndCleanupBudgetMs(env?: NodeJS.ProcessEnv): number;
/**
 * Get session start time from state files.
 *
 * When sessionId is provided, only state files whose session_id matches are
 * considered.  State files that carry a *different* session_id are treated as
 * stale leftovers and skipped — this is the fix for issue #573 where stale
 * state files caused grossly overreported session durations.
 *
 * Legacy state files (no session_id field) are used as a fallback so that
 * older state formats still work.
 *
 * When multiple files match, the earliest started_at is returned so that
 * duration reflects the full session span (e.g. autopilot started before
 * ultrawork).
 */
export declare function getSessionStartTime(directory: string, sessionId?: string): string | undefined;
/**
 * Record session metrics
 */
export declare function recordSessionMetrics(directory: string, input: SessionEndInput): SessionMetrics;
/**
 * Clean up transient state files.
 *
 * @param directory - Worktree root (or any path under it).
 * @param endingSessionId - Optional id of the session that is ending.
 *   When provided, per-session transient caches (HUD stdin cache) are
 *   removed only from that session's directory so other concurrent
 *   sessions keep their live state. When omitted (e.g. legacy callers
 *   or tests), the previous behavior is preserved for compatibility.
 */
export declare function cleanupTransientState(directory: string, endingSessionId?: string): number;
/**
 * Extract python_repl research session IDs from transcript JSONL.
 * These sessions are terminated on SessionEnd to prevent bridge leaks.
 */
export declare function extractPythonReplSessionIdsFromTranscript(transcriptPath: string): Promise<string[]>;
/**
 * Clean up mode state files on session end.
 *
 * This prevents stale state from causing the stop hook to malfunction
 * in subsequent sessions. When a session ends normally, all active modes
 * should be considered terminated.
 *
 * @param directory - The project directory
 * @param sessionId - Optional session ID to match. Only cleans states belonging to this session.
 * @returns Object with counts of files removed and modes cleaned
 */
export declare function cleanupModeStates(directory: string, sessionId?: string): {
    filesRemoved: number;
    modesCleaned: string[];
};
/**
 * Clean up mission-state.json entries belonging to this session.
 * Without this, the HUD keeps showing stale mode/mission info after session end.
 *
 * When sessionId is provided, only removes missions whose source is 'session'
 * and whose id contains the sessionId. When sessionId is omitted, removes all
 * session-sourced missions.
 */
export declare function cleanupMissionState(directory: string, sessionId?: string): number;
export declare function cleanupSessionOwnedTeams(directory: string, sessionId: string, initialTeamNames?: string[]): Promise<SessionOwnedTeamCleanupResult>;
/**
 * Export session summary to .omc/sessions/
 */
export declare function exportSessionSummary(directory: string, metrics: SessionMetrics): void;
export declare function cleanupSessionPython(directory: string, sessionId: string): Promise<void>;
/** Compatibility export; durable ownership is handled by the manifest worker. */
export declare function processSessionEndCleanupWorker(payload: SessionEndCleanupWorkerPayload): Promise<void>;
export declare function cleanupSessionReplies(sessionId: string): Promise<void>;
export declare function runSessionEndCallbacks(directory: string, sessionId: string, idempotencyKey?: string, strict?: boolean): Promise<void>;
export declare function runSessionEndNotifications(directory: string, sessionId: string, strict?: boolean): Promise<void>;
export declare function runSessionEndOpenClaw(directory: string, sessionId: string, strict?: boolean): Promise<void>;
/** Foreground cleanup has no network/process waits and records its result before the core producer is sealed. */
export declare function runForegroundSessionEndCleanup(directory: string, sessionId: string, persistResult?: boolean): Promise<Record<string, unknown>>;
export declare function processSessionEnd(input: SessionEndInput): Promise<HookOutput>;
/** Wiki producer has no foreground lock or write; it only seals a durable capture/no-op intent. */
export declare function processWikiSessionEnd(input: SessionEndInput): Promise<HookOutput>;
export declare function handleSessionEnd(input: SessionEndInput): Promise<HookOutput>;
export {};
//# sourceMappingURL=index.d.ts.map