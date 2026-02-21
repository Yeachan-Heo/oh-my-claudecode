import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSkillsCache,
  createBuiltinSkills,
  getBuiltinSkill,
  listBuiltinSkillNames,
} from '../features/builtin-skills/skills.js';

vi.mock('../features/auto-update.js', () => ({
  isTeamEnabled: () => true,
}));

import { getPrimaryKeyword } from '../hooks/keyword-detector/index.js';

const TIER0_SKILLS = ['team', 'ralph', 'ultrawork', 'autopilot'] as const;

describe('Tier-0 contract: skill aliases and canonical entrypoints', () => {
  beforeEach(() => {
    clearSkillsCache();
  });

  it('keeps Tier-0 skills as canonical unprefixed names', () => {
    const names = listBuiltinSkillNames();

    for (const name of TIER0_SKILLS) {
      expect(names).toContain(name);
      expect(names).not.toContain(`omc-${name}`);
    }
  });

  it('resolves Tier-0 skills case-insensitively', () => {
    for (const name of TIER0_SKILLS) {
      expect(getBuiltinSkill(name)?.name).toBe(name);
      expect(getBuiltinSkill(name.toUpperCase())?.name).toBe(name);
    }
  });

  it('keeps Tier-0 skills unique in the loaded builtin catalog', () => {
    const tier0Hits = createBuiltinSkills().filter((skill) => TIER0_SKILLS.includes(skill.name as typeof TIER0_SKILLS[number]));
    expect(tier0Hits.map((skill) => skill.name).sort()).toEqual([...TIER0_SKILLS].sort());
  });
});

describe('Tier-0 contract: keyword routing fidelity', () => {
  it('routes canonical trigger words to their canonical mode types', () => {
    const cases: Array<{ prompt: string; expected: (typeof TIER0_SKILLS)[number] }> = [
      { prompt: 'autopilot build a dashboard', expected: 'autopilot' },
      { prompt: 'ultrawork fix these lint errors', expected: 'ultrawork' },
      { prompt: 'ralph finish this refactor', expected: 'ralph' },
      { prompt: 'team 3:executor ship this feature', expected: 'team' },
    ];

    for (const { prompt, expected } of cases) {
      expect(getPrimaryKeyword(prompt)?.type).toBe(expected);
    }
  });
});
