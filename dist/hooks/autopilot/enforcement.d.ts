/**
 * Autopilot Enforcement & Signal Detection
 *
 * Parallel to ralph-loop enforcement - intercepts stops and continues
 * until phase completion signals are detected.
 *
 * Also handles signal detection in session transcripts.
 */
import type { AutopilotPhase, AutopilotSignal } from './types.js';
import { type ToolErrorState } from '../persistent-mode/index.js';
export interface AutopilotEnforcementResult {
    /** Whether to block the stop event */
    shouldBlock: boolean;
    /** Message to inject into context */
    message: string;
    /** Current phase */
    phase: AutopilotPhase;
    /** Additional metadata */
    metadata?: {
        iteration?: number;
        maxIterations?: number;
        tasksCompleted?: number;
        tasksTotal?: number;
        toolError?: ToolErrorState;
    };
}
/**
 * Detect a specific signal in the session transcript
 */
export declare function detectSignal(sessionId: string, signal: AutopilotSignal): boolean;
/**
 * Get the expected signal for the current phase
 */
export declare function getExpectedSignalForPhase(phase: string): AutopilotSignal | null;
/**
 * Detect any autopilot signal in transcript (for phase advancement)
 */
export declare function detectAnySignal(sessionId: string): AutopilotSignal | null;
/**
 * Check autopilot state and determine if it should continue
 * This is the main enforcement function called by persistent-mode hook
 */
export declare function checkAutopilot(sessionId?: string, directory?: string): Promise<AutopilotEnforcementResult | null>;
//# sourceMappingURL=enforcement.d.ts.map