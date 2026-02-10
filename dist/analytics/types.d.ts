/**
 * Transcript entry from .claude session logs
 */
export interface TranscriptEntry {
    type: string;
    timestamp: string;
    sessionId: string;
    agentId?: string;
    slug?: string;
    message?: {
        model?: string;
        role?: string;
        usage?: {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation?: {
                ephemeral_5m_input_tokens?: number;
                ephemeral_1h_input_tokens?: number;
            };
        };
        content?: Array<{
            type: string;
            name?: string;
            input?: {
                subagent_type?: string;
                model?: string;
            };
        }>;
    };
    data?: {
        message?: {
            message?: {
                model?: string;
                usage?: {
                    input_tokens: number;
                    output_tokens: number;
                    cache_creation_input_tokens?: number;
                    cache_read_input_tokens?: number;
                };
            };
        };
    };
}
export interface TokenUsage {
    timestamp: string;
    sessionId: string;
    agentName?: string;
    modelName: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    isEstimated?: boolean;
}
export interface CostBreakdown {
    inputCost: number;
    outputCost: number;
    cacheWriteCost: number;
    cacheReadCost: number;
    totalCost: number;
}
export interface SessionTokenStats {
    sessionId: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheCreation: number;
    totalCacheRead: number;
    totalCost: number;
    byAgent: Record<string, TokenUsage[]>;
    byModel: Record<string, TokenUsage[]>;
    startTime: string;
    lastUpdate: string;
}
export interface ModelPricing {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheWriteMarkup: number;
    cacheReadDiscount: number;
}
export interface AggregateTokenStats {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheCreation: number;
    totalCacheRead: number;
    totalCost: number;
    byAgent: Record<string, {
        tokens: number;
        cost: number;
    }>;
    byModel: Record<string, {
        tokens: number;
        cost: number;
    }>;
    sessionCount: number;
    entryCount: number;
    firstEntry: string | null;
    lastEntry: string | null;
}
/**
 * Pricing result that indicates the source of pricing data
 */
export interface TokscalePricingResult {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
    cacheWriteMarkup: number;
    cacheReadDiscount: number;
    source: 'tokscale' | 'fallback';
}
/**
 * Fallback pricing when @tokscale/core is unavailable.
 * Prefer lookupPricingWithFallback() from tokscale-adapter.ts for live pricing.
 * @deprecated Use tokscale-adapter.ts lookupPricingWithFallback() instead
 */
export declare const PRICING: Record<string, ModelPricing>;
//# sourceMappingURL=types.d.ts.map