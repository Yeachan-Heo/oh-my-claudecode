import { describe, expect, it } from 'vitest';

import {
  CATEGORY_CONFIGS,
  THINKING_BUDGET_TOKENS,
  getCategoryDescription,
  getCategoryPromptAppend,
  getCategoryTemperature,
  getCategoryThinkingBudget,
  getCategoryThinkingBudgetTokens,
  getCategoryTier,
  resolveCategory,
} from '../index.js';

describe('delegation category accessors', () => {
  it('stay aligned with the category config table', () => {
    for (const [category, config] of Object.entries(CATEGORY_CONFIGS)) {
      expect(resolveCategory(category as keyof typeof CATEGORY_CONFIGS)).toEqual({
        category,
        ...config,
      });
      expect(getCategoryDescription(category as keyof typeof CATEGORY_CONFIGS)).toBe(config.description);
      expect(getCategoryTier(category as keyof typeof CATEGORY_CONFIGS)).toBe(config.tier);
      expect(getCategoryTemperature(category as keyof typeof CATEGORY_CONFIGS)).toBe(config.temperature);
      expect(getCategoryThinkingBudget(category as keyof typeof CATEGORY_CONFIGS)).toBe(config.thinkingBudget);
      expect(getCategoryThinkingBudgetTokens(category as keyof typeof CATEGORY_CONFIGS)).toBe(
        THINKING_BUDGET_TOKENS[config.thinkingBudget]
      );
      expect(getCategoryPromptAppend(category as keyof typeof CATEGORY_CONFIGS)).toBe(config.promptAppend || '');
    }
  });
});
