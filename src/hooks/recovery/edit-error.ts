/**
 * Edit Error Recovery
 *
 * Detects Edit tool errors caused by AI mistakes and injects
 * a recovery reminder to guide corrective action.
 */

import {
  EDIT_ERROR_PATTERNS,
  EDIT_ERROR_REMINDER,
} from './constants.js';
import type { RecoveryResult } from './types.js';

/**
 * Check if an output contains an edit error pattern
 */
export function detectEditError(output: string): boolean {
  const outputLower = output.toLowerCase();
  return EDIT_ERROR_PATTERNS.some((pattern) =>
    outputLower.includes(pattern.toLowerCase())
  );
}

/**
 * Inject the edit error recovery reminder into the output
 */
export function injectEditErrorRecovery(output: string): string {
  if (detectEditError(output)) {
    return output + EDIT_ERROR_REMINDER;
  }
  return output;
}

/**
 * Handle edit error recovery
 */
export function handleEditErrorRecovery(
  toolName: string,
  output: string
): RecoveryResult {
  if (toolName.toLowerCase() !== 'edit') {
    return {
      attempted: false,
      success: false,
    };
  }

  if (detectEditError(output)) {
    return {
      attempted: true,
      success: true,
      message: EDIT_ERROR_REMINDER,
      errorType: 'edit_error',
    };
  }

  return {
    attempted: false,
    success: false,
  };
}

/**
 * Process edit tool output and inject recovery if needed.
 */
export function processEditOutput(toolName: string, output: string): string {
  if (toolName.toLowerCase() !== 'edit') {
    return output;
  }
  return injectEditErrorRecovery(output);
}
