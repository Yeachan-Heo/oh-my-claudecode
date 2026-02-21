import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSkillsCache,
  getBuiltinSkill,
  listBuiltinSkillNames,
} from '../features/builtin-skills/skills.js';
import { getAgentDefinitions } from '../agents/definitions.js';
import { resolveDelegation } from '../features/delegation-routing/resolver.js';

describe('Consolidation contracts', () => {
  beforeEach(() => {
    clearSkillsCache();
  });

  describe('Tier-0 skill contracts', () => {
    it('preserves Tier-0 entrypoint names', () => {
      const names = listBuiltinSkillNames();

      expect(names).toContain('autopilot');
      expect(names).toContain('ultrawork');
      expect(names).toContain('ralph');
      expect(names).toContain('team');
    });

    it('resolves Tier-0 skills via getBuiltinSkill()', () => {
      const tier0 = ['autopilot', 'ultrawork', 'ralph', 'team'] as const;

      for (const name of tier0) {
        const skill = getBuiltinSkill(name);
        expect(skill, `${name} should resolve`).toBeDefined();
        expect(skill?.template.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('Alias fidelity contracts', () => {
    it('keeps alias skills pointing to canonical implementations', () => {
      const swarm = getBuiltinSkill('swarm');
      const team = getBuiltinSkill('team');

      // swarm is an alias defined in team/SKILL.md frontmatter
      expect(swarm).toBeDefined();
      expect(
        swarm?.template.includes('/oh-my-claudecode:team') ||
        swarm?.template === team?.template
      ).toBe(true);
    });

    it('keeps native-command collisions prefixed to omc-* names', () => {
      const names = listBuiltinSkillNames();

      expect(names).toContain('omc-plan');
      expect(names).toContain('omc-security-review');
      expect(names).toContain('omc-doctor');
      expect(names).toContain('omc-help');
      expect(names).not.toContain('plan');
      expect(names).not.toContain('security-review');
      expect(names).not.toContain('doctor');
      expect(names).not.toContain('help');
    });

    it('hides deprecated compatibility aliases from default listings', () => {
      const names = listBuiltinSkillNames();

      expect(names).not.toContain('swarm');
      expect(names).not.toContain('psm');
    });
  });

  describe('Agent alias compatibility', () => {
    it('keeps only canonical agent keys in runtime registry', () => {
      const agents = getAgentDefinitions();

      expect(agents['dependency-expert']).toBeUndefined();
      expect(agents['test-engineer']).toBeDefined();
      expect(agents['document-specialist']).toBeDefined();
      expect(agents['researcher']).toBeUndefined();
      expect(agents['tdd-guide']).toBeUndefined();
    });

    it('normalizes deprecated agent aliases in delegation routing', () => {
      const researcherRoute = resolveDelegation({ agentRole: 'researcher' });
      const tddGuideRoute = resolveDelegation({ agentRole: 'tdd-guide' });

      expect(researcherRoute.provider).toBe('claude');
      expect(researcherRoute.tool).toBe('Task');
      expect(researcherRoute.agentOrModel).toBe('document-specialist');

      expect(tddGuideRoute.provider).toBe('claude');
      expect(tddGuideRoute.tool).toBe('Task');
      expect(tddGuideRoute.agentOrModel).toBe('test-engineer');
    });
  });
});
