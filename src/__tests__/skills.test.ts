import { describe, it, expect, beforeEach } from 'vitest';
import { createBuiltinSkills, getBuiltinSkill, listBuiltinSkillNames, clearSkillsCache } from '../features/builtin-skills/skills.js';

describe('Builtin Skills', () => {
  // Clear cache before each test to ensure fresh loads
  beforeEach(() => {
    clearSkillsCache();
  });

  describe('createBuiltinSkills()', () => {
    it('should return correct number of skills (38)', () => {
      const skills = createBuiltinSkills();
      // 38 skills: analyze, autopilot, build-fix, cancel, ccg, code-review, configure-notifications,
      // deepinit, omc-doctor, external-context, omc-help, hud, learn-about-omc, learner, mcp-setup,
      // note, omc-setup, omc-teams, pipeline, omc-plan, project-session-manager, psm, ralph, ralph-init,
      // ralplan, release, omc-review, sciomc, omc-security-review, skill, swarm, tdd, team, trace,
      // ultrapilot, ultraqa, ultrawork, writer-memory
      expect(skills).toHaveLength(39);
    });

    it('should return an array of BuiltinSkill objects', () => {
      const skills = createBuiltinSkills();
      expect(Array.isArray(skills)).toBe(true);
      expect(skills.length).toBeGreaterThan(0);
    });
  });

  describe('Skill properties', () => {
    const skills = createBuiltinSkills();

    it('should have required properties (name, description, template)', () => {
      skills.forEach((skill) => {
        expect(skill).toHaveProperty('name');
        expect(skill).toHaveProperty('description');
        expect(skill).toHaveProperty('template');
      });
    });

    it('should have non-empty name for each skill', () => {
      skills.forEach((skill) => {
        expect(skill.name).toBeTruthy();
        expect(typeof skill.name).toBe('string');
        expect(skill.name.length).toBeGreaterThan(0);
      });
    });

    it('should have non-empty description for each skill', () => {
      skills.forEach((skill) => {
        expect(skill.description).toBeTruthy();
        expect(typeof skill.description).toBe('string');
        expect(skill.description.length).toBeGreaterThan(0);
      });
    });

    it('should have non-empty template for each skill', () => {
      skills.forEach((skill) => {
        expect(skill.template).toBeTruthy();
        expect(typeof skill.template).toBe('string');
        expect(skill.template.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Skill names', () => {
    it('should have valid skill names', () => {
      const skills = createBuiltinSkills();
      const expectedSkills = [
        'analyze',
        'autopilot',
        'build-fix',
        'cancel',
        'ccg',
        'code-review',
        'configure-notifications',
        'configure-openclaw',
        'deepinit',
        'omc-doctor',
        'external-context',
        'omc-help',
        'hud',
        'learn-about-omc',
        'learner',
        'mcp-setup',
        'note',
        'omc-setup',
        'omc-teams',
        'pipeline',
        'omc-plan',
        'project-session-manager',
        'psm',
        'ralph',
        'ralph-init',
        'ralplan',
        'release',
        'omc-review',
        'sciomc',
        'omc-security-review',
        'skill',
        'swarm',
        'tdd',
        'team',
        'trace',
        'ultrapilot',
        'ultraqa',
        'ultrawork',
        'writer-memory',
      ];

      const actualSkillNames = skills.map((s) => s.name);
      expect(actualSkillNames).toEqual(expect.arrayContaining(expectedSkills));
      expect(actualSkillNames.length).toBe(expectedSkills.length);
    });

    it('should not have duplicate skill names', () => {
      const skills = createBuiltinSkills();
      const skillNames = skills.map((s) => s.name);
      const uniqueNames = new Set(skillNames);
      expect(uniqueNames.size).toBe(skillNames.length);
    });
  });

  describe('getBuiltinSkill()', () => {
    it('should retrieve a skill by name', () => {
      const skill = getBuiltinSkill('autopilot');
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('autopilot');
    });

    it('should be case-insensitive', () => {
      const skillLower = getBuiltinSkill('autopilot');
      const skillUpper = getBuiltinSkill('AUTOPILOT');
      const skillMixed = getBuiltinSkill('AuToPiLoT');

      expect(skillLower).toBeDefined();
      expect(skillUpper).toBeDefined();
      expect(skillMixed).toBeDefined();
      expect(skillLower?.name).toBe(skillUpper?.name);
      expect(skillLower?.name).toBe(skillMixed?.name);
    });

    it('should return undefined for non-existent skill', () => {
      const skill = getBuiltinSkill('non-existent-skill');
      expect(skill).toBeUndefined();
    });
  });

  describe('listBuiltinSkillNames()', () => {
    it('should return canonical skill names by default', () => {
      const names = listBuiltinSkillNames();

      expect(names).toHaveLength(37);
      expect(names).toContain('autopilot');
      expect(names).toContain('cancel');
      expect(names).toContain('ccg');
      expect(names).toContain('configure-notifications');
      expect(names).toContain('ralph');
      expect(names).toContain('ultrawork');
      expect(names).toContain('analyze');
      expect(names).toContain('omc-plan');
      expect(names).toContain('deepinit');
      expect(names).toContain('release');
      expect(names).toContain('omc-doctor');
      expect(names).toContain('omc-help');
      expect(names).toContain('hud');
      expect(names).toContain('note');
      expect(names).toContain('omc-setup');
      expect(names).not.toContain('swarm');
      expect(names).not.toContain('psm');
    });

    it('should return an array of strings', () => {
      const names = listBuiltinSkillNames();
      names.forEach((name) => {
        expect(typeof name).toBe('string');
      });
    });

    it('should include aliases when explicitly requested', () => {
      const names = listBuiltinSkillNames({ includeAliases: true });

      expect(names).toHaveLength(39);
      expect(names).toContain('swarm');
      expect(names).toContain('psm');
    });
  });

  describe('CC native command denylist (issue #830)', () => {
    it('should not expose any builtin skill whose name is a bare CC native command', () => {
      const skills = createBuiltinSkills();
      const bareNativeNames = [
        'compact', 'clear', 'help', 'config', 'plan',
        'review', 'doctor', 'init', 'memory', 'security-review',
      ];
      const skillNames = skills.map((s) => s.name.toLowerCase());
      for (const native of bareNativeNames) {
        expect(skillNames).not.toContain(native);
      }
    });

    it('should not return a skill for "compact" via getBuiltinSkill', () => {
      expect(getBuiltinSkill('compact')).toBeUndefined();
    });

    it('should not return a skill for "clear" via getBuiltinSkill', () => {
      expect(getBuiltinSkill('clear')).toBeUndefined();
    });
  });

  describe('Template strings', () => {
    const skills = createBuiltinSkills();

    it('should have non-empty templates', () => {
      skills.forEach((skill) => {
        expect(skill.template.trim().length).toBeGreaterThan(0);
      });
    });

    it('should have substantial template content (> 100 chars)', () => {
      skills.forEach((skill) => {
        expect(skill.template.length).toBeGreaterThan(100);
      });
    });
  });
});
