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
 * Record session metrics
 */
export declare function recordSessionMetrics(directory: string, input: SessionEndInput): SessionMetrics;
/**
 * Clean up transient state files
 */
export declare function cleanupTransientState(directory: string): number;
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