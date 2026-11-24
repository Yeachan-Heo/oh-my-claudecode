/**
 * Unified Recovery Types
 *
 * Type definitions for all recovery mechanisms in Claude Code.
 */
/**
 * Configuration for retry behavior
 */
export const RETRY_CONFIG = {
    /** Maximum retry attempts */
    maxAttempts: 2,
    /** Initial delay between retries in ms */
    initialDelayMs: 2000,
    /** Backoff factor for exponential backoff */
    backoffFactor: 2,
    /** Maximum delay between retries in ms */
    maxDelayMs: 30000,
};
/**
 * Configuration for truncation behavior
 */
export const TRUNCATE_CONFIG = {
    /** Maximum truncation attempts */
    maxTruncateAttempts: 20,
    /** Minimum output size (chars) to attempt truncation */
    minOutputSizeToTruncate: 500,
    /** Target token ratio after truncation */
    targetTokenRatio: 0.5,
    /** Average characters per token estimate */
    charsPerToken: 4,
};
//# sourceMappingURL=types.js.map