/**
 * Session Recovery
 *
 * Helps recover session state when Claude Code restarts or crashes.
 * Detects and fixes various error conditions that can cause session failures.
 */

import { appendFileSync } from 'node:fs';
import {
  findEmptyMessages,
  findEmptyMessageByIndex,
  findMessageByIndexNeedingThinking,
  findMessagesWithEmptyTextParts,
  findMessagesWithOrphanThinking,
  findMessagesWithThinkingBlocks,
  findMessagesWithThinkingOnly,
  injectTextPart,
  prependThinkingPart,
  readParts,
  replaceEmptyTextParts,
  stripThinkingParts,
} from './storage.js';
import {
  DEBUG,
  DEBUG_FILE,
  PLACEHOLDER_TEXT,
  RECOVERY_MESSAGES,
} from './constants.js';
import type {
  MessageData,
  RecoveryResult,
  RecoveryConfig,
} from './types.js';

/**
 * Recovery error types
 */
export type RecoveryErrorType =
  | 'tool_result_missing'
  | 'thinking_block_order'
  | 'thinking_disabled_violation'
  | 'empty_content'
  | null;

/**
 * Debug logging utility
 */
function debugLog(...args: unknown[]): void {
  if (DEBUG) {
    const msg = `[${new Date().toISOString()}] [session-recovery] ${args
      .map((a) => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)))
      .join(' ')}\n`;
    appendFileSync(DEBUG_FILE, msg);
  }
}

/**
 * Extract error message from various error formats
 */
function getErrorMessage(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error.toLowerCase();

  const errorObj = error as Record<string, unknown>;
  const paths = [
    errorObj.data,
    errorObj.error,
    errorObj,
    (errorObj.data as Record<string, unknown>)?.error,
  ];

  for (const obj of paths) {
    if (obj && typeof obj === 'object') {
      const msg = (obj as Record<string, unknown>).message;
      if (typeof msg === 'string' && msg.length > 0) {
        return msg.toLowerCase();
      }
    }
  }

  try {
    return JSON.stringify(error).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Extract message index from error (e.g., "messages.5")
 */
function extractMessageIndex(error: unknown): number | null {
  const message = getErrorMessage(error);
  const match = message.match(/messages\.(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Detect the type of recoverable error
 */
export function detectErrorType(error: unknown): RecoveryErrorType {
  const message = getErrorMessage(error);

  if (message.includes('tool_use') && message.includes('tool_result')) {
    return 'tool_result_missing';
  }

  if (
    message.includes('thinking') &&
    (message.includes('first block') ||
      message.includes('must start with') ||
      message.includes('preceeding') ||
      message.includes('final block') ||
      message.includes('cannot be thinking') ||
      (message.includes('expected') && message.includes('found')))
  ) {
    return 'thinking_block_order';
  }

  if (message.includes('thinking is disabled') && message.includes('cannot contain')) {
    return 'thinking_disabled_violation';
  }

  if (
    message.includes('empty') &&
    (message.includes('content') || message.includes('message'))
  ) {
    return 'empty_content';
  }

  return null;
}

/**
 * Check if an error is recoverable
 */
export function isRecoverableError(error: unknown): boolean {
  return detectErrorType(error) !== null;
}

/**
 * Extract tool_use IDs from message parts
 */
function extractToolUseIds(
  parts: Array<{ type: string; id?: string; callID?: string }>
): string[] {
  return parts
    .filter((p) => p.type === 'tool_use' && !!p.id)
    .map((p) => p.id!);
}

/**
 * Recover from missing tool results
 */
async function recoverToolResultMissing(
  sessionID: string,
  failedAssistantMsg: MessageData
): Promise<boolean> {
  debugLog('recoverToolResultMissing', { sessionID, msgId: failedAssistantMsg.info?.id });

  // Try API parts first, fallback to filesystem if empty
  let parts = failedAssistantMsg.parts || [];
  if (parts.length === 0 && failedAssistantMsg.info?.id) {
    const storedParts = readParts(failedAssistantMsg.info.id);
    parts = storedParts.map((p) => ({
      type: p.type === 'tool' ? 'tool_use' : p.type,
      id: 'callID' in p ? (p as { callID?: string }).callID : p.id,
      name: 'tool' in p ? (p as { tool?: string }).tool : undefined,
      input:
        'state' in p
          ? (p as { state?: { input?: Record<string, unknown> } }).state?.input
          : undefined,
    }));
  }

  const toolUseIds = extractToolUseIds(parts);

  if (toolUseIds.length === 0) {
    debugLog('No tool_use IDs found');
    return false;
  }

  debugLog('Found tool_use IDs to inject results for', toolUseIds);

  // Note: In Claude Code's simplified architecture, we would need to
  // integrate with the actual session/tool system to inject tool results.
  // This is a placeholder showing the recovery intent.
  // A full implementation would require access to the SDK client.

  return false; // Cannot actually inject tool results without SDK client access
}

/**
 * Recover from thinking block order errors
 */
async function recoverThinkingBlockOrder(
  sessionID: string,
  _failedAssistantMsg: MessageData,
  error: unknown
): Promise<boolean> {
  debugLog('recoverThinkingBlockOrder', { sessionID });

  const targetIndex = extractMessageIndex(error);
  if (targetIndex !== null) {
    const targetMessageID = findMessageByIndexNeedingThinking(sessionID, targetIndex);
    if (targetMessageID) {
      debugLog('Found target message by index', { targetIndex, targetMessageID });
      return prependThinkingPart(sessionID, targetMessageID);
    }
  }

  const orphanMessages = findMessagesWithOrphanThinking(sessionID);

  if (orphanMessages.length === 0) {
    debugLog('No orphan thinking messages found');
    return false;
  }

  debugLog('Found orphan thinking messages', orphanMessages);

  let anySuccess = false;
  for (const messageID of orphanMessages) {
    if (prependThinkingPart(sessionID, messageID)) {
      anySuccess = true;
    }
  }

  return anySuccess;
}

/**
 * Recover from thinking disabled violations
 */
async function recoverThinkingDisabledViolation(
  sessionID: string,
  _failedAssistantMsg: MessageData
): Promise<boolean> {
  debugLog('recoverThinkingDisabledViolation', { sessionID });

  const messagesWithThinking = findMessagesWithThinkingBlocks(sessionID);

  if (messagesWithThinking.length === 0) {
    debugLog('No messages with thinking blocks found');
    return false;
  }

  debugLog('Found messages with thinking blocks', messagesWithThinking);

  let anySuccess = false;
  for (const messageID of messagesWithThinking) {
    if (stripThinkingParts(messageID)) {
      anySuccess = true;
    }
  }

  return anySuccess;
}

/**
 * Recover from empty content messages
 */
async function recoverEmptyContentMessage(
  sessionID: string,
  failedAssistantMsg: MessageData,
  error: unknown
): Promise<boolean> {
  debugLog('recoverEmptyContentMessage', { sessionID });

  const targetIndex = extractMessageIndex(error);
  const failedID = failedAssistantMsg.info?.id;
  let anySuccess = false;

  // Fix messages with empty text parts
  const messagesWithEmptyText = findMessagesWithEmptyTextParts(sessionID);
  for (const messageID of messagesWithEmptyText) {
    if (replaceEmptyTextParts(messageID, PLACEHOLDER_TEXT)) {
      anySuccess = true;
    }
  }

  // Fix messages with only thinking
  const thinkingOnlyIDs = findMessagesWithThinkingOnly(sessionID);
  for (const messageID of thinkingOnlyIDs) {
    if (injectTextPart(sessionID, messageID, PLACEHOLDER_TEXT)) {
      anySuccess = true;
    }
  }

  // Try target index if provided
  if (targetIndex !== null) {
    const targetMessageID = findEmptyMessageByIndex(sessionID, targetIndex);
    if (targetMessageID) {
      if (replaceEmptyTextParts(targetMessageID, PLACEHOLDER_TEXT)) {
        return true;
      }
      if (injectTextPart(sessionID, targetMessageID, PLACEHOLDER_TEXT)) {
        return true;
      }
    }
  }

  // Try failed message ID
  if (failedID) {
    if (replaceEmptyTextParts(failedID, PLACEHOLDER_TEXT)) {
      return true;
    }
    if (injectTextPart(sessionID, failedID, PLACEHOLDER_TEXT)) {
      return true;
    }
  }

  // Fix all empty messages as last resort
  const emptyMessageIDs = findEmptyMessages(sessionID);
  for (const messageID of emptyMessageIDs) {
    if (replaceEmptyTextParts(messageID, PLACEHOLDER_TEXT)) {
      anySuccess = true;
    }
    if (injectTextPart(sessionID, messageID, PLACEHOLDER_TEXT)) {
      anySuccess = true;
    }
  }

  return anySuccess;
}

/**
 * Main recovery handler
 */
export async function handleSessionRecovery(
  sessionID: string,
  error: unknown,
  failedMessage?: MessageData,
  config?: RecoveryConfig
): Promise<RecoveryResult> {
  debugLog('handleSessionRecovery', { sessionID, error });

  const errorType = detectErrorType(error);
  if (!errorType) {
    debugLog('Not a recoverable error');
    return {
      attempted: false,
      success: false,
    };
  }

  debugLog('Detected recoverable error type', errorType);

  try {
    let success = false;
    const failedMsg = failedMessage || { info: {}, parts: [] };

    switch (errorType) {
      case 'tool_result_missing':
        success = await recoverToolResultMissing(sessionID, failedMsg);
        break;
      case 'thinking_block_order':
        success = await recoverThinkingBlockOrder(sessionID, failedMsg, error);
        break;
      case 'thinking_disabled_violation':
        success = await recoverThinkingDisabledViolation(sessionID, failedMsg);
        break;
      case 'empty_content':
        success = await recoverEmptyContentMessage(sessionID, failedMsg, error);
        break;
    }

    debugLog('Recovery result', { errorType, success });

    const recoveryMessage =
      config?.customMessages?.[errorType] ||
      RECOVERY_MESSAGES[errorType]?.message ||
      `Session recovery attempted for ${errorType}`;

    return {
      attempted: true,
      success,
      message: success ? recoveryMessage : undefined,
      errorType,
    };
  } catch (err) {
    debugLog('Recovery failed with error', err);
    return {
      attempted: true,
      success: false,
      errorType,
    };
  }
}
