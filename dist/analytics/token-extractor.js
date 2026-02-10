import { estimateOutputTokens } from './output-estimator.js';
/**
 * Extract token usage from StatuslineStdin and calculate delta from previous snapshot.
 */
export function extractTokens(stdin, previousSnapshot, modelName, agentName) {
    const currentUsage = stdin.context_window?.current_usage;
    if (!currentUsage) {
        return createEmptyExtraction(modelName, agentName);
    }
    // Calculate deltas
    const inputDelta = previousSnapshot
        ? currentUsage.input_tokens - previousSnapshot.inputTokens
        : currentUsage.input_tokens;
    const cacheDelta = previousSnapshot
        ? currentUsage.cache_creation_input_tokens - previousSnapshot.cacheCreationTokens
        : currentUsage.cache_creation_input_tokens;
    const cacheReadDelta = previousSnapshot
        ? currentUsage.cache_read_input_tokens - previousSnapshot.cacheReadTokens
        : currentUsage.cache_read_input_tokens;
    // Estimate output tokens (from output-estimator.ts)
    const outputTokens = estimateOutputTokens(inputDelta, modelName);
    return {
        inputTokens: Math.max(0, inputDelta),
        outputTokens,
        cacheCreationTokens: Math.max(0, cacheDelta),
        cacheReadTokens: Math.max(0, cacheReadDelta),
        modelName,
        agentName,
        isEstimated: true,
        timestamp: new Date().toISOString()
    };
}
/**
 * Create current snapshot for next delta calculation.
 */
export function createSnapshot(stdin) {
    const usage = stdin.context_window?.current_usage;
    return {
        inputTokens: usage?.input_tokens ?? 0,
        cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
        timestamp: new Date().toISOString()
    };
}
function createEmptyExtraction(modelName, agentName) {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        modelName,
        agentName,
        isEstimated: true,
        timestamp: new Date().toISOString()
    };
}
//# sourceMappingURL=token-extractor.js.map