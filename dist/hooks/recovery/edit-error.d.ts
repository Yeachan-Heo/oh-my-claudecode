/**
 * Edit Error Recovery
 *
 * Detects Edit tool errors caused by AI mistakes and injects
 * a recovery reminder to guide corrective action.
 */
import type { RecoveryResult } from './types.js';
/**
 * Check if an output contains an edit error pattern
 */
export declare function detectEditError(output: string): boolean;
/**
 * Inject the edit error recovery reminder into the output
 */
export declare function injectEditErrorRecovery(output: string): string;
/**
 * Handle edit error recovery
 */
export declare function handleEditErrorRecovery(toolName: string, output: string): RecoveryResult;
/**
 * Process edit tool output and inject recovery if needed.
 */
export declare function processEditOutput(toolName: string, output: string): string;
//# sourceMappingURL=edit-error.d.ts.map