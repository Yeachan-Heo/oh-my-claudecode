/**
 * Unified Recovery Module
 *
 * Consolidates all recovery mechanisms into a single, coordinated system.
 * Handles context window limits, edit errors, and session recovery.
 *
 * Recovery Priority (checked in order):
 * 1. Context Window Limit - Most critical, blocks all progress
 * 2. Edit Errors - Immediate user feedback needed
 * 3. Session Recovery - Structural errors that need fixing
 */
export type { RecoveryErrorType, RecoveryResult, RecoveryConfig, ParsedTokenLimitError, RetryState, TruncateState, MessageData, StoredMessageMeta, StoredPart, StoredTextPart, StoredToolPart, StoredReasoningPart, } from './types.js';
export { RETRY_CONFIG, TRUNCATE_CONFIG } from './types.js';
export { CONTEXT_LIMIT_RECOVERY_MESSAGE, CONTEXT_LIMIT_SHORT_MESSAGE, NON_EMPTY_CONTENT_RECOVERY_MESSAGE, TRUNCATION_APPLIED_MESSAGE, RECOVERY_FAILED_MESSAGE, TOKEN_LIMIT_PATTERNS, TOKEN_LIMIT_KEYWORDS, EDIT_ERROR_PATTERNS, EDIT_ERROR_REMINDER, RECOVERY_MESSAGES, PLACEHOLDER_TEXT, } from './constants.js';
export { readMessages, readParts, findEmptyMessages, findMessagesWithThinkingBlocks, findMessagesWithOrphanThinking, injectTextPart, prependThinkingPart, stripThinkingParts, replaceEmptyTextParts, } from './storage.js';
export { handleContextWindowRecovery, detectContextLimitError, parseTokenLimitError, containsTokenLimitError, } from './context-window.js';
export { handleEditErrorRecovery, detectEditError, processEditOutput, } from './edit-error.js';
export { handleSessionRecovery, detectErrorType as detectSessionErrorType, isRecoverableError, } from './session-recovery.js';
import type { RecoveryResult, RecoveryConfig, MessageData } from './types.js';
/**
 * Unified recovery handler
 *
 * Attempts recovery in priority order:
 * 1. Context Window Limit (most critical)
 * 2. Session Recovery (structural errors)
 * 3. Edit Errors (handled during tool execution)
 *
 * @param input Recovery input
 * @returns Recovery result
 */
export declare function handleRecovery(input: {
    sessionId: string;
    error?: unknown;
    toolName?: string;
    toolOutput?: string;
    message?: MessageData;
    config?: RecoveryConfig;
}): Promise<RecoveryResult>;
/**
 * Detect if an error is recoverable
 *
 * Checks all recovery mechanisms to see if the error can be handled.
 */
export declare function detectRecoverableError(error: unknown): {
    recoverable: boolean;
    type?: string;
};
/**
 * Detect if output contains an edit error
 */
export declare function detectEditErrorInOutput(output: string): boolean;
/**
 * Create unified recovery hook for Claude Code
 *
 * This hook provides a single entry point for all recovery mechanisms.
 */
export declare function createRecoveryHook(config?: RecoveryConfig): {
    /**
     * Check for errors during tool execution or message processing
     */
    onError: (input: {
        session_id: string;
        error: unknown;
        message?: MessageData;
    }) => Promise<RecoveryResult>;
    /**
     * Post-tool execution hook for edit error recovery
     */
    afterToolExecute: (input: {
        tool: string;
        output: string;
        sessionId: string;
    }) => {
        output: string;
        recovery?: RecoveryResult;
    };
    /**
     * Check if an error is recoverable
     */
    isRecoverable: (error: unknown) => boolean;
    /**
     * Get recovery type for an error
     */
    getRecoveryType: (error: unknown) => string | undefined;
};
/**
 * Parse context limit error for detailed information
 */
export declare function parseContextLimitError(error: unknown): import("./types.js").ParsedTokenLimitError | null;
/**
 * Detect if text contains a context limit error
 */
export declare function detectContextLimitErrorInText(text: string): boolean;
/**
 * Detect if text contains an edit error
 */
export declare function detectEditErrorInText(text: string): boolean;
/**
 * Check if session error is recoverable
 */
export declare function isSessionRecoverable(error: unknown): boolean;
//# sourceMappingURL=index.d.ts.map