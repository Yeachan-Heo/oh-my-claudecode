import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSkillsCache,
  getBuiltinSkill,
  listBuiltinSkillNames,
} from '../features/builtin-skills/skills.js';
import { getAgentDefinitions } from '../agents/definitions.js';

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
      expect(names).toContain('ralplan');
    });

    it('resolves Tier-0 skills via getBuiltinSkill()', () => {
      const tier0 = ['autopilot', 'ultrawork', 'ralph', 'team', 'ralplan'] as const;

      for (const name of tier0) {
        const skill = getBuiltinSkill(name);
        expect(skill, `${name} should resolve`).toBeDefined();
        expect(skill?.template.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('Alias fidelity contracts', () => {
    it('keeps alias skills pointing to canonical implementations', () => {
      const ralplan = getBuiltinSkill('ralplan');
      const swarm = getBuiltinSkill('swarm');
      const team = getBuiltinSkill('team');
      const psm = getBuiltinSkill('psm');
      const projectSessionManager = getBuiltinSkill('project-session-manager');
      const review = getBuiltinSkill('omc-review');

      expect(ralplan?.template).toContain('/oh-my-claudecode:plan --consensus');
      expect(swarm).toBeDefined();
      expect(psm).toBeDefined();
      expect(
        swarm?.template.includes('/oh-my-claudecode:team') ||
        swarm?.template === team?.template
      ).toBe(true);
      expect(
        psm?.template.includes('/oh-my-claudecode:project-session-manager') ||
        psm?.template === projectSessionManager?.template
      ).toBe(true);
      expect(review?.template).toContain('/oh-my-claudecode:plan --review');
    });

    it('keeps native-command collisions prefixed to omc-* names', () => {
      const names = listBuiltinSkillNames();

      expect(names).toContain('omc-plan');
      expect(names).toContain('omc-review');
      expect(names).toContain('omc-security-review');
      expect(names).toContain('omc-doctor');
      expect(names).toContain('omc-help');
      expect(names).not.toContain('plan');
      expect(names).not.toContain('review');
      expect(names).not.toContain('security-review');
      expect(names).not.toContain('doctor');
      expect(names).not.toContain('help');
    });
  });

  describe('Agent alias compatibility', () => {
    it('preserves deprecated aliases with canonical routing targets', () => {
      const agents = getAgentDefinitions();

      expect(agents['dependency-expert']).toBeDefined();
      expect(agents['test-engineer']).toBeDefined();
      expect(agents['document-specialist']).toBeDefined();
      expect(agents['researcher']).toBeDefined();
      expect(agents['tdd-guide']).toBeDefined();

      expect(agents['researcher'].prompt).toBe(agents['document-specialist'].prompt);
      expect(agents['researcher'].model).toBe(agents['document-specialist'].model);
      expect(agents['tdd-guide'].prompt).toBe(agents['test-engineer'].prompt);
      expect(agents['tdd-guide'].model).toBe(agents['test-engineer'].model);
    });
  });
});
