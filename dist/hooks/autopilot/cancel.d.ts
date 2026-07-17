/**
 * Autopilot Cancellation
 *
 * Handles cancellation of autopilot, cleaning up all related state
 * including any active Ralph or UltraQA modes.
 */
import type { AutopilotState } from './types.js';
export interface CancelResult {
    success: boolean;
    message: string;
    preservedState?: AutopilotState;
}
/**
 * Cancel autopilot and clean up all related state
 * Progress is preserved for potential resume
 */
export declare function cancelAutopilot(directory: string, sessionId?: string): CancelResult;
/**
 * Fully clear autopilot state (no preserve)
 */
export declare function clearAutopilot(directory: string, sessionId?: string): CancelResult;
/** Maximum age (ms) for state to be considered resumable (1 hour) */
export declare const STALE_STATE_MAX_AGE_MS: number;
/**
 * Check if autopilot can be resumed.
 *
 * Guards against stale state reuse (issue #609):
 * - Rejects terminal phases (complete/failed)
 * - Rejects states still marked active (session may still be running)
 * - Rejects stale states older than STALE_STATE_MAX_AGE_MS
 * - Auto-cleans stale state files to prevent future false positives
 */
export declare function canResumeAutopilot(directory: string, sessionId?: string): {
    canResume: boolean;
    state?: AutopilotState;
    resumePhase?: string;
    integrityFailed?: boolean;
    unsupportedRuntime?: boolean;
};
/**
 * Resume a paused autopilot session
 */
export declare function resumeAutopilot(directory: string, sessionId?: string): {
    success: boolean;
    message: string;
    state?: AutopilotState;
};
/**
 * Format cancel message for display
 */
export declare function formatCancelMessage(result: CancelResult): string;
//# sourceMappingURL=cancel.d.ts.map