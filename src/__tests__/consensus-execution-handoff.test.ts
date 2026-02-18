/**
 * Issue #595: Consensus mode execution handoff regression tests
 * Issue #600: User feedback step between Planner and Architect/Critic
 *
 * Verifies that the plan skill's consensus mode (ralplan) mandates:
 * 1. Structured AskUserQuestion for approval (not plain text)
 * 2. Explicit Skill("oh-my-claudecode:ralph") invocation on approval
 * 3. Prohibition of direct implementation from the planning agent
 * 4. User feedback step after Planner but before Architect/Critic (#600)
 *
 * Also verifies that non-consensus modes (interview, direct, review) are unaffected.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getBuiltinSkill, clearSkillsCache } from '../features/builtin-skills/skills.js';

/**
 * Extract a markdown section by heading using regex.
 * More robust than split-based parsing — tolerates heading format variations.
 */
function extractSection(template: string, heading: string): string | undefined {
  const pattern = new RegExp(`###\\s+${heading}[\\s\\S]*?(?=###|$)`);
  const match = template.match(pattern);
  return match?.[0];
}

/**
 * Extract content between XML-like tags.
 */
function extractTagContent(template: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
  const match = template.match(pattern);
  return match?.[0];
}

describe('Issue #595: Consensus mode execution handoff', () => {
  beforeEach(() => {
    clearSkillsCache();
  });

  describe('plan skill - consensus mode', () => {
    it('should mandate AskUserQuestion for the approval step', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();
      expect(consensusSection).toContain('AskUserQuestion');
    });

    it('should mandate Skill invocation for ralph on user approval', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();
      expect(consensusSection).toContain('Skill("oh-my-claudecode:ralph")');
    });

    it('should use MUST language for execution handoff', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();
      expect(consensusSection).toMatch(/\*\*MUST\*\*.*invoke.*Skill/i);
    });

    it('should prohibit direct implementation from the planning agent', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();
      expect(consensusSection).toMatch(/Do NOT implement directly/i);
    });

    it('should not modify interview mode steps', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const interviewSection = extractSection(skill!.template, 'Interview Mode');
      expect(interviewSection).toBeDefined();
      expect(interviewSection).toContain('Classify the request');
      expect(interviewSection).toContain('Ask one focused question');
      expect(interviewSection).toContain('Gather codebase facts first');
    });

    it('should not modify direct mode steps', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const directSection = extractSection(skill!.template, 'Direct Mode');
      expect(directSection).toBeDefined();
      expect(directSection).toContain('Quick Analysis');
      expect(directSection).toContain('Create plan');
    });

    it('should not modify review mode steps', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const reviewSection = extractSection(skill!.template, 'Review Mode');
      expect(reviewSection).toBeDefined();
      expect(reviewSection).toContain('Read plan file');
      expect(reviewSection).toContain('Evaluate via Critic');
    });

    it('should reference ralph skill invocation in escalation section', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const escalation = extractTagContent(skill!.template, 'Escalation_And_Stop_Conditions');
      expect(escalation).toBeDefined();
      expect(escalation).toContain('Skill("oh-my-claudecode:ralph")');
      // Old vague language should be gone
      expect(escalation).not.toContain('transition to execution mode (ralph or executor)');
    });
  });

  describe('Issue #600: User feedback step between Planner and Architect/Critic', () => {
    it('should have a user feedback step after Planner and before Architect', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();

      // Step ordering: Planner must come before User feedback,
      // User feedback must come before Architect
      const plannerIdx = consensusSection!.indexOf('**Planner** creates initial plan');
      const feedbackIdx = consensusSection!.indexOf('**User feedback**');
      const architectIdx = consensusSection!.indexOf('**Architect** reviews');

      expect(plannerIdx).toBeGreaterThan(-1);
      expect(feedbackIdx).toBeGreaterThan(-1);
      expect(architectIdx).toBeGreaterThan(-1);

      expect(feedbackIdx).toBeGreaterThan(plannerIdx);
      expect(architectIdx).toBeGreaterThan(feedbackIdx);
    });

    it('should mandate AskUserQuestion for the user feedback step', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();

      // The user feedback step must use MUST + AskUserQuestion
      expect(consensusSection).toMatch(/User feedback.*MUST.*AskUserQuestion/s);
    });

    it('should offer Proceed/Request changes/Skip review options in user feedback step', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();

      expect(consensusSection).toContain('Proceed to review');
      expect(consensusSection).toContain('Request changes');
      expect(consensusSection).toContain('Skip review');
    });

    it('should place Critic after Architect in the consensus flow', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();

      const architectIdx = consensusSection!.indexOf('**Architect** reviews');
      const criticIdx = consensusSection!.indexOf('**Critic** evaluates');

      expect(architectIdx).toBeGreaterThan(-1);
      expect(criticIdx).toBeGreaterThan(-1);
      expect(criticIdx).toBeGreaterThan(architectIdx);
    });

    it('should include user feedback step in ralplan alias workflow', () => {
      const skill = getBuiltinSkill('ralplan');
      expect(skill).toBeDefined();

      expect(skill!.template).toContain('**User feedback**');

      // Verify ordering in ralplan too
      const plannerIdx = skill!.template.indexOf('**Planner** creates initial plan');
      const feedbackIdx = skill!.template.indexOf('**User feedback**');
      const architectIdx = skill!.template.indexOf('**Architect** reviews');

      expect(plannerIdx).toBeGreaterThan(-1);
      expect(feedbackIdx).toBeGreaterThan(-1);
      expect(architectIdx).toBeGreaterThan(-1);

      expect(feedbackIdx).toBeGreaterThan(plannerIdx);
      expect(architectIdx).toBeGreaterThan(feedbackIdx);
    });
  });

  describe('ralplan skill - consensus alias', () => {
    it('should reference AskUserQuestion in the approval step', () => {
      const skill = getBuiltinSkill('ralplan');
      expect(skill).toBeDefined();
      expect(skill!.template).toContain('AskUserQuestion');
    });

    it('should reference ralph skill invocation on approval', () => {
      const skill = getBuiltinSkill('ralplan');
      expect(skill).toBeDefined();
      expect(skill!.template).toContain('Skill("oh-my-claudecode:ralph")');
    });

    it('should still identify as an alias for /plan --consensus', () => {
      const skill = getBuiltinSkill('ralplan');
      expect(skill).toBeDefined();
      expect(skill!.template).toContain('/oh-my-claudecode:plan --consensus');
    });
  });
});
