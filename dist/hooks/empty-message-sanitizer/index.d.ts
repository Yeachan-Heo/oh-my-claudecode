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
import type { MessagePart, MessageWithParts, EmptyMessageSanitizerInput, EmptyMessageSanitizerOutput, EmptyMessageSanitizerConfig } from './types.js';
/**
 * Check if a part has non-empty text content
 */
export declare function hasTextContent(part: MessagePart): boolean;
/**
 * Check if a part is a tool-related part
 */
export declare function isToolPart(part: MessagePart): boolean;
/**
 * Check if message parts contain valid content
 * Valid content = non-empty text OR tool parts
 */
export declare function hasValidContent(parts: MessagePart[]): boolean;
/**
 * Sanitize a single message to ensure it has valid content
 */
export declare function sanitizeMessage(message: MessageWithParts, isLastMessage: boolean, placeholderText?: string): boolean;
/**
 * Sanitize all messages in the input
 */
export declare function sanitizeMessages(input: EmptyMessageSanitizerInput, config?: EmptyMessageSanitizerConfig): EmptyMessageSanitizerOutput;
/**
 * Create empty message sanitizer hook for Claude Code shell hooks
 *
 * This hook ensures all messages have valid content before being sent to the API.
 * It should be called at the last stage of message processing.
 */
export declare function createEmptyMessageSanitizerHook(config?: EmptyMessageSanitizerConfig): {
    /**
     * Sanitize messages (called during message transform phase)
     */
    sanitize: (input: EmptyMessageSanitizerInput) => EmptyMessageSanitizerOutput;
    /**
     * Get hook name
     */
    getName: () => string;
};
export type { MessagePart, MessageInfo, MessageWithParts, EmptyMessageSanitizerInput, EmptyMessageSanitizerOutput, EmptyMessageSanitizerConfig, } from './types.js';
export { PLACEHOLDER_TEXT, TOOL_PART_TYPES, HOOK_NAME, DEBUG_PREFIX, ERROR_PATTERNS, } from './constants.js';
//# sourceMappingURL=index.d.ts.map