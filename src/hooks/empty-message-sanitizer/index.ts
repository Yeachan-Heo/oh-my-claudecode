/**
 * Empty Message Sanitizer Hook
 *
 * Sanitizes empty messages to prevent API errors.
 * According to the Anthropic API spec, all messages must have non-empty content
 * except for the optional final assistant message.
 *
 * This hook:
 * 1. Detects messages with no valid content (empty text or no parts)
 * 2. Injects placeholder text to prevent API errors
 * 3. Marks injected content as synthetic
 *
 * NOTE: This sanitizer would ideally run on a message transform hook that executes
 * AFTER all other message processing. In the shell hooks system, this should be
 * invoked at the last stage before messages are sent to the API.
 *
 * Adapted from oh-my-opencode's empty-message-sanitizer hook.
 */

import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import {
  PLACEHOLDER_TEXT,
  TOOL_PART_TYPES,
  HOOK_NAME,
  DEBUG_PREFIX,
} from './constants.js';
import type {
  MessagePart,
  MessageWithParts,
  EmptyMessageSanitizerInput,
  EmptyMessageSanitizerOutput,
  EmptyMessageSanitizerConfig,
} from './types.js';

const DEBUG = process.env.EMPTY_MESSAGE_SANITIZER_DEBUG === '1';
const DEBUG_FILE = path.join(tmpdir(), 'empty-message-sanitizer-debug.log');

function debugLog(...args: unknown[]): void {
  if (DEBUG) {
    const msg = `[${new Date().toISOString()}] ${DEBUG_PREFIX} ${args
      .map((a) => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)))
      .join(' ')}\n`;
    fs.appendFileSync(DEBUG_FILE, msg);
  }
}

/**
 * Check if a part has non-empty text content
 */
export function hasTextContent(part: MessagePart): boolean {
  if (part.type === 'text') {
    const text = part.text;
    return Boolean(text && text.trim().length > 0);
  }
  return false;
}

/**
 * Check if a part is a tool-related part
 */
export function isToolPart(part: MessagePart): boolean {
  return TOOL_PART_TYPES.has(part.type);
}

/**
 * Check if message parts contain valid content
 * Valid content = non-empty text OR tool parts
 */
export function hasValidContent(parts: MessagePart[]): boolean {
  return parts.some((part) => hasTextContent(part) || isToolPart(part));
}

/**
 * Sanitize a single message to ensure it has valid content
 */
export function sanitizeMessage(
  message: MessageWithParts,
  isLastMessage: boolean,
  placeholderText: string = PLACEHOLDER_TEXT
): boolean {
  const isAssistant = message.info.role === 'assistant';

  // Skip final assistant message (allowed to be empty per API spec)
  if (isLastMessage && isAssistant) {
    debugLog('skipping final assistant message');
    return false;
  }

  const parts = message.parts;

  // FIX: Removed `&& parts.length > 0` - empty arrays also need sanitization
  // When parts is [], the message has no content and would cause API error:
  // "all messages must have non-empty content except for the optional final assistant message"
  if (!hasValidContent(parts)) {
    debugLog(`sanitizing message ${message.info.id}: no valid content`);
    let injected = false;

    // Try to find an existing empty text part and replace its content
    for (const part of parts) {
      if (part.type === 'text') {
        if (!part.text || !part.text.trim()) {
          part.text = placeholderText;
          part.synthetic = true;
          injected = true;
          debugLog(`replaced empty text in existing part`);
          break;
        }
      }
    }

    // If no text part was found, inject a new one
    if (!injected) {
      const insertIndex = parts.findIndex((p) => isToolPart(p));

      const newPart: MessagePart = {
        id: `synthetic_${Date.now()}`,
        messageID: message.info.id,
        sessionID: message.info.sessionID ?? '',
        type: 'text',
        text: placeholderText,
        synthetic: true,
      };

      if (insertIndex === -1) {
        // No tool parts, append to end
        parts.push(newPart);
        debugLog(`appended synthetic text part`);
      } else {
        // Insert before first tool part
        parts.splice(insertIndex, 0, newPart);
        debugLog(`inserted synthetic text part before tool part`);
      }
    }

    return true;
  }

  // Also sanitize any empty text parts that exist alongside valid content
  let sanitized = false;
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text !== undefined && part.text.trim() === '') {
        part.text = placeholderText;
        part.synthetic = true;
        sanitized = true;
        debugLog(`sanitized empty text part in message ${message.info.id}`);
      }
    }
  }

  return sanitized;
}

/**
 * Sanitize all messages in the input
 */
export function sanitizeMessages(
  input: EmptyMessageSanitizerInput,
  config?: EmptyMessageSanitizerConfig
): EmptyMessageSanitizerOutput {
  const { messages } = input;
  const placeholderText = config?.placeholderText ?? PLACEHOLDER_TEXT;

  debugLog('sanitizing messages', { count: messages.length });

  let sanitizedCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const isLastMessage = i === messages.length - 1;

    const wasSanitized = sanitizeMessage(message, isLastMessage, placeholderText);
    if (wasSanitized) {
      sanitizedCount++;
    }
  }

  debugLog(`sanitized ${sanitizedCount} messages`);

  return {
    messages,
    sanitizedCount,
    modified: sanitizedCount > 0,
  };
}

/**
 * Create empty message sanitizer hook for Claude Code shell hooks
 *
 * This hook ensures all messages have valid content before being sent to the API.
 * It should be called at the last stage of message processing.
 */
export function createEmptyMessageSanitizerHook(config?: EmptyMessageSanitizerConfig) {
  debugLog('createEmptyMessageSanitizerHook called', { config });

  return {
    /**
     * Sanitize messages (called during message transform phase)
     */
    sanitize: (input: EmptyMessageSanitizerInput): EmptyMessageSanitizerOutput => {
      return sanitizeMessages(input, config);
    },

    /**
     * Get hook name
     */
    getName: (): string => {
      return HOOK_NAME;
    },
  };
}

// Re-export types
export type {
  MessagePart,
  MessageInfo,
  MessageWithParts,
  EmptyMessageSanitizerInput,
  EmptyMessageSanitizerOutput,
  EmptyMessageSanitizerConfig,
} from './types.js';

// Re-export constants
export {
  PLACEHOLDER_TEXT,
  TOOL_PART_TYPES,
  HOOK_NAME,
  DEBUG_PREFIX,
  ERROR_PATTERNS,
} from './constants.js';
