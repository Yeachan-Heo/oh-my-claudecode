/**
 * UltraQA Loop Hook
 *
 * QA cycling workflow that runs test → architect verify → fix → repeat
 * until the QA goal is met or max cycles reached.
 */
export type UltraQAGoalType = 'tests' | 'build' | 'lint' | 'typecheck' | 'custom';
export interface UltraQAState {
    /** Whether the loop is currently active */
    active: boolean;
    /** Type of QA goal */
    goal_type: UltraQAGoalType;
    /** Custom pattern to match (for custom goal type) */
    goal_pattern: string | null;
    /** Current cycle number */
    cycle: number;
    /** Maximum cycles before stopping */
    max_cycles: number;
    /** Array of failure descriptions for pattern detection */
    failures: string[];
    /** When the loop started */
    started_at: string;
    /** Session ID the loop is bound to */
    session_id?: string;
    /** Project path for isolation */
    project_path?: string;
}
export interface UltraQAOptions {
    /** Maximum cycles (default: 5) */
    maxCycles?: number;
    /** Custom pattern for custom goal type */
    customPattern?: string;
}
export interface UltraQAResult {
    /** Whether the goal was met */
    success: boolean;
    /** Number of cycles taken */
    cycles: number;
    /** Reason for exit */
    reason: 'goal_met' | 'max_cycles' | 'same_failure' | 'env_error' | 'cancelled';
    /** Diagnosis message if failed */
    diagnosis?: string;
}
/**
 * Read UltraQA state from disk
 */
export declare function readUltraQAState(directory: string, sessionId?: string): UltraQAState | null;
/**
 * Write UltraQA state to disk
 */
export declare function writeUltraQAState(directory: string, state: UltraQAState, sessionId?: string): boolean;
/**
 * Clear UltraQA state
 */
export declare function clearUltraQAState(directory: string, sessionId?: string): boolean;
/**
 * Check if Ralph Loop is active (mutual exclusion check)
 */
export declare function isRalphLoopActive(directory: string, sessionId?: string): boolean;
/**
 * Start a new UltraQA cycle
 * Returns false if Ralph Loop is already active (mutual exclusion)
 */
export declare function startUltraQA(directory: string, goalType: UltraQAGoalType, sessionId: string, options?: UltraQAOptions): {
    success: boolean;
    error?: string;
};
/**
 * Record a failure and increment cycle
 */
export declare function recordFailure(directory: string, failureDescription: string, sessionId?: string): {
    state: UltraQAState | null;
    shouldExit: boolean;
    reason?: string;
};
/**
 * Mark UltraQA as successful
 */
export declare function completeUltraQA(directory: string, sessionId?: string): UltraQAResult | null;
/**
 * Stop UltraQA with failure
 */
export declare function stopUltraQA(directory: string, reason: 'max_cycles' | 'same_failure' | 'env_error', diagnosis: string, sessionId?: string): UltraQAResult | null;
/**
 * Cancel UltraQA
 */
export declare function cancelUltraQA(directory: string, sessionId?: string): boolean;
/**
 * Get goal command based on goal type
 */
export declare function getGoalCommand(goalType: UltraQAGoalType): string;
/**
 * Format progress message
 */
export declare function formatProgressMessage(cycle: number, maxCycles: number, status: string): string;
//# sourceMappingURL=index.d.ts.map