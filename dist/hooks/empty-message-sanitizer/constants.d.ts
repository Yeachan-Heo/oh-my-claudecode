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
export declare const PLACEHOLDER_TEXT = "[user interrupted]";
/**
 * Tool-related part types that count as valid content
 */
export declare const TOOL_PART_TYPES: Set<string>;
/**
 * Hook name identifier
 */
export declare const HOOK_NAME = "empty-message-sanitizer";
/**
 * Debug log prefix
 */
export declare const DEBUG_PREFIX = "[empty-message-sanitizer]";
/**
 * Error message patterns for debugging
 */
export declare const ERROR_PATTERNS: {
    EMPTY_CONTENT: string;
    EMPTY_TEXT: string;
    NO_VALID_PARTS: string;
};
//# sourceMappingURL=constants.d.ts.map