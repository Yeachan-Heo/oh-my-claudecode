import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBuiltinSkills, clearSkillsCache } from '../features/builtin-skills/skills.js';
describe('builtin skill drafting contracts for learned skills (issue #2425)', () => {
    const originalUserType = process.env.USER_TYPE;
    beforeEach(() => {
        process.env.USER_TYPE = 'ant';
        clearSkillsCache();
    });
    afterEach(() => {
        if (originalUserType === undefined) {
            delete process.env.USER_TYPE;
        }
        else {
            process.env.USER_TYPE = originalUserType;
        }
        clearSkillsCache();
    });
    it('skillify skill instructs drafting flat file-backed skills with YAML frontmatter', () => {
        const skills = createBuiltinSkills();
        const skillify = skills.find((skill) => skill.name === 'skillify');
        expect(skillify).toBeDefined();
        expect(skillify.template).toContain('output a complete skill file that starts with YAML frontmatter');
        expect(skillify.template).toContain('Never emit plain markdown-only skill files.');
        expect(skillify.template).toContain('.omc/skills/<skill-name>.md');
        expect(skillify.template).toContain('skills/omc-learned/<skill-name>.md');
    });
});
//# sourceMappingURL=skills-frontmatter-regression.test.js.map