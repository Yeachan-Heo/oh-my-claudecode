/**
 * Issue #595: Consensus mode execution handoff regression tests
 * Issue #600: User feedback step between Planner and Architect/Critic
 * Issue #999: Structured deliberation protocol (RALPLAN-DR)
 *
 * Verifies that the plan skill's consensus mode (ralplan) mandates:
 * 1. Structured AskUserQuestion for approval (not plain text)
 * 2. Explicit Skill("oh-my-claudecode:ralph") invocation on approval
 * 3. Prohibition of direct implementation from the planning agent
 * 4. User feedback step after Planner but before Architect/Critic (#600)
 * 5. RALPLAN-DR short mode and deliberate mode requirements (#999)
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

    it('should require RALPLAN-DR structured deliberation in consensus mode', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();
      expect(consensusSection).toContain('RALPLAN-DR');
      expect(consensusSection).toContain('**Principles** (3-5)');
      expect(consensusSection).toContain('**Decision Drivers** (top 3)');
      expect(consensusSection).toContain('**Viable Options** (>=2)');
      expect(consensusSection).toContain('**invalidation rationale**');
    });

    it('should require ADR fields in final consensus output', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();
      expect(consensusSection).toContain('ADR');
      expect(consensusSection).toContain('**Decision**');
      expect(consensusSection).toContain('**Drivers**');
      expect(consensusSection).toContain('**Alternatives considered**');
      expect(consensusSection).toContain('**Why chosen**');
      expect(consensusSection).toContain('**Consequences**');
      expect(consensusSection).toContain('**Follow-ups**');
    });

    it('should mention deliberate mode requirements in consensus mode', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();
      expect(consensusSection).toContain('**Deliberate**');
      expect(consensusSection).toContain('`--deliberate`');
      expect(consensusSection).toContain('pre-mortem');
      expect(consensusSection).toContain('expanded test plan');
      expect(consensusSection).toContain('unit / integration / e2e / observability');
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

    it('should require architect antithesis and critic rejection gates in consensus flow', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill).toBeDefined();

      const consensusSection = extractSection(skill!.template, 'Consensus Mode');
      expect(consensusSection).toBeDefined();
      expect(consensusSection).toContain('steelman counterargument (antithesis)');
      expect(consensusSection).toContain('tradeoff tension');
      expect(consensusSection).toContain('Critic **MUST** explicitly reject shallow alternatives');
      expect(consensusSection).toContain('driver contradictions');
      expect(consensusSection).toContain('weak verification');
    });

  });
});

describe('Issue #3617: consensus reviews are sequential and independent', () => {
  beforeEach(() => {
    clearSkillsCache();
  });

  const contractLiterals = [
    'same fixed plan snapshot produced by Planner in step 1',
    'Architect output MUST NOT be passed to Critic',
    'separate, individually awaited Task calls',
    'never in parallel',
    'the Critic Task MUST NOT be issued until the Architect Task has completed and its result has been awaited',
    'Critic MUST NOT consume or receive the Architect review',
    'combined only by Planner during revision or improvement synthesis',
    'only after both reviews have completed',
  ];

  for (const skillName of ['omc-plan', 'ralplan'] as const) {
    it(`${skillName} documents the independent sequential review contract`, () => {
      const skill = getBuiltinSkill(skillName);
      expect(skill).toBeDefined();

      const workflowStart = skill!.template.indexOf('The consensus workflow:');
      const workflowEnd = skill!.template.indexOf('\n## Pre-Execution Gate', workflowStart);
      const workflow = skillName === 'omc-plan'
        ? extractSection(skill!.template, 'Consensus Mode')
        : workflowStart === -1 || workflowEnd === -1 ? undefined : skill!.template.slice(workflowStart, workflowEnd);
      expect(workflow).toBeDefined();
      const consensusWorkflow = workflow!;

      for (const literal of contractLiterals) {
        expect(consensusWorkflow).toContain(literal);
      }

      const architectIdx = consensusWorkflow.indexOf('3. **Architect** reviews');
      const criticIdx = consensusWorkflow.indexOf('4. **Critic** evaluates');
      const reReviewIdx = consensusWorkflow.indexOf('5. **Re-review loop**');
      const awaitIdx = consensusWorkflow.indexOf('the Critic Task MUST NOT be issued until the Architect Task has completed and its result has been awaited');
      const joinIdx = consensusWorkflow.indexOf('combined only by Planner during revision or improvement synthesis');

      expect(architectIdx).toBeGreaterThan(-1);
      expect(criticIdx).toBeGreaterThan(architectIdx);
      expect(reReviewIdx).toBeGreaterThan(criticIdx);
      expect(awaitIdx).toBeGreaterThan(architectIdx);
      expect(awaitIdx).toBeLessThan(joinIdx);
      expect(joinIdx).toBeGreaterThan(criticIdx);

      const architectStep = consensusWorkflow.slice(architectIdx, criticIdx);
      const criticStep = consensusWorkflow.slice(criticIdx, reReviewIdx);
      expect(architectStep).toContain('same fixed plan snapshot produced by Planner in step 1');
      expect(architectStep).toContain('Architect output MUST NOT be passed to Critic');
      expect(criticStep).toContain('same fixed plan snapshot');
      expect(criticStep).toContain('Critic MUST NOT consume or receive the Architect review');

      expect(consensusWorkflow).not.toMatch(/Architect output (?:is|will be|shall be) (?:passed|forwarded|handed|provided) (?:to|into)/i);
      expect(consensusWorkflow).not.toMatch(/Critic (?:receives|consumes|uses|relies on) (?:the )?Architect (?:output|review)/i);
      expect(consensusWorkflow).not.toMatch(/Critic (?:is|will be|shall be) (?:provided|handed|forwarded) (?:the )?Architect (?:output|review)/i);
      expect(consensusWorkflow).not.toMatch(/(?:run|dispatch) Architect and Critic in parallel/i);
      expect(consensusWorkflow).not.toMatch(/Architect and Critic (?:may|can|should) (?:run|be dispatched) in parallel/i);

      if (skillName === 'omc-plan') {
        expect(consensusWorkflow).toContain('Do NOT run steps 3 and 4 in parallel.');
      } else {
        expect(consensusWorkflow).toContain('MUST run sequentially');
        expect(consensusWorkflow).toContain('same parallel batch');
      }
    });
  }
});
describe('Issue #2945: planning modules require explicit execution consent', () => {
  beforeEach(() => {
    clearSkillsCache();
  });

  it('plan consensus mode marks non-interactive output pending approval and forbids mutation before approval', () => {
    const skill = getBuiltinSkill('omc-plan');
    expect(skill).toBeDefined();

    expect(skill!.template).toContain('Planning/execution boundary');
    expect(skill!.template).toContain('pending approval');
    expect(skill!.template).toMatch(/MUST NOT run mutation-oriented shell commands/i);
    expect(skill!.template).toMatch(/edit (source )?files/i);
    expect(skill!.template).toMatch(/commit, push, open PRs/i);
    expect(skill!.template).toMatch(/delegate implementation tasks/i);
    expect(skill!.template).toContain('Without `--interactive`, skip both prompts, mark the plan `pending approval`, output the final plan, and stop.');
  });

  it('plan no longer treats just-do-it wording as implicit approval to invoke ralph', () => {
    const skill = getBuiltinSkill('omc-plan');
    expect(skill).toBeDefined();

    const escalation = extractTagContent(skill!.template, 'Escalation_And_Stop_Conditions');
    expect(escalation).toBeDefined();
    expect(escalation).toContain('without explicitly naming an execution path');
    expect(escalation).toContain('pending approval');
    expect(escalation).toContain('Do NOT invoke `Skill("oh-my-claudecode:ralph")`');
    expect(escalation).not.toMatch(/skip planning[\s\S]{0,120}MUST[\s\S]{0,80}Skill\("oh-my-claudecode:ralph"\)/i);
  });

  it('ralplan documents the same planning/execution boundary', () => {
    const skill = getBuiltinSkill('ralplan');
    expect(skill).toBeDefined();

    expect(skill!.template).toContain('Planning/Execution Boundary');
    expect(skill!.template).toContain('pending approval');
    expect(skill!.template).toMatch(/MUST NOT run mutation-oriented shell commands/i);
    expect(skill!.template).toMatch(/commit, push, open PRs/i);
    expect(skill!.template).toContain('stop before any mutation or delegation');
    expect(skill!.template).toContain('`just do it` / `skip planning` alone only ends planning with a `pending approval` artifact');
  });

  it('deep-interview writes pending-approval specs and stops before execution without explicit selection', () => {
    const skill = getBuiltinSkill('deep-interview');
    expect(skill).toBeDefined();

    expect(skill!.template).toContain('pending approval → explicitly approved execution');
    expect(skill!.template).toContain('mark it `pending approval`');
    expect(skill!.template).toMatch(/MUST NOT run mutation-oriented shell commands/i);
    expect(skill!.template).toMatch(/open PRs, invoke execution skills, or delegate implementation tasks/i);
    expect(skill!.template).toContain('do not automatically invoke autopilot or any other execution skill');
    expect(skill!.template).toContain('Without explicit execution selection, stop with the spec marked `pending approval`.');
    expect(skill!.template).not.toContain('autopilot with consensus plan');
  });
});
