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
