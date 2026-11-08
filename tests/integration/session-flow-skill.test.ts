import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBuiltinSkills } from '../../src/features/builtin-skills/skills.js';
import { getEntry } from '../../src/workflow/registry.js';

const root = process.cwd();
const skillBody = readFileSync(join(root, 'skills', 'session-flow', 'SKILL.md'), 'utf8');
const frontmatter = skillBody.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as {
  skills: string[];
};

describe('session-flow skill', () => {
  it('is a manually invoked advisory skill registered on the plugin surface', () => {
    expect(frontmatter).toMatch(/^name: session-flow$/m);
    expect(frontmatter).toMatch(/^disable-model-invocation: true$/m);
    expect(getEntry('session-flow', 'skill')).toMatchObject({
      decision: 'keep',
      riskClass: 'advisory',
    });
    expect(createBuiltinSkills().map((skill) => skill.name)).toContain('session-flow');
    expect(plugin.skills).toContain('./skills/session-flow/');
  });

  it('maps exploratory progress, pivots, dropped paths, and open decisions from evidence', () => {
    for (const outcome of ['✅', '▶', '○', '✂', '↪']) {
      expect(skillBody).toContain(outcome);
    }
    expect(skillBody).toContain('4–8 meaningful stages');
    expect(skillBody).toContain('at most 15 lines');
    expect(skillBody).toContain('one compact evidence pointer');
    expect(skillBody).toContain('Needs you');
    expect(skillBody).toContain('Never invent a link');
  });

  it('persists only owned stage Tasks and leaves unrelated user Tasks untouched', () => {
    expect(skillBody).toContain('TaskList');
    expect(skillBody).toContain('TaskGet');
    expect(skillBody).toContain('TaskCreate');
    expect(skillBody).toContain('TaskUpdate');
    expect(skillBody).toContain('description whose first line is the ownership marker');
    expect(skillBody).toContain('session-flow: managed stage');
    expect(skillBody).toContain('Never edit, complete, delete, or reuse an unmarked Task');
    expect(skillBody).toContain('short` must not call mutating Task tools');
    expect(skillBody).toContain('For `reset`, discover owned Tasks with `TaskList` and `TaskGet`');
    expect(skillBody).toContain('keep surviving stage numbers stable and avoid collisions with unowned Tasks');
    expect(skillBody).toContain('Delete owned Tasks for stages no longer in the reconstructed map');
    expect(skillBody).toContain('continuation hook excludes Tasks');
  });
});
