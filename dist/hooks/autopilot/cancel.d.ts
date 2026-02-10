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
/**
 * Check if autopilot can be resumed
 */
export declare function canResumeAutopilot(directory: string, sessionId?: string): {
    canResume: boolean;
    state?: AutopilotState;
    resumePhase?: string;
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