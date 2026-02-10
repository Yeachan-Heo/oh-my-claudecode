/**
 * Model-specific output token estimation based on input tokens.
 *
 * Ratios based on empirical observation:
 * - Haiku: 30% (concise responses)
 * - Sonnet: 40% (balanced responses)
 * - Opus: 50% (detailed reasoning)
 */
/**
 * Estimate output tokens from input tokens using model-specific ratios.
 *
 * @param inputTokens - Number of input tokens consumed
 * @param modelName - Model name (e.g., "claude-sonnet-4.5")
 * @returns Estimated output tokens (rounded to nearest integer)
 */
export declare function estimateOutputTokens(inputTokens: number, modelName: string): number;
/**
 * Extract session ID from transcript path.
 *
 * Pattern: /path/to/.claude/projects/{sessionId}/transcript.jsonl
 *
 * @param transcriptPath - Full path to transcript file
 * @returns Session ID (extracted or hashed)
 */
export declare function extractSessionId(transcriptPath: string): string;
//# sourceMappingURL=output-estimator.d.ts.map