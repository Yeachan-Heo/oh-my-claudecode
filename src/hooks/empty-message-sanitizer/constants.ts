/**
 * Empty Message Sanitizer Constants
 *
 * Constants for the empty message sanitizer hook.
 *
 * Adapted from oh-my-opencode's empty-message-sanitizer hook.
 */

/**
 * Placeholder text injected for empty messages
 * This prevents API errors about empty content
 */
export const PLACEHOLDER_TEXT = '[user interrupted]';

/**
 * Tool-related part types that count as valid content
 */
export const TOOL_PART_TYPES = new Set([
  'tool',
  'tool_use',
  'tool_result',
]);

/**
 * Hook name identifier
 */
export const HOOK_NAME = 'empty-message-sanitizer';

/**
 * Debug log prefix
 */
export const DEBUG_PREFIX = '[empty-message-sanitizer]';

/**
 * Error message patterns for debugging
 */
export const ERROR_PATTERNS = {
  EMPTY_CONTENT: 'all messages must have non-empty content',
  EMPTY_TEXT: 'message contains empty text part',
  NO_VALID_PARTS: 'message has no valid content parts',
};
