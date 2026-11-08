import { describe, expect, it } from 'vitest';

import { createMagicKeywordProcessor, detectMagicKeywords } from '../magic-keywords.js';

describe('magic-keywords retired workflow handling', () => {
  it.each(['ultrawork', 'ulw', 'uw'])('does not enhance retired trigger %s', (trigger) => {
    const processPrompt = createMagicKeywordProcessor();
    const prompt = `${trigger} fix this task`;

    expect(processPrompt(prompt)).toBe(prompt);
    expect(detectMagicKeywords(prompt)).toEqual([]);
  });
});

describe('magic keyword custom triggers', () => {
  it('applies search enhancement when only a custom search trigger is configured', () => {
    const processPrompt = createMagicKeywordProcessor({ search: ['deep-scan'] });

    const result = processPrompt('deep-scan src/hooks');

    expect(result).toContain('[search-mode]');
  });

  it('applies analyze enhancement when only a custom analyze trigger is configured', () => {
    const processPrompt = createMagicKeywordProcessor({ analyze: ['audit-this'] });

    const result = processPrompt('audit-this deterministic modules');

    expect(result).toContain('[analyze-mode]');
  });

  it('removes custom ultrathink triggers from the enhanced prompt', () => {
    const processPrompt = createMagicKeywordProcessor({ ultrathink: ['ponder deeply'] });

    const result = processPrompt('ponder deeply edge cases');

    expect(result).toContain('[ULTRATHINK MODE - EXTENDED REASONING ACTIVATED]');
    expect(result).toContain('edge cases');
    expect(result).not.toContain('ponder deeply edge cases');
  });
});
