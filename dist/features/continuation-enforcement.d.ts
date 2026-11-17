/**
 * Continuation Enforcement Feature
 *
 * Ensures agents complete all tasks before stopping:
 * - Monitors todo list for incomplete items
 * - Adds reminders to continue when tasks remain
 * - Prevents premature stopping
 * - Provides background task execution guidance
 */
import type { HookDefinition } from '../shared/types.js';
/**
 * Create a continuation enforcement hook
 *
 * This hook intercepts stop attempts and checks if there are
 * incomplete tasks. If so, it blocks the stop and reminds
 * the agent to continue.
 */
export declare function createContinuationHook(): HookDefinition;
/**
 * System prompt addition for continuation enforcement
 * ENHANCED: Much stronger persistence language from oh-my-opencode patterns
 */
export declare const continuationSystemPromptAddition: string;
/**
 * Check prompt for signals that all work is done
 */
export declare function detectCompletionSignals(response: string): {
    claimed: boolean;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
};
/**
 * Generate a verification prompt to ensure work is complete
 */
export declare function generateVerificationPrompt(taskSummary: string): string;
//# sourceMappingURL=continuation-enforcement.d.ts.map