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

import {
  handleContextWindowRecovery,
  detectContextLimitError,
  parseTokenLimitError,
} from './context-window.js';
import {
  handleEditErrorRecovery,
  detectEditError,
  processEditOutput,
} from './edit-error.js';
import {
  handleSessionRecovery,
  detectErrorType as detectSessionErrorType,
  isRecoverableError,
} from './session-recovery.js';

// Re-export types
export type {
  RecoveryErrorType,
  RecoveryResult,
  RecoveryConfig,
  ParsedTokenLimitError,
  RetryState,
  TruncateState,
  MessageData,
  StoredMessageMeta,
  StoredPart,
  StoredTextPart,
  StoredToolPart,
  StoredReasoningPart,
} from './types.js';

export { RETRY_CONFIG, TRUNCATE_CONFIG } from './types.js';

// Re-export constants
export {
  CONTEXT_LIMIT_RECOVERY_MESSAGE,
  CONTEXT_LIMIT_SHORT_MESSAGE,
  NON_EMPTY_CONTENT_RECOVERY_MESSAGE,
  TRUNCATION_APPLIED_MESSAGE,
  RECOVERY_FAILED_MESSAGE,
  TOKEN_LIMIT_PATTERNS,
  TOKEN_LIMIT_KEYWORDS,
  EDIT_ERROR_PATTERNS,
  EDIT_ERROR_REMINDER,
  RECOVERY_MESSAGES,
  PLACEHOLDER_TEXT,
} from './constants.js';

// Re-export storage utilities
export {
  readMessages,
  readParts,
  findEmptyMessages,
  findMessagesWithThinkingBlocks,
  findMessagesWithOrphanThinking,
  injectTextPart,
  prependThinkingPart,
  stripThinkingParts,
  replaceEmptyTextParts,
} from './storage.js';

// Re-export individual recovery functions
export {
  handleContextWindowRecovery,
  detectContextLimitError,
  parseTokenLimitError,
  containsTokenLimitError,
} from './context-window.js';

export {
  handleEditErrorRecovery,
  detectEditError,
  processEditOutput,
} from './edit-error.js';

export {
  handleSessionRecovery,
  detectErrorType as detectSessionErrorType,
  isRecoverableError,
} from './session-recovery.js';

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
export async function handleRecovery(input: {
  sessionId: string;
  error?: unknown;
  toolName?: string;
  toolOutput?: string;
  message?: MessageData;
  config?: RecoveryConfig;
}): Promise<RecoveryResult> {
  const { sessionId, error, toolName, toolOutput, message, config } = input;

  // Priority 1: Context Window Limit
  if (error) {
    const contextResult = handleContextWindowRecovery(sessionId, error, config);
    if (contextResult.attempted && contextResult.success) {
      return contextResult;
    }
  }

  // Priority 2: Session Recovery
  if (error) {
    const sessionResult = await handleSessionRecovery(sessionId, error, message, config);
    if (sessionResult.attempted && sessionResult.success) {
      return sessionResult;
    }
  }

  // Priority 3: Edit Error Recovery
  if (toolName && toolOutput) {
    const editResult = handleEditErrorRecovery(toolName, toolOutput);
    if (editResult.attempted && editResult.success) {
      return editResult;
    }
  }

  return {
    attempted: false,
    success: false,
  };
}

/**
 * Detect if an error is recoverable
 *
 * Checks all recovery mechanisms to see if the error can be handled.
 */
export function detectRecoverableError(error: unknown): {
  recoverable: boolean;
  type?: string;
} {
  // Check context window limit
  const parsed = parseTokenLimitError(error);
  if (parsed) {
    return {
      recoverable: true,
      type: 'context_window_limit',
    };
  }

  // Check session recovery
  const sessionErrorType = detectSessionErrorType(error);
  if (sessionErrorType) {
    return {
      recoverable: true,
      type: sessionErrorType,
    };
  }

  return {
    recoverable: false,
  };
}

/**
 * Detect if output contains an edit error
 */
export function detectEditErrorInOutput(output: string): boolean {
  return detectEditError(output);
}

/**
 * Create unified recovery hook for Claude Code
 *
 * This hook provides a single entry point for all recovery mechanisms.
 */
export function createRecoveryHook(config?: RecoveryConfig) {
  return {
    /**
     * Check for errors during tool execution or message processing
     */
    onError: async (input: {
      session_id: string;
      error: unknown;
      message?: MessageData;
    }): Promise<RecoveryResult> => {
      return handleRecovery({
        sessionId: input.session_id,
        error: input.error,
        message: input.message,
        config,
      });
    },

    /**
     * Post-tool execution hook for edit error recovery
     */
    afterToolExecute: (input: {
      tool: string;
      output: string;
      sessionId: string;
    }): { output: string; recovery?: RecoveryResult } => {
      const result = handleEditErrorRecovery(input.tool, input.output);

      if (result.attempted && result.success) {
        return {
          output: processEditOutput(input.tool, input.output),
          recovery: result,
        };
      }

      return {
        output: input.output,
      };
    },

    /**
     * Check if an error is recoverable
     */
    isRecoverable: (error: unknown): boolean => {
      return detectRecoverableError(error).recoverable;
    },

    /**
     * Get recovery type for an error
     */
    getRecoveryType: (error: unknown): string | undefined => {
      return detectRecoverableError(error).type;
    },
  };
}

/**
 * Parse context limit error for detailed information
 */
export function parseContextLimitError(error: unknown) {
  return parseTokenLimitError(error);
}

/**
 * Detect if text contains a context limit error
 */
export function detectContextLimitErrorInText(text: string): boolean {
  return detectContextLimitError(text);
}

/**
 * Detect if text contains an edit error
 */
export function detectEditErrorInText(text: string): boolean {
  return detectEditError(text);
}

/**
 * Check if session error is recoverable
 */
export function isSessionRecoverable(error: unknown): boolean {
  return isRecoverableError(error);
}
