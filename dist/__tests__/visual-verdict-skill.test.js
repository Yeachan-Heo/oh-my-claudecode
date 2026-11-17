import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const visualVerdictSkill = readFileSync(join(PROJECT_ROOT, 'skills', 'visual-verdict', 'SKILL.md'), 'utf-8');
describe('visual-verdict skill contract', () => {
    it('documents required JSON fields', () => {
        for (const field of ['"score"', '"verdict"', '"category_match"', '"differences"', '"suggestions"', '"reasoning"']) {
            expect(visualVerdictSkill).toContain(field);
        }
    });
    it('documents threshold and pixel diff guidance', () => {
        expect(visualVerdictSkill).toMatch(/90\+/);
        expect(visualVerdictSkill).toMatch(/pixel diff/i);
        expect(visualVerdictSkill).toMatch(/pixelmatch/i);
    });
    it('uses OMC-native invocation guidance instead of OMX state-path wording', () => {
        expect(visualVerdictSkill).toContain('/oh-my-claudecode:visual-verdict');
        expect(visualVerdictSkill).not.toMatch(/\.omx\//i);
        expect(visualVerdictSkill).toContain('Task: {{ARGUMENTS}}');
    });
});
//# sourceMappingURL=visual-verdict-skill.test.js.map