import { describe, expect, it } from 'vitest';
import { CATEGORY_CONFIGS, THINKING_BUDGET_TOKENS, getCategoryDescription, getCategoryPromptAppend, getCategoryTemperature, getCategoryThinkingBudget, getCategoryThinkingBudgetTokens, getCategoryTier, resolveCategory, } from '../index.js';
describe('delegation category accessors', () => {
    it('stay aligned with the category config table', () => {
        for (const [category, config] of Object.entries(CATEGORY_CONFIGS)) {
            expect(resolveCategory(category)).toEqual({
                category,
                ...config,
            });
            expect(getCategoryDescription(category)).toBe(config.description);
            expect(getCategoryTier(category)).toBe(config.tier);
            expect(getCategoryTemperature(category)).toBe(config.temperature);
            expect(getCategoryThinkingBudget(category)).toBe(config.thinkingBudget);
            expect(getCategoryThinkingBudgetTokens(category)).toBe(THINKING_BUDGET_TOKENS[config.thinkingBudget]);
            expect(getCategoryPromptAppend(category)).toBe(config.promptAppend || '');
        }
    });
});
//# sourceMappingURL=index.test.js.map