import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const availability = vi.hoisted(() => ({
  claude: true,
  codex: false,
  gemini: false,
}));

vi.mock('../team/model-contract.js', () => ({
  isCliAvailable: (agentType: 'claude' | 'codex' | 'gemini') => availability[agentType],
}));

import {
  detectSkillRuntimeAvailability,
  renderSkillRuntimeGuidance,
} from '../features/builtin-skills/runtime-guidance.js';

describe('runtime-guidance: ralplan/plan/ralph Codex availability', () => {
  beforeEach(() => {
    availability.claude = true;
    availability.codex = false;
    availability.gemini = false;
  });

  describe('renderSkillRuntimeGuidance for plan-family skills', () => {
    const planSkills = ['ralplan', 'omc-plan', 'plan', 'ralph'] as const;

    it.each(planSkills)(
      'injects Codex availability guidance for "%s" when Codex is available',
      (skillName) => {
        availability.codex = true;
        const guidance = renderSkillRuntimeGuidance(skillName);
        expect(guidance).toContain('## Provider Runtime Availability');
        expect(guidance).toContain('Codex CLI is installed and available');
        expect(guidance).toContain('Do NOT report Codex as unavailable');
      },
    );

    it.each(planSkills)(
      'renders no Codex guidance for "%s" when Codex is unavailable',
      (skillName) => {
        availability.codex = false;
        const guidance = renderSkillRuntimeGuidance(skillName);
        expect(guidance).toBe('');
      },
    );

    it('does not affect unrelated skills', () => {
      availability.codex = true;
      expect(renderSkillRuntimeGuidance('autopilot')).toBe('');
      expect(renderSkillRuntimeGuidance('ultrawork')).toBe('');
      expect(renderSkillRuntimeGuidance('ccg')).toBe('');
    });
  });

  describe('detectSkillRuntimeAvailability safety', () => {
    it('returns false for a provider whose detector throws instead of crashing', () => {
      const throwingDetector = (agentType: 'claude' | 'codex' | 'gemini') => {
        if (agentType === 'codex') {
          throw new Error(
            'External LLM provider "codex" is blocked by security policy (disableExternalLLM).',
          );
        }
        return agentType === 'claude';
      };

      const result = detectSkillRuntimeAvailability(throwingDetector);
      expect(result.claude).toBe(true);
      expect(result.codex).toBe(false);
      expect(result.gemini).toBe(false);
    });

    it('returns false for all providers when detector throws for every call', () => {
      const alwaysThrows = () => {
        throw new Error('everything is broken');
      };

      const result = detectSkillRuntimeAvailability(alwaysThrows);
      expect(result.claude).toBe(false);
      expect(result.codex).toBe(false);
      expect(result.gemini).toBe(false);
    });

    it('returns correct values when detector does not throw', () => {
      availability.codex = true;
      const result = detectSkillRuntimeAvailability();
      expect(result.claude).toBe(true);
      expect(result.codex).toBe(true);
      expect(result.gemini).toBe(false);
    });
  });
});
