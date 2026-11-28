import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_APP_DISALLOWED_TOOLS, extractDisallowedTools } from '../agents/utils.js';
import { parseFrontmatter } from '../utils/frontmatter.js';

const AGENTS_DIR = join(process.cwd(), 'agents');

const BROWSER_PATTERN = 'mcp__Claude_Browser__*';

/** These agents may need the browser tool, so their list leaves out the browser pattern. */
const WITHOUT_BROWSER_PATTERN = ['designer', 'test-engineer', 'verifier'];
const READ_ONLY_AGENTS = [
  'analyst', 'architect', 'code-reviewer', 'critic', 'document-specialist', 'explore', 'scientist',
  'security-reviewer', 'verifier',
];
const OWN_ENTRIES = ['Write', 'Edit'];

const agentNames = readdirSync(AGENTS_DIR)
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length))
  .sort();

function frontmatterOf(content: string): string[] {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1].split(/\r?\n/) : [];
}

describe('bundled agents carry the desktop app tool patterns in disallowedTools', () => {
  test('every agent named in the lists is in the agents directory', () => {
    for (const name of [...READ_ONLY_AGENTS, ...WITHOUT_BROWSER_PATTERN]) {
      expect(agentNames).toContain(name);
    }
  });

  test.each(agentNames)('%s has one parsable disallowedTools line in its frontmatter', (name) => {
    const content = readFileSync(join(AGENTS_DIR, `${name}.md`), 'utf-8');
    expect(parseFrontmatter(content).metadata.name).toBe(name);
    const lines = frontmatterOf(content).filter((line) => line.startsWith('disallowedTools:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`disallowedTools: ${extractDisallowedTools(content)!.join(', ')}`);
  });

  test.each(agentNames)('%s lists its own entries first and then exactly the desktop patterns', (name) => {
    const content = readFileSync(join(AGENTS_DIR, `${name}.md`), 'utf-8');
    const tools = extractDisallowedTools(content);
    expect(tools).toBeDefined();

    const patterns = WITHOUT_BROWSER_PATTERN.includes(name)
      ? DESKTOP_APP_DISALLOWED_TOOLS.filter((pattern) => pattern !== BROWSER_PATTERN)
      : DESKTOP_APP_DISALLOWED_TOOLS;
    const own = tools!.slice(0, tools!.length - patterns.length);

    expect(tools!.slice(own.length)).toEqual(patterns);
    expect(own).toEqual(READ_ONLY_AGENTS.includes(name) ? OWN_ENTRIES : []);
    expect(new Set(tools).size).toBe(tools!.length);
    expect(tools!.includes(BROWSER_PATTERN)).toBe(!WITHOUT_BROWSER_PATTERN.includes(name));
  });

  test('only the read-only agents block Write and Edit', () => {
    for (const name of agentNames) {
      const tools = extractDisallowedTools(readFileSync(join(AGENTS_DIR, `${name}.md`), 'utf-8')) ?? [];
      expect(tools.includes('Write')).toBe(READ_ONLY_AGENTS.includes(name));
      expect(tools.includes('Edit')).toBe(READ_ONLY_AGENTS.includes(name));
    }
  });
});
