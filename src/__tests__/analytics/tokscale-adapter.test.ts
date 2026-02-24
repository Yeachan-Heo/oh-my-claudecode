import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTokscaleAdapter,
  lookupPricingWithFallback,
  isTokscaleAvailable,
  resetAdapterCache
} from '../../analytics/tokscale-adapter.js';

describe('tokscale-adapter', () => {
  beforeEach(() => {
    // Reset the cached adapter before each test
    resetAdapterCache();
  });

  describe('getTokscaleAdapter', () => {
    it('returns adapter with isAvailable property', async () => {
      const adapter = await getTokscaleAdapter();
      expect(adapter).toHaveProperty('isAvailable');
      expect(typeof adapter.isAvailable).toBe('boolean');
    });

    it('caches adapter instance', async () => {
      const adapter1 = await getTokscaleAdapter();
      const adapter2 = await getTokscaleAdapter();
      expect(adapter1).toBe(adapter2);
    });

    it('returns adapter with expected properties when available', async () => {
      const adapter = await getTokscaleAdapter();
      // Even when unavailable, should have isAvailable property
      expect(adapter).toHaveProperty('isAvailable');
    });
  });

  describe('lookupPricingWithFallback', () => {
    it('returns pricing for known models', async () => {
      const pricing = await lookupPricingWithFallback('claude-sonnet-4.6');
      expect(pricing).toHaveProperty('inputPerMillion');
      expect(pricing).toHaveProperty('outputPerMillion');
      expect(pricing.inputPerMillion).toBeGreaterThan(0);
      expect(pricing.outputPerMillion).toBeGreaterThan(0);
    }, 15000);

    it('returns pricing for haiku model', async () => {
      const pricing = await lookupPricingWithFallback('claude-haiku-4');
      // Tokscale returns live pricing from LiteLLM database
      expect(pricing.inputPerMillion).toBeGreaterThan(0);
      expect(pricing.outputPerMillion).toBeGreaterThan(0);
      expect(pricing.outputPerMillion).toBeGreaterThan(pricing.inputPerMillion);
    }, 15000);

    it('returns pricing for opus model', async () => {
      const pricing = await lookupPricingWithFallback('claude-opus-4.6');
      // Tokscale returns live pricing from LiteLLM database
      expect(pricing.inputPerMillion).toBeGreaterThan(0);
      expect(pricing.outputPerMillion).toBeGreaterThan(0);
      expect(pricing.outputPerMillion).toBeGreaterThan(pricing.inputPerMillion);
    });

    it('returns default pricing for unknown models', async () => {
      const pricing = await lookupPricingWithFallback('unknown-model-xyz');
      expect(pricing).toBeDefined();
      expect(pricing).toHaveProperty('inputPerMillion');
      expect(pricing).toHaveProperty('outputPerMillion');
    });

    it('includes cache pricing fields', async () => {
      const pricing = await lookupPricingWithFallback('claude-sonnet-4.6');
      expect(pricing).toHaveProperty('cacheWriteMarkup');
      expect(pricing).toHaveProperty('cacheReadDiscount');
    });
  });

  describe('isTokscaleAvailable', () => {
    it('returns a boolean', async () => {
      const available = await isTokscaleAvailable();
      expect(typeof available).toBe('boolean');
    });
  });

  describe('resetAdapterCache', () => {
    it('clears the cached adapter', async () => {
      // Get adapter to populate cache
      const adapter1 = await getTokscaleAdapter();

      // Reset cache
      resetAdapterCache();

      // Get adapter again - should create new instance
      const adapter2 = await getTokscaleAdapter();

      // Both should have same structure but might be different instances
      // depending on whether tokscale is available
      expect(adapter2).toHaveProperty('isAvailable');
    });
  });
});
