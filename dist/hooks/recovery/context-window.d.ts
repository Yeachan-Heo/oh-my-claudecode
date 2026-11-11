/**
 * Context Window Limit Recovery
 *
 * Detects context window limit errors and injects recovery messages
 * to help Claude recover gracefully.
 */
import type { ParsedTokenLimitError, RecoveryResult, RecoveryConfig } from './types.js';
/**
 * Remove session state for a given session ID (call on context window exhaustion).
 */
export declare function clearSessionState(sessionId: string): void;
/**
 * Parse an error to detect if it's a token limit error
 */
export declare function parseTokenLimitError(err: unknown): ParsedTokenLimitError | null;
/**
 * Check if text contains a context limit error
 */
export declare function containsTokenLimitError(text: string): boolean;
/**
 * Handle context window limit recovery
 */
export declare function handleContextWindowRecovery(sessionId: string, error: unknown, config?: RecoveryConfig): RecoveryResult;
/**
 * Check if text contains a context limit error
 */
export declare function detectContextLimitError(text: string): boolean;
//# sourceMappingURL=context-window.d.ts.map