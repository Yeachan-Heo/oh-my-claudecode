import { PRICING, ModelPricing, CostBreakdown } from './types.js';
import { lookupPricingWithFallback } from './tokscale-adapter.js';

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
export function calculateCost(input: CostInput): CostBreakdown {
  const pricing = getPricingForModel(input.modelName);

  // Base input cost
  const inputCost = (input.inputTokens / 1_000_000) * pricing.inputPerMillion;

  // Output cost
  const outputCost = (input.outputTokens / 1_000_000) * pricing.outputPerMillion;

  // Cache write cost (25% markup on input price)
  const cacheWriteCost = (input.cacheCreationTokens / 1_000_000) *
    pricing.inputPerMillion * (1 + pricing.cacheWriteMarkup);

  // Cache read cost (90% discount on input price)
  const cacheReadCost = (input.cacheReadTokens / 1_000_000) *
    pricing.inputPerMillion * (1 - pricing.cacheReadDiscount);

  const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;

  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost
  };
}

/**
 * Asynchronous cost calculation using live TokScale pricing.
 * Provides up-to-date pricing with fallback to hardcoded values.
 */
export async function calculateCostAsync(input: CostInput): Promise<CostBreakdown> {
  const pricing = await lookupPricingWithFallback(input.modelName);

  // Base input cost
  const inputCost = (input.inputTokens / 1_000_000) * pricing.inputPerMillion;

  // Output cost
  const outputCost = (input.outputTokens / 1_000_000) * pricing.outputPerMillion;

  // Cache write cost (25% markup on input price)
  const cacheWriteCost = (input.cacheCreationTokens / 1_000_000) *
    pricing.inputPerMillion * (1 + pricing.cacheWriteMarkup);

  // Cache read cost (90% discount on input price)
  const cacheReadCost = (input.cacheReadTokens / 1_000_000) *
    pricing.inputPerMillion * (1 - pricing.cacheReadDiscount);

  const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;

  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost
  };
}

/**
 * Batch cost calculation with efficient pricing lookup.
 * Fetches pricing once per unique model for better performance.
 */
export async function batchCalculateCost(inputs: CostInput[]): Promise<CostBreakdown[]> {
  // Get all unique models first
  const models = [...new Set(inputs.map(i => i.modelName))];
  const pricingMap = new Map<string, ModelPricing>();

  // Fetch pricing for all unique models
  for (const model of models) {
    pricingMap.set(model, await lookupPricingWithFallback(model));
  }

  // Calculate costs using cached pricing
  return inputs.map(input => {
    const pricing = pricingMap.get(input.modelName)!;

    // Base input cost
    const inputCost = (input.inputTokens / 1_000_000) * pricing.inputPerMillion;

    // Output cost
    const outputCost = (input.outputTokens / 1_000_000) * pricing.outputPerMillion;

    // Cache write cost (25% markup on input price)
    const cacheWriteCost = (input.cacheCreationTokens / 1_000_000) *
      pricing.inputPerMillion * (1 + pricing.cacheWriteMarkup);

    // Cache read cost (90% discount on input price)
    const cacheReadCost = (input.cacheReadTokens / 1_000_000) *
      pricing.inputPerMillion * (1 - pricing.cacheReadDiscount);

    const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;

    return {
      inputCost,
      outputCost,
      cacheWriteCost,
      cacheReadCost,
      totalCost
    };
  });
}

function getPricingForModel(modelName: string): ModelPricing {
  // Normalize model name
  const normalized = normalizeModelName(modelName);

  if (PRICING[normalized]) {
    return PRICING[normalized];
  }

  // Default to Sonnet if unknown
  console.warn(`Unknown model: ${modelName}, defaulting to Sonnet pricing`);
  return PRICING['claude-sonnet-4.5'];
}

export function normalizeModelName(modelName: string): string {
  // Handle various model name formats
  const lower = modelName.toLowerCase();

  if (lower.includes('haiku')) return 'claude-haiku-4';
  if (lower.includes('sonnet')) return 'claude-sonnet-4.5';
  if (lower.includes('opus')) return 'claude-opus-4.6';

  // Check exact matches
  if (PRICING[modelName]) return modelName;

  // Default
  return 'claude-sonnet-4.5';
}

export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${(cost * 100).toFixed(4)}¢`;
  }
  return `$${cost.toFixed(4)}`;
}

export function getCostColor(cost: number): 'green' | 'yellow' | 'red' {
  if (cost < 1.0) return 'green';
  if (cost < 5.0) return 'yellow';
  return 'red';
}

export function estimateDailyCost(tokensPerHour: number, modelName: string): number {
  const pricing = getPricingForModel(modelName);
  const tokensPerDay = tokensPerHour * 24;
  const costPerDay = (tokensPerDay / 1_000_000) * pricing.inputPerMillion;
  return costPerDay;
}

export function estimateMonthlyCost(tokensPerHour: number, modelName: string): number {
  return estimateDailyCost(tokensPerHour, modelName) * 30;
}
