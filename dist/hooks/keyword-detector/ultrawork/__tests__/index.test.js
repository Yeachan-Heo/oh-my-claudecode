import { describe, expect, it } from 'vitest';
import { getUltraworkMessage, getUltraworkSource, isGeminiModel, isGptModel, isPlannerAgent, } from '../index.js';
describe('ultrawork message routing', () => {
    it('routes planner before model family', () => {
        expect(isPlannerAgent('planner')).toBe(true);
        expect(getUltraworkSource('planner', 'gpt-5.4')).toBe('planner');
        const message = getUltraworkMessage('planner', 'gpt-5.4');
        expect(message).toContain('CRITICAL: YOU ARE A PLANNER, NOT AN IMPLEMENTER');
        expect(message).toContain('Parallel Execution Waves');
        expect(message).toContain('Dependency Matrix');
    });
    it('routes GPT and Codex-family models to the GPT variant', () => {
        expect(isGptModel('gpt-5.4')).toBe(true);
        expect(isGptModel('codex-mini')).toBe(true);
        expect(getUltraworkSource(undefined, 'gpt-5.4')).toBe('gpt');
        const message = getUltraworkMessage(undefined, 'gpt-5.4');
        expect(message).toContain('<output_verbosity_spec>');
        expect(message).toContain('DECISION FRAMEWORK: Self vs Delegate');
        expect(message).toContain('MANUAL QA IS MANDATORY');
    });
    it('routes Gemini-family models to the Gemini variant', () => {
        expect(isGeminiModel('gemini-2.5-pro')).toBe(true);
        expect(getUltraworkSource(undefined, 'gemini-2.5-pro')).toBe('gemini');
        const message = getUltraworkMessage(undefined, 'gemini-2.5-pro');
        expect(message).toContain('STEP 0: CLASSIFY INTENT');
        expect(message).toContain('ANTI-SKIP RULES');
    });
    it('falls back to the default variant and preserves concise-output guarantees', () => {
        expect(getUltraworkSource(undefined, 'claude-sonnet-4')).toBe('default');
        const message = getUltraworkMessage(undefined, 'claude-sonnet-4');
        expect(message).toContain('CONCISE OUTPUTS');
        expect(message).toContain('under 100 words');
        expect(message).toContain('files touched');
        expect(message).toContain('verification status');
    });
});
//# sourceMappingURL=index.test.js.map