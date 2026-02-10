/**
 * Transactional Transition Helper
 *
 * Executes a series of steps atomically: if any step fails,
 * all previously completed steps are rolled back in reverse order.
 */
export interface TransitionStep {
    name: string;
    execute: () => Promise<void>;
    rollback: () => Promise<void>;
}
export interface TransitionResult {
    success: boolean;
    failedStep?: string;
    error?: string;
}
/**
 * Execute a sequence of transition steps transactionally.
 * If any step fails, all previously completed steps are rolled back in reverse order.
 */
export declare function executeTransition(steps: TransitionStep[]): Promise<TransitionResult>;
//# sourceMappingURL=transition-helper.d.ts.map