import type { StatuslineStdin } from '../hud/types.js';
export interface ExtractedTokens {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    modelName: string;
    agentName?: string;
    isEstimated: boolean;
    timestamp: string;
}
export interface TokenDelta {
    inputDelta: number;
    cacheDelta: number;
    cacheReadDelta: number;
}
export interface TokenSnapshot {
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    timestamp: string;
}
/**
 * Extract token usage from StatuslineStdin and calculate delta from previous snapshot.
 */
export declare function extractTokens(stdin: StatuslineStdin, previousSnapshot: TokenSnapshot | null, modelName: string, agentName?: string): ExtractedTokens;
/**
 * Create current snapshot for next delta calculation.
 */
export declare function createSnapshot(stdin: StatuslineStdin): TokenSnapshot;
//# sourceMappingURL=token-extractor.d.ts.map