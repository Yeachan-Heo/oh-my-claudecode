/**
 * Preemptive Compaction Constants
 *
 * Thresholds and messages for context usage monitoring.
 *
 * Adapted from oh-my-opencode's preemptive-compaction hook.
 */
/**
 * Default threshold ratio to trigger warning (85%)
 */
export declare const DEFAULT_THRESHOLD = 0.85;
/**
 * Critical threshold ratio (95%)
 */
export declare const CRITICAL_THRESHOLD = 0.95;
/**
 * Minimum tokens before considering compaction
 */
export declare const MIN_TOKENS_FOR_COMPACTION = 50000;
/**
 * Cooldown period between compaction warnings (1 minute)
 */
export declare const COMPACTION_COOLDOWN_MS = 60000;
/**
 * Maximum warnings per session before stopping
 */
export declare const MAX_WARNINGS = 3;
/**
 * Default context limits for Claude models
 */
export declare const CLAUDE_DEFAULT_CONTEXT_LIMIT: number;
/**
 * Average characters per token estimate
 */
export declare const CHARS_PER_TOKEN = 4;
/**
 * Warning message when context usage is high
 */
export declare const CONTEXT_WARNING_MESSAGE = "CONTEXT WINDOW WARNING - APPROACHING LIMIT\n\nYour context usage is getting high. Consider these actions to prevent hitting the limit:\n\n1. USE COMPACT COMMAND\n   - Run /compact to summarize the conversation\n   - This frees up context space while preserving important information\n\n2. BE MORE CONCISE\n   - Show only relevant code portions\n   - Use file paths instead of full code blocks\n   - Summarize instead of repeating information\n\n3. FOCUS YOUR REQUESTS\n   - Work on one task at a time\n   - Complete current tasks before starting new ones\n   - Avoid unnecessary back-and-forth\n\nCurrent Status: Context usage is high but recoverable.\nAction recommended: Use /compact when convenient.\n";
/**
 * Critical warning message when context is almost full
 */
export declare const CONTEXT_CRITICAL_MESSAGE = "CRITICAL: CONTEXT WINDOW ALMOST FULL\n\nYour context usage is critically high. Immediate action required:\n\n1. COMPACT NOW\n   - Run /compact immediately to summarize the conversation\n   - Without compaction, the next few messages may fail\n\n2. AVOID LARGE OUTPUTS\n   - Do not show full files\n   - Use summaries instead of detailed outputs\n   - Be as concise as possible\n\n3. PREPARE FOR SESSION HANDOFF\n   - If compaction doesn't help enough, prepare to continue in a new session\n   - Note your current progress and next steps\n\nWARNING: Further messages may fail if context is not reduced.\nAction required: Run /compact now.\n";
/**
 * Message when compaction was successful
 */
export declare const COMPACTION_SUCCESS_MESSAGE = "Context compacted successfully. Session can continue normally.";
//# sourceMappingURL=constants.d.ts.map