/**
 * Session Recovery
 *
 * Helps recover session state when Claude Code restarts or crashes.
 * Detects and fixes various error conditions that can cause session failures.
 */
import type { MessageData, RecoveryResult, RecoveryConfig } from './types.js';
/**
 * Recovery error types
 */
export type RecoveryErrorType = 'tool_result_missing' | 'thinking_block_order' | 'thinking_disabled_violation' | 'empty_content' | null;
/**
 * Detect the type of recoverable error
 */
export declare function detectErrorType(error: unknown): RecoveryErrorType;
/**
 * Check if an error is recoverable
 */
export declare function isRecoverableError(error: unknown): boolean;
/**
 * Main recovery handler
 */
export declare function handleSessionRecovery(sessionID: string, error: unknown, failedMessage?: MessageData, config?: RecoveryConfig): Promise<RecoveryResult>;
//# sourceMappingURL=session-recovery.d.ts.map