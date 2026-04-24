import { describe, expect, it } from 'vitest';
import { createMagicKeywordProcessor } from '../magic-keywords.js';
describe('magic-keywords ultrawork integration', () => {
    it('uses the centralized default ultrawork generator', () => {
        const processPrompt = createMagicKeywordProcessor();
        const result = processPrompt('ultrawork fix this task');
        expect(result).toContain('ULTRAWORK MODE ENABLED!');
        expect(result).toContain('CONCISE OUTPUTS');
        expect(result).toContain('fix this task');
    });
    it('routes planner context before model context', () => {
        const processPrompt = createMagicKeywordProcessor();
        const result = processPrompt('ultrawork plan this change', 'planner', 'gpt-5.4');
        expect(result).toContain('CRITICAL: YOU ARE A PLANNER, NOT AN IMPLEMENTER');
        expect(result).toContain('Parallel Execution Waves');
        expect(result).not.toContain('<output_verbosity_spec>');
    });
});
//# sourceMappingURL=magic-keywords.test.js.map