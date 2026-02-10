/**
 * Persistent Mode Hook
 *
 * Unified handler for persistent work modes: ultrawork, ralph, and todo-continuation.
 * This hook intercepts Stop events and enforces work continuation based on:
 * 1. Active ultrawork mode with pending todos
 * 2. Active ralph loop (until cancelled via /oh-my-claudecode:cancel)
 * 3. Any pending todos (general enforcement)
 *
 * Priority order: Ralph > Ultrawork > Todo Continuation
 */
import { StopContext } from '../todo-continuation/index.js';
export interface ToolErrorState {
    tool_name: string;
    tool_input_preview?: string;
    error: string;
    timestamp: string;
    retry_count: number;
}
export interface PersistentModeResult {
    /** Whether to block the stop event */
    shouldBlock: boolean;
    /** Message to inject into context */
    message: string;
    /** Which mode triggered the block */
    mode: 'ralph' | 'ultrawork' | 'todo-continuation' | 'autopilot' | 'none';
    /** Additional metadata */
    metadata?: {
        todoCount?: number;
        iteration?: number;
        maxIterations?: number;
        reinforcementCount?: number;
        todoContinuationAttempts?: number;
        phase?: string;
        tasksCompleted?: number;
        tasksTotal?: number;
        toolError?: ToolErrorState;
    };
}
/**
 * Read last tool error from state directory.
 * Returns null if file doesn't exist or error is stale (>60 seconds old).
 */
export declare function readLastToolError(directory: string): ToolErrorState | null;
/**
 * Clear tool error state file atomically.
 */
export declare function clearToolErrorState(directory: string): void;
/**
 * Generate retry guidance message for tool errors.
 * After 5+ retries, suggests alternative approaches.
 */
export declare function getToolErrorRetryGuidance(toolError: ToolErrorState | null): string;
/**
 * Reset todo-continuation attempt counter (call when todos actually change)
 */
export declare function resetTodoContinuationAttempts(sessionId: string): void;
/**
 * Main persistent mode checker
 * Checks all persistent modes in priority order and returns appropriate action
 */
export declare function checkPersistentModes(sessionId?: string, directory?: string, stopContext?: StopContext): Promise<PersistentModeResult>;
/**
 * Create hook output for Claude Code
 * NOTE: Always returns continue: true with soft enforcement via message injection.
 * Never returns continue: false to avoid blocking user intent.
 */
export declare function createHookOutput(result: PersistentModeResult): {
    continue: boolean;
    message?: string;
};
//# sourceMappingURL=index.d.ts.map