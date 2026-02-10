/**
 * TokScale Adapter Module
 *
 * Provides a centralized adapter for @tokscale/core with graceful fallback
 * when the native module is unavailable. This enables optional high-performance
 * token counting and pricing lookup while maintaining compatibility in all environments.
 */
import { ModelPricing } from './types.js';
/**
 * Interface for the tokscale adapter - wraps tokscale's native API
 */
export interface TokscaleAdapter {
    /** Whether tokscale native module is available */
    isAvailable: boolean;
    /** Get unified report from tokscale - wraps parseLocalSources + finalizeReport */
    getReport?: () => Promise<TokscaleReport>;
    /** Look up pricing for a model from tokscale's database */
    lookupPricing?: (modelName: string) => Promise<ModelPricing | null>;
    /** Version of the tokscale native module */
    version?: string;
}
/**
 * Unified report from tokscale
 */
export interface TokscaleReport {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheCreationTokens: number;
    totalCacheReadTokens: number;
    totalCost: number;
    totalEntries: number;
    byModel: Record<string, {
        tokens: number;
        cost: number;
    }>;
}
/**
 * Lazily loads and caches the tokscale adapter
 *
 * @returns Promise resolving to the adapter (either native or fallback)
 */
export declare function getTokscaleAdapter(): Promise<TokscaleAdapter>;
/**
 * Gets fallback pricing from the static PRICING table
 *
 * @param modelName - Model name to look up
 * @returns ModelPricing with fallback to Sonnet if unknown
 */
export declare function getFallbackPricing(modelName: string): ModelPricing;
/**
 * Looks up pricing for a model, preferring tokscale's database with fallback
 *
 * This function provides the best available pricing:
 * 1. If tokscale is available, uses its up-to-date pricing database
 * 2. Falls back to static PRICING table if tokscale unavailable or model not found
 *
 * @param modelName - Model name to look up pricing for
 * @returns Promise resolving to ModelPricing
 */
export declare function lookupPricingWithFallback(modelName: string): Promise<ModelPricing>;
/**
 * Checks if tokscale native module is currently available
 *
 * @returns Promise resolving to boolean indicating availability
 */
export declare function isTokscaleAvailable(): Promise<boolean>;
/**
 * Resets the adapter cache (useful for testing)
 */
export declare function resetAdapterCache(): void;
//# sourceMappingURL=tokscale-adapter.d.ts.map