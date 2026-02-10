/**
 * Unified Recovery Constants
 *
 * Constants, messages, and patterns for all recovery mechanisms.
 */
export declare const CLAUDE_CODE_STORAGE: string;
export declare const MESSAGE_STORAGE: string;
export declare const PART_STORAGE: string;
/**
 * Debug logging configuration
 */
export declare const DEBUG: boolean;
export declare const DEBUG_FILE: string;
/**
 * Part type sets for categorization
 */
export declare const THINKING_TYPES: Set<string>;
export declare const META_TYPES: Set<string>;
export declare const CONTENT_TYPES: Set<string>;
/**
 * Placeholder text for empty content
 */
export declare const PLACEHOLDER_TEXT = "[user interrupted]";
/**
 * ============================================================================
 * CONTEXT WINDOW LIMIT RECOVERY
 * ============================================================================
 */
/**
 * Recovery message when context window limit is hit
 */
export declare const CONTEXT_LIMIT_RECOVERY_MESSAGE = "CONTEXT WINDOW LIMIT REACHED - IMMEDIATE ACTION REQUIRED\n\nThe conversation has exceeded the model's context window limit. To continue working effectively, you must take one of these actions:\n\n1. SUMMARIZE THE CONVERSATION\n   - Use the /compact command if available\n   - Or provide a concise summary of what has been accomplished so far\n   - Include key decisions, code changes, and remaining tasks\n\n2. START A FRESH CONTEXT\n   - If summarization isn't sufficient, suggest starting a new session\n   - Provide a handoff message with essential context\n\n3. REDUCE OUTPUT SIZE\n   - When showing code, show only relevant portions\n   - Use file paths and line numbers instead of full code blocks\n   - Be more concise in explanations\n\nIMPORTANT: Do not attempt to continue without addressing this limit.\nThe API will reject further requests until the context is reduced.\n\nCurrent Status:\n- Context limit exceeded\n- Further API calls will fail until context is reduced\n- Action required before continuing\n";
/**
 * Short notification for context limit
 */
export declare const CONTEXT_LIMIT_SHORT_MESSAGE = "Context window limit reached. Please use /compact to summarize the conversation or start a new session.";
/**
 * Recovery message for non-empty content errors
 */
export declare const NON_EMPTY_CONTENT_RECOVERY_MESSAGE = "API ERROR: Non-empty content validation failed.\n\nThis error typically occurs when:\n- A message has empty text content\n- The conversation structure is invalid\n\nSuggested actions:\n1. Continue with a new message\n2. If the error persists, start a new session\n\nThe system will attempt automatic recovery.\n";
/**
 * Recovery message when truncation was applied
 */
export declare const TRUNCATION_APPLIED_MESSAGE = "CONTEXT OPTIMIZATION APPLIED\n\nSome tool outputs have been truncated to fit within the context window.\nThe conversation can now continue normally.\n\nIf you need to see the full output of a previous tool call, you can:\n- Re-run the specific command\n- Ask to see a particular file or section\n\nContinuing with the current task...\n";
/**
 * Message when recovery fails
 */
export declare const RECOVERY_FAILED_MESSAGE = "CONTEXT RECOVERY FAILED\n\nAll automatic recovery attempts have been exhausted.\nPlease start a new session to continue.\n\nBefore starting a new session:\n1. Note what has been accomplished\n2. Save any important code changes\n3. Document the current state of the task\n\nYou can copy this conversation summary to continue in a new session.\n";
/**
 * Patterns to extract token counts from error messages
 */
export declare const TOKEN_LIMIT_PATTERNS: RegExp[];
/**
 * Keywords indicating token limit errors
 */
export declare const TOKEN_LIMIT_KEYWORDS: string[];
/**
 * ============================================================================
 * EDIT ERROR RECOVERY
 * ============================================================================
 */
/**
 * Known Edit tool error patterns that indicate the AI made a mistake
 */
export declare const EDIT_ERROR_PATTERNS: readonly ["oldString and newString must be different", "oldString not found", "oldString found multiple times", "old_string not found", "old_string and new_string must be different"];
/**
 * System reminder injected when Edit tool fails due to AI mistake
 * Short, direct, and commanding - forces immediate corrective action
 */
export declare const EDIT_ERROR_REMINDER = "\n[EDIT ERROR - IMMEDIATE ACTION REQUIRED]\n\nYou made an Edit mistake. STOP and do this NOW:\n\n1. READ the file immediately to see its ACTUAL current state\n2. VERIFY what the content really looks like (your assumption was wrong)\n3. APOLOGIZE briefly to the user for the error\n4. CONTINUE with corrected action based on the real file content\n\nDO NOT attempt another edit until you've read and verified the file state.\n";
/**
 * ============================================================================
 * SESSION RECOVERY
 * ============================================================================
 */
/**
 * Recovery messages for different error types
 */
export declare const RECOVERY_MESSAGES: {
    readonly tool_result_missing: {
        readonly title: "Tool Crash Recovery";
        readonly message: "Injecting cancelled tool results...";
    };
    readonly thinking_block_order: {
        readonly title: "Thinking Block Recovery";
        readonly message: "Fixing message structure...";
    };
    readonly thinking_disabled_violation: {
        readonly title: "Thinking Strip Recovery";
        readonly message: "Stripping thinking blocks...";
    };
    readonly empty_content: {
        readonly title: "Empty Content Recovery";
        readonly message: "Adding placeholder content...";
    };
    readonly context_window_limit: {
        readonly title: "Context Window Limit";
        readonly message: "Context limit reached - recovery required";
    };
    readonly edit_error: {
        readonly title: "Edit Error";
        readonly message: "Edit operation failed - corrective action needed";
    };
};
/**
 * Recovery error patterns
 */
export declare const ERROR_PATTERNS: {
    readonly tool_result_missing: readonly ["tool_use", "tool_result"];
    readonly thinking_block_order: readonly ["thinking", "first block", "must start with", "preceeding", "final block", "cannot be thinking"];
    readonly thinking_disabled_violation: readonly ["thinking is disabled", "cannot contain"];
    readonly empty_content: readonly ["empty", "content", "message"];
};
//# sourceMappingURL=constants.d.ts.map