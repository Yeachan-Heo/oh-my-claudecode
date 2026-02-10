/**
 * Fallback pricing when @tokscale/core is unavailable.
 * Prefer lookupPricingWithFallback() from tokscale-adapter.ts for live pricing.
 * @deprecated Use tokscale-adapter.ts lookupPricingWithFallback() instead
 */
export const PRICING = {
    'claude-haiku-4': {
        inputPerMillion: 0.80,
        outputPerMillion: 4.00,
        cacheWriteMarkup: 0.25,
        cacheReadDiscount: 0.90
    },
    'claude-sonnet-4.5': {
        inputPerMillion: 3.00,
        outputPerMillion: 15.00,
        cacheWriteMarkup: 0.25,
        cacheReadDiscount: 0.90
    },
    'claude-opus-4.6': {
        inputPerMillion: 15.00,
        outputPerMillion: 75.00,
        cacheWriteMarkup: 0.25,
        cacheReadDiscount: 0.90
    }
};
//# sourceMappingURL=types.js.map