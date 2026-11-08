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
export const DEFAULT_THRESHOLD = 0.85;

/**
 * Critical threshold ratio (95%)
 */
export const CRITICAL_THRESHOLD = 0.95;

/**
 * Minimum tokens before considering compaction
 */
export const MIN_TOKENS_FOR_COMPACTION = 50_000;

/**
 * Cooldown period between compaction warnings (1 minute)
 */
export const COMPACTION_COOLDOWN_MS = 60_000;

/**
 * Maximum warnings per session before stopping
 */
export const MAX_WARNINGS = 3;

/**
 * Default context limits for Claude models
 */
export const CLAUDE_DEFAULT_CONTEXT_LIMIT =
  process.env.ANTHROPIC_1M_CONTEXT === 'true' ||
  process.env.VERTEX_ANTHROPIC_1M_CONTEXT === 'true'
    ? 1_000_000
    : 200_000;

/**
 * Average characters per token estimate
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Warning message when context usage is high
 */
export const CONTEXT_WARNING_MESSAGE = `CONTEXT WINDOW WARNING - APPROACHING LIMIT

Your context usage is getting high. Consider these actions to prevent hitting the limit:

1. USE COMPACT COMMAND
   - Run /compact to summarize the conversation
   - This frees up context space while preserving important information

2. BE MORE CONCISE
   - Show only relevant code portions
   - Use file paths instead of full code blocks
   - Summarize instead of repeating information

3. FOCUS YOUR REQUESTS
   - Work on one task at a time
   - Complete current tasks before starting new ones
   - Avoid unnecessary back-and-forth

Current Status: Context usage is high but recoverable.
Action recommended: Use /compact when convenient.
`;

/**
 * Critical warning message when context is almost full
 */
export const CONTEXT_CRITICAL_MESSAGE = `CRITICAL: CONTEXT WINDOW ALMOST FULL

Your context usage is critically high. Immediate action required:

1. COMPACT NOW
   - Run /compact immediately to summarize the conversation
   - Without compaction, the next few messages may fail

2. AVOID LARGE OUTPUTS
   - Do not show full files
   - Use summaries instead of detailed outputs
   - Be as concise as possible

3. PREPARE FOR SESSION HANDOFF
   - If compaction doesn't help enough, prepare to continue in a new session
   - Note your current progress and next steps

WARNING: Further messages may fail if context is not reduced.
Action required: Run /compact now.
`;

/**
 * Message when compaction was successful
 */
export const COMPACTION_SUCCESS_MESSAGE = `Context compacted successfully. Session can continue normally.`;
