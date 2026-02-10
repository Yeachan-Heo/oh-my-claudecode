import { CostBreakdown } from './types.js';
export interface CostInput {
    modelName: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
}
/**
 * Synchronous cost calculation using hardcoded pricing.
 * Fast path for HUD and sync operations that need instant response.
 */
export declare function calculateCost(input: CostInput): CostBreakdown;
/**
 * Asynchronous cost calculation using live TokScale pricing.
 * Provides up-to-date pricing with fallback to hardcoded values.
 */
export declare function calculateCostAsync(input: CostInput): Promise<CostBreakdown>;
/**
 * Batch cost calculation with efficient pricing lookup.
 * Fetches pricing once per unique model for better performance.
 */
export declare function batchCalculateCost(inputs: CostInput[]): Promise<CostBreakdown[]>;
export declare function normalizeModelName(modelName: string): string;
export declare function formatCost(cost: number): string;
export declare function getCostColor(cost: number): 'green' | 'yellow' | 'red';
export declare function estimateDailyCost(tokensPerHour: number, modelName: string): number;
export declare function estimateMonthlyCost(tokensPerHour: number, modelName: string): number;
//# sourceMappingURL=cost-estimator.d.ts.map