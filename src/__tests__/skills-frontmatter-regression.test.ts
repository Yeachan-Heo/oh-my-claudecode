import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuiltinSkills, clearSkillsCache } from '../features/builtin-skills/skills.js';

const requireFromHere = createRequire(import.meta.url);
const yaml = requireFromHere('js-yaml') as { load: (source: string) => unknown };
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const SHIM_DESCRIPTION_BUDGET = 240;
const KNOWN_LONG_MODEL_INVOCATION_DESCRIPTIONS = new Set(['agent-doc-discipline', 'loft']);
// drydock is a user-invoked entrypoint that predates `disable-model-invocation`.
const MANUAL_ONLY_WITHOUT_FLAG = new Set(['drydock']);

function shippedSkillNames(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function parseShippedSkillFrontmatter(skillName: string): Record<string, unknown> {
  const content = readFileSync(join(SKILLS_DIR, skillName, 'SKILL.md'), 'utf-8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${skillName} is missing YAML frontmatter`);

  const parsed = yaml.load(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${skillName} frontmatter must be a YAML mapping`);
  }
  return parsed as Record<string, unknown>;
}

describe('shipped skill frontmatter', () => {
  it('parses every shipped SKILL.md frontmatter with a real YAML parser', () => {
    const skills = shippedSkillNames();
    expect(skills.length).toBeGreaterThan(0);

    for (const skillName of skills) {
      expect(() => parseShippedSkillFrontmatter(skillName), `${skillName} frontmatter`).not.toThrow();
    }
  });

  it('keeps model-invoked descriptions within the compact plugin shim budget', () => {
    for (const skillName of shippedSkillNames()) {
      const metadata = parseShippedSkillFrontmatter(skillName);
      const description = metadata.description;
      expect(typeof description, `${skillName} description must be a string`).toBe('string');

      // Manual-only entrypoints declare `disable-model-invocation`, so their
      // description is never used as an autonomous trigger and may keep full
      // prose. These two existing long model-facing descriptions are explicit
      // legacy exceptions; every other model-invoked skill must fit the native
      // shim budget so its trigger is not cut mid-sentence.
      if (
        metadata['disable-model-invocation'] === true
        || MANUAL_ONLY_WITHOUT_FLAG.has(skillName)
        || KNOWN_LONG_MODEL_INVOCATION_DESCRIPTIONS.has(skillName)
      ) {
        continue;
      }
      expect((description as string).length, `${skillName} description length`).toBeLessThanOrEqual(SHIM_DESCRIPTION_BUDGET);
    }
  });

  it('keeps diagram positive and skip criteria intact within the shim budget', () => {
    const description = parseShippedSkillFrontmatter('diagram').description;
    expect(typeof description).toBe('string');
    expect((description as string).length).toBeLessThanOrEqual(SHIM_DESCRIPTION_BUDGET);
    expect(description).toContain('control flow');
    expect(description).toContain('Mermaid diagram');
    expect(description).toContain('or diff');
    expect(description).toContain('Skip it when prose already answers the question');
  });
});

describe('builtin skill drafting contracts for learned skills (issue #2425)', () => {
  const originalUserType = process.env.USER_TYPE;

  beforeEach(() => {
    process.env.USER_TYPE = 'ant';
    clearSkillsCache();
  });

  afterEach(() => {
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE;
    } else {
      process.env.USER_TYPE = originalUserType;
    }
    clearSkillsCache();
  });


  it('skillify skill instructs drafting flat file-backed skills with YAML frontmatter', () => {
    const skills = createBuiltinSkills();
    const skillify = skills.find((skill) => skill.name === 'skillify');

    expect(skillify).toBeDefined();
    expect(skillify!.template).toContain('output a complete skill file that starts with YAML frontmatter');
    expect(skillify!.template).toContain('Never emit plain markdown-only skill files.');
    expect(skillify!.template).toContain('.omc/skills/<skill-name>.md');
    expect(skillify!.template).toContain('skills/omc-learned/<skill-name>.md');
  });
});
