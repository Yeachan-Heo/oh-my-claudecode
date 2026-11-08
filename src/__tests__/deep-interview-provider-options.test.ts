import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const availability = vi.hoisted(() => ({
  claude: true,
  codex: false,
  gemini: false,
}));

vi.mock('../team/model-contract.js', () => ({
  isCliAvailable: (agentType: 'claude' | 'codex' | 'gemini') => availability[agentType],
}));

import { clearSkillsCache, getBuiltinSkill } from '../features/builtin-skills/skills.js';
import { renderSkillRuntimeGuidance } from '../features/builtin-skills/runtime-guidance.js';

describe('deep-interview provider-aware approval-gated recommendations', () => {
  const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    availability.claude = true;
    availability.codex = false;
    availability.gemini = false;
    if (originalPluginRoot === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    clearSkillsCache();
  });

  afterEach(() => {
    if (originalPluginRoot === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    clearSkillsCache();
  });

  it('injects Codex variants without restoring direct autopilot recommendation when Codex CLI is available', () => {
    availability.codex = true;
    clearSkillsCache();

    const skill = getBuiltinSkill('deep-interview');

    expect(skill?.template).toContain('## Provider-Aware Execution Recommendations');
    expect(skill?.template).toContain('/ralplan --architect codex');
    expect(skill?.template).toContain('/ralplan --critic codex');
    expect(skill?.template).toContain('/ralph --critic codex');
    expect(skill?.template).toContain('higher cost than Claude-only ralplan');
    expect(skill?.template).toContain('Refine with omc-plan consensus (Recommended)');
    expect(skill?.template).toContain('pending approval → separate execution approval');
    expect(skill?.template).toContain('do not automatically invoke autopilot or any other execution skill');
    expect(skill?.template).not.toContain('Ralplan → Autopilot (Recommended)');
    expect(skill?.template).not.toContain('Execute with autopilot (skip ralplan)');
  });

  it('falls back to approval-gated Claude-only defaults when external providers are unavailable', () => {
    const skill = getBuiltinSkill('deep-interview');

    expect(skill?.template).not.toContain('## Provider-Aware Execution Recommendations');
    expect(skill?.template).toContain('Refine with omc-plan consensus (Recommended)');
    expect(skill?.template).toContain('pending approval → separate execution approval');
    expect(skill?.template).toContain('do not automatically invoke autopilot or any other execution skill');
    expect(skill?.template).toContain('Execute with autopilot');
    expect(skill?.template).toContain('only after the user explicitly selects this execution option');
    expect(skill?.template).toContain('Execute with ralph');
    expect(skill?.template).not.toContain('Ralplan → Autopilot (Recommended)');
    expect(skill?.template).not.toContain('Execute with autopilot (skip ralplan)');
  });

  it('documents supported Codex architect/critic overrides for consensus planning', () => {
    const planSkill = getBuiltinSkill('omc-plan');
    const ralplanSkill = getBuiltinSkill('ralplan');

    expect(planSkill?.template).toContain('--architect codex');
    expect(planSkill?.template).toContain('ask codex --agent-prompt architect');
    expect(planSkill?.template).toContain('--critic codex');
    expect(planSkill?.template).toContain('ask codex --agent-prompt critic');

    expect(ralplanSkill?.template).toContain('--architect codex');
    expect(ralplanSkill?.template).toContain('--critic codex');
  });

  it('renders no extra runtime guidance when no provider-specific deep-interview variant is available', () => {
    expect(renderSkillRuntimeGuidance('deep-interview')).toBe('');
  });
});
