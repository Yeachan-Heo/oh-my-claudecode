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
 * Clean up transient state files
 */
export declare function cleanupTransientState(directory: string): number;
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
 * Export session summary to .omc/sessions/
 */
export declare function exportSessionSummary(directory: string, metrics: SessionMetrics): void;
/**
 * Process session end
 */
export declare function processSessionEnd(input: SessionEndInput): Promise<HookOutput>;
/**
 * Main hook entry point
 */
export declare function handleSessionEnd(input: SessionEndInput): Promise<HookOutput>;
//# sourceMappingURL=index.d.ts.map