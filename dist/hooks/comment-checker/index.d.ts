/**
 * Comment Checker Hook
 *
 * Detects comments and docstrings in code changes and prompts Claude
 * to justify or remove unnecessary comments.
 *
 * Adapted from oh-my-opencode's comment-checker hook.
 * Instead of using an external CLI binary, this implementation does
 * comment detection directly in TypeScript.
 */
import type { CommentCheckResult } from './types.js';
/**
 * Check content for comments
 */
export declare function checkForComments(filePath: string, content?: string, oldString?: string, newString?: string, edits?: Array<{
    old_string: string;
    new_string: string;
}>): CommentCheckResult;
/**
 * Configuration for comment checker hook
 */
export interface CommentCheckerConfig {
    /** Custom prompt to append instead of default */
    customPrompt?: string;
    /** Whether to enable the hook */
    enabled?: boolean;
}
/**
 * Create comment checker hook for Claude Code shell hooks
 *
 * This hook checks for comments in Write/Edit operations and injects
 * a message prompting Claude to justify or remove unnecessary comments.
 */
export declare function createCommentCheckerHook(config?: CommentCheckerConfig): {
    /**
     * PreToolUse - Track pending write/edit calls
     */
    preToolUse: (input: {
        tool_name: string;
        session_id: string;
        tool_input: Record<string, unknown>;
    }) => {
        decision: string;
    } | null;
    /**
     * PostToolUse - Check for comments after successful write/edit
     */
    postToolUse: (input: {
        tool_name: string;
        session_id: string;
        tool_input: Record<string, unknown>;
        tool_response?: string;
    }) => string | null;
};
export type { CommentInfo, CommentCheckResult, PendingCall } from './types.js';
export { applyFilters } from './filters.js';
export { BDD_KEYWORDS, TYPE_CHECKER_PREFIXES, HOOK_MESSAGE_HEADER, LINE_COMMENT_PATTERNS, EXTENSION_TO_LANGUAGE, } from './constants.js';
//# sourceMappingURL=index.d.ts.map