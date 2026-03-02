import { describe, it, expect } from 'vitest';
describe('Cleanup Validation', () => {
    it('omc-plan skill resolves correctly', async () => {
        const { getBuiltinSkill } = await import('../features/builtin-skills/skills.js');
        const skill = getBuiltinSkill('omc-plan');
        expect(skill).toBeDefined();
    });
    it('plan skill is blocked by CC native denylist', async () => {
        const { getBuiltinSkill } = await import('../features/builtin-skills/skills.js');
        const skill = getBuiltinSkill('plan');
        expect(skill).toBeUndefined();
    });
    it('old keywords do not match active patterns', async () => {
        const { detectKeywordsWithType } = await import('../hooks/keyword-detector/index.js');
        const result = detectKeywordsWithType('ultrapilot build this');
        expect(result).toEqual([]);
    });
    it('deprecated keyword infrastructure is removed', async () => {
        const keywordModule = await import('../hooks/keyword-detector/index.js');
        expect('detectDeprecatedKeywords' in keywordModule).toBe(false);
        expect('DEPRECATED_KEYWORD_PATTERNS' in keywordModule).toBe(false);
    });
    it('PluginConfig.agents matches 21-agent registry + omc', async () => {
        const { DEFAULT_CONFIG } = await import('../config/loader.js');
        const agentKeys = Object.keys(DEFAULT_CONFIG.agents || {});
        expect(agentKeys).toContain('omc');
        expect(agentKeys).toContain('explore');
        expect(agentKeys).toContain('architect');
        expect(agentKeys).toContain('executor');
        expect(agentKeys).toContain('documentSpecialist');
        expect(agentKeys).toContain('critic');
        // Stale entries should NOT be present
        expect(agentKeys).not.toContain('frontendEngineer');
        expect(agentKeys).not.toContain('documentWriter');
        expect(agentKeys).not.toContain('multimodalLooker');
        expect(agentKeys).not.toContain('coordinator');
    });
    it('agent registry has 21 agents', async () => {
        const { getAgentDefinitions } = await import('../agents/definitions.js');
        const defs = getAgentDefinitions();
        expect(Object.keys(defs)).toHaveLength(21);
    });
});
//# sourceMappingURL=cleanup-validation.test.js.map