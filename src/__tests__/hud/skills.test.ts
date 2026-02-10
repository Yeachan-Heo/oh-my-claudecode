import { describe, it, expect } from 'vitest';
import { renderSkills, renderLastSkill } from '../../hud/elements/skills.js';
import type { UltraworkStateForHud, RalphStateForHud, SkillInvocation } from '../../hud/types.js';

describe('renderSkills', () => {
  const inactiveUltrawork: UltraworkStateForHud = { active: false, reinforcementCount: 0 };
  const activeUltrawork: UltraworkStateForHud = { active: true, reinforcementCount: 0 };
  const inactiveRalph: RalphStateForHud = { active: false, iteration: 0, maxIterations: 10 };
  const activeRalph: RalphStateForHud = { active: true, iteration: 3, maxIterations: 10 };

  describe('basic mode rendering', () => {
    it('returns null when no modes are active and no last skill', () => {
      const result = renderSkills(inactiveUltrawork, inactiveRalph, null);
      expect(result).toBeNull();
    });

    it('renders ultrawork when active', () => {
      const result = renderSkills(activeUltrawork, inactiveRalph, null);
      expect(result).toContain('ultrawork');
    });

    it('renders ralph when active', () => {
      const result = renderSkills(inactiveUltrawork, activeRalph, null);
      expect(result).toContain('ralph');
    });

    it('renders combined ultrawork+ralph when both active', () => {
      const result = renderSkills(activeUltrawork, activeRalph, null);
      expect(result).toContain('ultrawork+ralph');
    });
  });

  describe('last skill rendering', () => {
    it('renders last skill when no modes are active', () => {
      const lastSkill: SkillInvocation = { name: 'plan', timestamp: new Date() };
      const result = renderSkills(inactiveUltrawork, inactiveRalph, lastSkill);
      expect(result).toContain('skill:plan');
    });

    it('renders last skill alongside active mode', () => {
      const lastSkill: SkillInvocation = { name: 'autopilot', timestamp: new Date() };
      const result = renderSkills(activeUltrawork, inactiveRalph, lastSkill);
      expect(result).toContain('ultrawork');
      expect(result).toContain('skill:autopilot');
    });

    it('includes args when present', () => {
      const lastSkill: SkillInvocation = { name: 'plan', args: 'my task', timestamp: new Date() };
      const result = renderSkills(inactiveUltrawork, inactiveRalph, lastSkill);
      expect(result).toContain('skill:plan(my task)');
    });

    it('truncates long args', () => {
      const lastSkill: SkillInvocation = { name: 'plan', args: 'this is a very long argument', timestamp: new Date() };
      const result = renderSkills(inactiveUltrawork, inactiveRalph, lastSkill);
      expect(result).toContain('skill:plan');
      expect(result?.length).toBeLessThan(50);
    });

    it('does not render last skill if it matches active mode', () => {
      const lastSkill: SkillInvocation = { name: 'ultrawork', timestamp: new Date() };
      const result = renderSkills(activeUltrawork, inactiveRalph, lastSkill);
      expect(result).toContain('ultrawork');
      expect(result).not.toContain('skill:');
    });
  });

  describe('namespaced skill names', () => {
    it('displays only last segment for namespaced skills (oh-my-claudecode:plan)', () => {
      const lastSkill: SkillInvocation = { name: 'oh-my-claudecode:plan', timestamp: new Date() };
      const result = renderSkills(inactiveUltrawork, inactiveRalph, lastSkill);
      expect(result).toContain('skill:plan');
      expect(result).not.toContain('oh-my-claudecode');
    });

    it('displays only last segment for namespaced skills with args', () => {
      const lastSkill: SkillInvocation = { name: 'oh-my-claudecode:autopilot', args: 'build app', timestamp: new Date() };
      const result = renderSkills(inactiveUltrawork, inactiveRalph, lastSkill);
      expect(result).toContain('skill:autopilot(build app)');
      expect(result).not.toContain('oh-my-claudecode');
    });

    it('handles multiple colons in skill name', () => {
      const lastSkill: SkillInvocation = { name: 'namespace:subcategory:action', timestamp: new Date() };
      const result = renderSkills(inactiveUltrawork, inactiveRalph, lastSkill);
      expect(result).toContain('skill:action');
    });

    it('handles empty namespace (leading colon)', () => {
      const lastSkill: SkillInvocation = { name: ':plan', timestamp: new Date() };
      const result = renderSkills(inactiveUltrawork, inactiveRalph, lastSkill);
      expect(result).toContain('skill:plan');
    });

    it('preserves non-namespaced skill names unchanged', () => {
      const lastSkill: SkillInvocation = { name: 'plan', timestamp: new Date() };
      const result = renderSkills(inactiveUltrawork, inactiveRalph, lastSkill);
      expect(result).toContain('skill:plan');
    });

    it('preserves skill names with hyphens', () => {
      const lastSkill: SkillInvocation = { name: 'code-review', timestamp: new Date() };
      const result = renderSkills(inactiveUltrawork, inactiveRalph, lastSkill);
      expect(result).toContain('skill:code-review');
    });
  });
});

describe('renderLastSkill', () => {
  describe('basic rendering', () => {
    it('returns null when lastSkill is null', () => {
      const result = renderLastSkill(null);
      expect(result).toBeNull();
    });

    it('renders skill name', () => {
      const lastSkill: SkillInvocation = { name: 'plan', timestamp: new Date() };
      const result = renderLastSkill(lastSkill);
      expect(result).toContain('skill:plan');
    });

    it('includes args when present', () => {
      const lastSkill: SkillInvocation = { name: 'autopilot', args: 'my project', timestamp: new Date() };
      const result = renderLastSkill(lastSkill);
      expect(result).toContain('skill:autopilot(my project)');
    });
  });

  describe('namespaced skill names', () => {
    it('displays only last segment for namespaced skills (oh-my-claudecode:plan)', () => {
      const lastSkill: SkillInvocation = { name: 'oh-my-claudecode:plan', timestamp: new Date() };
      const result = renderLastSkill(lastSkill);
      expect(result).toContain('skill:plan');
      expect(result).not.toContain('oh-my-claudecode');
    });

    it('displays only last segment for namespaced skills with args', () => {
      const lastSkill: SkillInvocation = { name: 'oh-my-claudecode:autopilot', args: 'build app', timestamp: new Date() };
      const result = renderLastSkill(lastSkill);
      expect(result).toContain('skill:autopilot(build app)');
      expect(result).not.toContain('oh-my-claudecode');
    });

    it('handles multiple colons in skill name', () => {
      const lastSkill: SkillInvocation = { name: 'namespace:subcategory:action', timestamp: new Date() };
      const result = renderLastSkill(lastSkill);
      expect(result).toContain('skill:action');
    });

    it('handles empty namespace (leading colon)', () => {
      const lastSkill: SkillInvocation = { name: ':plan', timestamp: new Date() };
      const result = renderLastSkill(lastSkill);
      expect(result).toContain('skill:plan');
    });

    it('preserves non-namespaced skill names unchanged', () => {
      const lastSkill: SkillInvocation = { name: 'plan', timestamp: new Date() };
      const result = renderLastSkill(lastSkill);
      expect(result).toContain('skill:plan');
    });

    it('preserves skill names with hyphens', () => {
      const lastSkill: SkillInvocation = { name: 'code-review', timestamp: new Date() };
      const result = renderLastSkill(lastSkill);
      expect(result).toContain('skill:code-review');
    });
  });
});
