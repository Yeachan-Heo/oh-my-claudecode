import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILLS_DIR = join(import.meta.dirname, '../../skills');

function readSkillCases(): Array<{ name: string; source: string }> {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      source: readFileSync(join(SKILLS_DIR, entry.name, 'SKILL.md'), 'utf8'),
    }));
}

function parseSkillFrontmatter(source: string): { frontmatter: string; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('Skill has no frontmatter block');
  return {
    frontmatter: match[1] ?? '',
    body: source.slice(match[0].length),
  };
}

describe('skill argument-hint flags', () => {
  it.each(readSkillCases())('$name documents each advertised flag in its body', ({ source }) => {
    const { frontmatter, body } = parseSkillFrontmatter(source);
    const hint = frontmatter.match(/^argument-hint:\s*(.*)$/m)?.[1] ?? '';
    const flags = [...new Set(hint.match(/--[a-z][a-z0-9-]*/g) ?? [])];

    for (const flag of flags) {
      expect(body, `${flag} is in argument-hint but not the skill body`).toContain(flag);
    }
  });
});
