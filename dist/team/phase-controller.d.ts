export type TeamPhase = 'initializing' | 'planning' | 'executing' | 'fixing' | 'completed' | 'failed';
export interface PhaseableTask {
    status: string;
    metadata?: {
        permanentlyFailed?: boolean;
        retryCount?: number;
        maxRetries?: number;
    };
}
/**
 * Infer current team phase from task status distribution.
 *
 * Rules (evaluated in order):
 * 1. Empty task list → 'initializing'
 * 2. Any in_progress → 'executing'
 * 3. All pending, no completed, no failed → 'planning'
 * 4. Mixed completed + pending (no in_progress) → 'executing' (some done, others queued)
 * 5. Tasks with metadata.permanentlyFailed === true are counted as FAILED (not completed)
 * 6. Any failed (including permanentlyFailed) AND retries remaining → 'fixing'
 * 7. All tasks failed (including permanentlyFailed) AND retries exhausted → 'failed'
 * 8. All completed AND zero permanentlyFailed → 'completed'
 * 9. Fallback → 'executing'
 */
export declare function inferPhase(tasks: PhaseableTask[]): TeamPhase;
/**
 * Get a human-readable log message for a phase transition.
 */
export declare function getPhaseTransitionLog(prev: TeamPhase, next: TeamPhase): string;
/**
 * Check if a phase is terminal (no further transitions expected).
 */
export declare function isTerminalPhase(phase: TeamPhase): boolean;
//# sourceMappingURL=phase-controller.d.ts.map