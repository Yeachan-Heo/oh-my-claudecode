/**
 * Think Mode Hook
 *
 * Activates extended thinking/reasoning mode when users include
 * think keywords in their prompts.
 *
 * Ported from oh-my-opencode's think-mode hook.
 */
import { getClaudeThinkingConfig } from './switcher.js';
import type { ThinkModeState, ThinkModeInput } from './types.js';
export * from './detector.js';
export * from './switcher.js';
export * from './types.js';
/**
 * Clear think mode state for a session.
 */
export declare function clearThinkModeState(sessionId: string): void;
/**
 * Get the current think mode state for a session.
 */
export declare function getThinkModeState(sessionId: string): ThinkModeState | undefined;
/**
 * Check if think mode is active for a session.
 */
export declare function isThinkModeActive(sessionId: string): boolean;
/**
 * Process a prompt for think mode keywords.
 * Returns the detected state.
 */
export declare function processThinkMode(sessionId: string, promptText: string): ThinkModeState;
/**
 * Create the think mode hook for Claude Code integration.
 */
export declare function createThinkModeHook(): {
    /**
     * Process chat parameters and detect think mode.
     */
    processChatParams: (sessionId: string, input: ThinkModeInput) => ThinkModeState;
    /**
     * Handle session deletion events.
     */
    onSessionDeleted: (sessionId: string) => void;
    /**
     * Check if think mode was requested.
     */
    isRequested: (sessionId: string) => boolean;
    /**
     * Get the current state.
     */
    getState: (sessionId: string) => ThinkModeState | undefined;
    /**
     * Clear state for a session.
     */
    clear: typeof clearThinkModeState;
};
/**
 * Simplified function to check if a prompt requests think mode.
 * For direct use without hook context.
 */
export declare function shouldActivateThinkMode(prompt: string): boolean;
/**
 * Check if ultrathink (highest reasoning) was requested.
 */
export declare function shouldActivateUltrathink(prompt: string): boolean;
/**
 * Get Claude thinking configuration for extended thinking.
 * For direct use when manually configuring Claude API calls.
 */
export { getClaudeThinkingConfig };
//# sourceMappingURL=index.d.ts.map