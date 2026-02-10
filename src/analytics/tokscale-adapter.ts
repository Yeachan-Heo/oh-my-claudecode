/**
 * TokScale Adapter Module
 *
 * Provides a centralized adapter for @tokscale/core with graceful fallback
 * when the native module is unavailable. This enables optional high-performance
 * token counting and pricing lookup while maintaining compatibility in all environments.
 */

import { ModelPricing, PRICING } from './types.js';

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
  byModel: Record<string, { tokens: number; cost: number }>;
}

/**
 * Fallback adapter when tokscale is not available
 */
const FALLBACK_ADAPTER: TokscaleAdapter = {
  isAvailable: false
};

/** Cached adapter instance */
let cachedAdapter: TokscaleAdapter | null = null;

/** Whether we've already attempted to load tokscale */
let loadAttempted = false;

/**
 * Lazily loads and caches the tokscale adapter
 *
 * @returns Promise resolving to the adapter (either native or fallback)
 */
export async function getTokscaleAdapter(): Promise<TokscaleAdapter> {
  // Return cached adapter if available
  if (cachedAdapter !== null) {
    return cachedAdapter;
  }

  // Return fallback if we already tried and failed
  if (loadAttempted) {
    return FALLBACK_ADAPTER;
  }

  loadAttempted = true;

  try {
    // Suppress tokscale internal warnings during import/initialization
    // These warnings come from tokscale's model provider parsing and spam the CLI output
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = args[0];
      if (typeof msg === 'string' && msg.startsWith('[tokscale]')) {
        return; // Suppress tokscale internal warnings
      }
      originalWarn.apply(console, args);
    };

    let tokscale: any;
    try {
      // Dynamic import of @tokscale/core
      tokscale = await import('@tokscale/core') as any;

      // Verify native module is functional via health check
      // Note: healthCheck returns a string "tokscale-core is healthy!" when working
      if (typeof tokscale.healthCheck === 'function') {
        const health = tokscale.healthCheck();
        // String response means healthy, non-string or falsy means unhealthy
        if (!health || (typeof health === 'object' && !health.nativeAvailable)) {
          console.warn('[tokscale-adapter] Native module not available, using fallback');
          cachedAdapter = FALLBACK_ADAPTER;
          return cachedAdapter;
        }
      }
    } finally {
      // Always restore original console.warn
      console.warn = originalWarn;
    }

    // Helper to convert tokscale's entries array to our byModel format
    const convertEntriesToByModel = (entries: any[]): Record<string, { tokens: number; cost: number }> => {
      const result: Record<string, { tokens: number; cost: number }> = {};
      if (!entries || !Array.isArray(entries)) {
        return result;
      }

      for (const entry of entries) {
        const modelName = entry.model ?? 'unknown';
        result[modelName] = {
          tokens: (entry.input ?? 0) + (entry.output ?? 0),
          cost: entry.cost ?? 0
        };
      }

      return result;
    };

    // Build adapter with wrapped functions matching tokscale's actual API
    cachedAdapter = {
      isAvailable: true,
      version: (typeof tokscale.version === 'function' ? tokscale.version() : tokscale.version) ?? 'unknown',

      getReport: async () => {
        try {
          // Use getModelReport which is the high-level API that works
          const report = await tokscale.getModelReport({ sources: ['claude'] });

          // Convert tokscale ModelReport to our TokscaleReport
          // Field mapping: totalInput -> totalInputTokens, totalOutput -> totalOutputTokens, etc.
          return {
            totalInputTokens: report.totalInput ?? 0,
            totalOutputTokens: report.totalOutput ?? 0,
            totalCacheCreationTokens: report.totalCacheWrite ?? 0,
            totalCacheReadTokens: report.totalCacheRead ?? 0,
            totalCost: report.totalCost ?? 0,
            totalEntries: report.totalMessages ?? 0,
            byModel: convertEntriesToByModel(report.entries ?? [])
          };
        } catch (error) {
          console.warn('[tokscale-adapter] getReport failed:', error instanceof Error ? error.message : String(error));
          throw error;
        }
      },

      lookupPricing: async (modelName: string) => {
        try {
          const result = await tokscale.lookupPricing(modelName);
          if (result && result.pricing) {
            const pricing = result.pricing;
            // Convert per-token costs to per-million costs
            const inputPerMillion = (pricing.inputCostPerToken ?? 0) * 1_000_000;
            const outputPerMillion = (pricing.outputCostPerToken ?? 0) * 1_000_000;

            // Calculate cache multipliers from absolute costs
            // cacheWriteMarkup: ratio of cache creation cost to input cost
            // cacheReadDiscount: 1 - (cache read cost / input cost)
            const cacheWriteMarkup = pricing.inputCostPerToken > 0
              ? (pricing.cacheCreationInputTokenCost ?? pricing.inputCostPerToken * 1.25) / pricing.inputCostPerToken - 1
              : 0.25;
            const cacheReadDiscount = pricing.inputCostPerToken > 0
              ? 1 - (pricing.cacheReadInputTokenCost ?? pricing.inputCostPerToken * 0.1) / pricing.inputCostPerToken
              : 0.9;

            return {
              inputPerMillion,
              outputPerMillion,
              cacheWriteMarkup,
              cacheReadDiscount
            };
          }
          return null;
        } catch (error) {
          console.warn('[tokscale-adapter] lookupPricing failed for', modelName, ':', error instanceof Error ? error.message : String(error));
          return null;
        }
      }
    } as TokscaleAdapter;

    return cachedAdapter!;
  } catch (error) {
    // Expected when @tokscale/core is not installed
    const message = error instanceof Error ? error.message : String(error);

    // Only log if it's not a simple "module not found" error
    if (!message.includes('Cannot find module') && !message.includes('MODULE_NOT_FOUND')) {
      console.warn(`[tokscale-adapter] Failed to load: ${message}`);
    }

    cachedAdapter = FALLBACK_ADAPTER;
    return cachedAdapter;
  }
}

/**
 * Normalizes a model name to match our pricing keys
 *
 * @param modelName - Raw model name from transcript
 * @returns Normalized model key
 */
function normalizeModelName(modelName: string): string {
  const lower = modelName.toLowerCase();

  if (lower.includes('haiku')) return 'claude-haiku-4';
  if (lower.includes('sonnet')) return 'claude-sonnet-4.5';
  if (lower.includes('opus')) return 'claude-opus-4.6';

  // Check exact matches
  if (PRICING[modelName]) return modelName;

  // Default
  return 'claude-sonnet-4.5';
}

/**
 * Gets fallback pricing from the static PRICING table
 *
 * @param modelName - Model name to look up
 * @returns ModelPricing with fallback to Sonnet if unknown
 */
export function getFallbackPricing(modelName: string): ModelPricing {
  const normalized = normalizeModelName(modelName);
  return PRICING[normalized] ?? PRICING['claude-sonnet-4.5'];
}

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
export async function lookupPricingWithFallback(modelName: string): Promise<ModelPricing> {
  const adapter = await getTokscaleAdapter();

  // Try tokscale lookup first if available
  if (adapter.isAvailable && adapter.lookupPricing) {
    try {
      const pricing = await adapter.lookupPricing(modelName);
      if (pricing !== null) {
        return pricing;
      }
    } catch {
      // Silently fall through to fallback
    }
  }

  // Use static fallback pricing
  return getFallbackPricing(modelName);
}

/**
 * Checks if tokscale native module is currently available
 *
 * @returns Promise resolving to boolean indicating availability
 */
export async function isTokscaleAvailable(): Promise<boolean> {
  const adapter = await getTokscaleAdapter();
  return adapter.isAvailable;
}

/**
 * Resets the adapter cache (useful for testing)
 */
export function resetAdapterCache(): void {
  cachedAdapter = null;
  loadAttempted = false;
}
