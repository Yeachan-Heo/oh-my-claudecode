/**
 * Model-specific output token estimation based on input tokens.
 *
 * Ratios based on empirical observation:
 * - Haiku: 30% (concise responses)
 * - Sonnet: 40% (balanced responses)
 * - Opus: 50% (detailed reasoning)
 */
import * as crypto from 'crypto';
const MODEL_OUTPUT_RATIOS = {
    'haiku': 0.30,
    'sonnet': 0.40,
    'opus': 0.50
};
const DEFAULT_RATIO = 0.40; // Sonnet baseline
/**
 * Estimate output tokens from input tokens using model-specific ratios.
 *
 * @param inputTokens - Number of input tokens consumed
 * @param modelName - Model name (e.g., "claude-sonnet-4.5")
 * @returns Estimated output tokens (rounded to nearest integer)
 */
export function estimateOutputTokens(inputTokens, modelName) {
    if (inputTokens === 0)
        return 0;
    const ratio = detectModelRatio(modelName);
    return Math.round(inputTokens * ratio);
}
/**
 * Extract session ID from transcript path.
 *
 * Pattern: /path/to/.claude/projects/{sessionId}/transcript.jsonl
 *
 * @param transcriptPath - Full path to transcript file
 * @returns Session ID (extracted or hashed)
 */
export function extractSessionId(transcriptPath) {
    // Guard against null/undefined/empty
    if (!transcriptPath) {
        return crypto.createHash('md5').update('unknown').digest('hex').slice(0, 16);
    }
    // Try to extract from path pattern
    const match = transcriptPath.match(/projects\/([a-f0-9]{8,})/i);
    if (match) {
        return match[1];
    }
    // Fallback: hash the path
    return crypto.createHash('md5')
        .update(transcriptPath)
        .digest('hex')
        .slice(0, 16);
}
/**
 * Detect model tier and return appropriate output ratio.
 */
function detectModelRatio(modelName) {
    const normalized = modelName.toLowerCase();
    for (const [tier, ratio] of Object.entries(MODEL_OUTPUT_RATIOS)) {
        if (normalized.includes(tier)) {
            return ratio;
        }
    }
    return DEFAULT_RATIO;
}
//# sourceMappingURL=output-estimator.js.map