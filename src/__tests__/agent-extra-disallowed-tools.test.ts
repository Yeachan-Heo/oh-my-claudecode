import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgentDefinitions } from '../agents/definitions.js';
import { collectCapabilitySurface } from '../cli/commands/capabilities.js';
import {
  DESKTOP_APP_DISALLOWED_TOOLS,
  EXTRA_DISALLOWED_TOOLS_ENV,
  applyExtraDisallowedToolsToMarkdown,
  extractDisallowedTools,
  getExtraDisallowedTools,
  mergeDisallowedTools,
} from '../agents/utils.js';

const AGENTS_DIR = join(process.cwd(), 'agents');

const AGENTS = [
  'analyst', 'architect', 'code-reviewer', 'code-simplifier', 'critic', 'debugger', 'designer',
  'document-specialist', 'executor', 'explore', 'git-master', 'planner', 'qa-tester', 'scientist',
  'security-reviewer', 'test-engineer', 'tracer', 'verifier', 'writer',
];
const READ_ONLY_AGENTS = [
  'analyst', 'architect', 'code-reviewer', 'critic', 'document-specialist', 'explore', 'scientist',
  'security-reviewer', 'verifier',
];

const DESKTOP_PATTERNS = [
  'Artifact', 'ArtifactComments', 'ArtifactData', 'ArtifactCheck',
  'mcp__ccd_turn__*', 'mcp__ccd_session__*', 'mcp__visualize__*', 'mcp__Claude_Browser__*',
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getExtraDisallowedTools', () => {
  test('unset variable gives no extra tools', () => {
    expect(getExtraDisallowedTools({})).toEqual([]);
  });

  test('empty and whitespace-only values give no extra tools', () => {
    expect(getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: '' })).toEqual([]);
    expect(getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: '   ' })).toEqual([]);
    expect(getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: ' , ,, ' })).toEqual([]);
  });

  test('trims tokens and ignores empty ones', () => {
    expect(getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: ' Foo ,, Bar ,' })).toEqual(['Foo', 'Bar']);
  });

  test('removes duplicates and keeps the first occurrence order', () => {
    expect(getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: 'B,A,B, A ,C' })).toEqual(['B', 'A', 'C']);
  });

  test('keeps a pattern with a star as one token', () => {
    expect(getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: 'mcp__server__*' })).toEqual(['mcp__server__*']);
  });

  test('desktop preset expands to the eight desktop-app patterns', () => {
    expect(getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: 'desktop' })).toEqual(DESKTOP_PATTERNS);
    expect([...DESKTOP_APP_DISALLOWED_TOOLS]).toEqual(DESKTOP_PATTERNS);
  });

  test('desktop preset is case-insensitive and mixes with other tokens without duplicates', () => {
    expect(
      getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: 'Extra, DESKTOP, Artifact' }),
    ).toEqual(['Extra', ...DESKTOP_PATTERNS]);
  });

  test('ignores a token that contains a line break', () => {
    expect(
      getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: 'Good,a\nmodel: opus,Fine' }),
    ).toEqual(['Good', 'Fine']);
  });

  test('reads process.env by default', () => {
    vi.stubEnv(EXTRA_DISALLOWED_TOOLS_ENV, 'FromEnv');
    expect(getExtraDisallowedTools()).toEqual(['FromEnv']);
  });
});

describe('mergeDisallowedTools', () => {
  test('returns the base value unchanged when there are no extras', () => {
    expect(mergeDisallowedTools(undefined, [])).toBeUndefined();
    const base = ['Write', 'Edit'];
    expect(mergeDisallowedTools(base, [])).toBe(base);
  });

  test('read-only agent keeps its own entries first and gains the extras', () => {
    expect(mergeDisallowedTools(['Write', 'Edit'], ['Foo', 'mcp__x__*'])).toEqual([
      'Write', 'Edit', 'Foo', 'mcp__x__*',
    ]);
  });

  test('agent without its own list gets just the extras', () => {
    expect(mergeDisallowedTools(undefined, ['Foo'])).toEqual(['Foo']);
  });

  test('never removes an entry and does not repeat one the agent already has', () => {
    expect(mergeDisallowedTools(['Write', 'Edit'], ['Edit', 'Foo'])).toEqual(['Write', 'Edit', 'Foo']);
  });

  test('does not mutate the base list', () => {
    const base = ['Write'];
    mergeDisallowedTools(base, ['Foo']);
    expect(base).toEqual(['Write']);
  });
});

describe('applyExtraDisallowedToolsToMarkdown', () => {
  test('returns the same string when there are no extras', () => {
    const content = '---\nname: x\ndisallowedTools: Write, Edit\n---\nBody\n';
    expect(applyExtraDisallowedToolsToMarkdown(content, [])).toBe(content);
  });

  test('appends to an existing disallowedTools line', () => {
    const content = '---\nname: x\ndisallowedTools: Write, Edit\nmodel: haiku\n---\nBody\n';
    const out = applyExtraDisallowedToolsToMarkdown(content, ['Foo', 'mcp__x__*']);
    expect(out).toBe('---\nname: x\ndisallowedTools: Write, Edit, Foo, mcp__x__*\nmodel: haiku\n---\nBody\n');
    expect(extractDisallowedTools(out)).toEqual(['Write', 'Edit', 'Foo', 'mcp__x__*']);
  });

  test('adds the line before the closing delimiter when the agent has none', () => {
    const content = '---\nname: x\nmodel: sonnet\n---\nBody\n';
    const out = applyExtraDisallowedToolsToMarkdown(content, ['Foo']);
    expect(out).toBe('---\nname: x\nmodel: sonnet\ndisallowedTools: Foo\n---\nBody\n');
  });

  test('keeps CRLF line endings and a leading BOM', () => {
    const content = '\uFEFF---\r\nname: x\r\n---\r\nBody\r\n';
    const out = applyExtraDisallowedToolsToMarkdown(content, ['Foo']);
    expect(out).toBe('\uFEFF---\r\nname: x\r\ndisallowedTools: Foo\r\n---\r\nBody\r\n');
    expect(extractDisallowedTools(out)).toEqual(['Foo']);
  });

  test('does not touch text after the frontmatter, including a disallowedTools line in the body', () => {
    const content = '---\nname: x\n---\ndisallowedTools: Body\n';
    expect(applyExtraDisallowedToolsToMarkdown(content, ['Foo'])).toBe(
      '---\nname: x\ndisallowedTools: Foo\n---\ndisallowedTools: Body\n',
    );
  });

  test('returns content without frontmatter unchanged', () => {
    expect(applyExtraDisallowedToolsToMarkdown('No frontmatter\n', ['Foo'])).toBe('No frontmatter\n');
  });

  test('works on every bundled agent file and never removes an own entry', () => {
    for (const agent of AGENTS) {
      const content = readFileSync(join(AGENTS_DIR, `${agent}.md`), 'utf-8');
      const own = extractDisallowedTools(content) ?? [];
      const out = applyExtraDisallowedToolsToMarkdown(content, DESKTOP_PATTERNS);
      expect(extractDisallowedTools(out)).toEqual([...own, ...DESKTOP_PATTERNS]);
      expect(out.slice(out.indexOf('\n---', 4))).toBe(content.slice(content.indexOf('\n---', 4)));
    }
  });
});

describe('getAgentDefinitions with OMC_AGENT_EXTRA_DISALLOWED_TOOLS', () => {
  beforeEach(() => {
    vi.stubEnv(EXTRA_DISALLOWED_TOOLS_ENV, undefined);
  });

  test('with the variable unset every agent definition is byte-identical to the stub without the option', () => {
    const baseline = getAgentDefinitions({ config: {} });
    for (const value of ['', '  ', ' , ,']) {
      vi.stubEnv(EXTRA_DISALLOWED_TOOLS_ENV, value);
      const withEmpty = getAgentDefinitions({ config: {} });
      expect(withEmpty).toStrictEqual(baseline);
      expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(baseline));
      vi.unstubAllEnvs();
    }
  });

  test('with the variable unset the disallowedTools of each agent equal its frontmatter list', () => {
    const defs = getAgentDefinitions({ config: {} });
    for (const agent of AGENTS) {
      const fromFile = extractDisallowedTools(readFileSync(join(AGENTS_DIR, `${agent}.md`), 'utf-8'));
      expect(defs[agent].disallowedTools).toStrictEqual(fromFile);
    }
  });

  test('desktop preset appends the patterns to all 19 agents and read-only agents keep Write and Edit', () => {
    const baseline = getAgentDefinitions({ config: {} });
    vi.stubEnv(EXTRA_DISALLOWED_TOOLS_ENV, 'desktop');
    const defs = getAgentDefinitions({ config: {} });

    for (const agent of AGENTS) {
      const own = baseline[agent].disallowedTools ?? [];
      const tools = defs[agent].disallowedTools!;
      expect(tools.slice(0, own.length)).toEqual(own);
      for (const pattern of DESKTOP_PATTERNS) {
        expect(tools).toContain(pattern);
      }
      if (READ_ONLY_AGENTS.includes(agent)) {
        expect(tools.slice(0, 2)).toEqual(['Write', 'Edit']);
      } else {
        expect(tools).not.toContain('Write');
        expect(tools).not.toContain('Edit');
      }
      expect({ ...defs[agent], disallowedTools: undefined }).toEqual({ ...baseline[agent], disallowedTools: undefined });
    }
  });

  test('a custom pattern is appended to an agent without its own list', () => {
    vi.stubEnv(EXTRA_DISALLOWED_TOOLS_ENV, 'mcp__custom__*');
    const defs = getAgentDefinitions({ config: {} });
    expect(defs.executor.disallowedTools).toEqual(['mcp__custom__*']);
    expect(defs.explore.disallowedTools).toEqual(['Write', 'Edit', 'mcp__custom__*']);
  });

  test('omc capabilities shows the effective list only when the variable is set', () => {
    const find = (name: string) => collectCapabilitySurface().agents.find((a) => a.name === name)!;
    expect(find('executor').disallowedTools).toEqual([]);

    vi.stubEnv(EXTRA_DISALLOWED_TOOLS_ENV, 'mcp__custom__*');
    expect(find('executor').disallowedTools).toEqual(['mcp__custom__*']);
    expect(find('explore').disallowedTools).toEqual(['Edit', 'mcp__custom__*', 'Write']);
  });
});

describe('legacy agent install with OMC_AGENT_EXTRA_DISALLOWED_TOOLS', () => {
  let tempRoot: string;
  let originalClaudeConfigDir: string | undefined;
  let originalHome: string | undefined;
  let originalOmcPluginRoot: string | undefined;
  let originalClaudePluginRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'omc-agent-extra-disallowed-'));
    mkdirSync(join(tempRoot, 'home', '.claude'), { recursive: true });
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    originalHome = process.env.HOME;
    originalOmcPluginRoot = process.env.OMC_PLUGIN_ROOT;
    originalClaudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.OMC_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('CLAUDE_CONFIG_DIR', originalClaudeConfigDir);
    restore('HOME', originalHome);
    restore('OMC_PLUGIN_ROOT', originalOmcPluginRoot);
    restore('CLAUDE_PLUGIN_ROOT', originalClaudePluginRoot);
    rmSync(tempRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  async function installAgents(extra: string | undefined): Promise<string> {
    const claudeConfigDir = join(tempRoot, 'home', '.claude');
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    process.env.HOME = join(tempRoot, 'home');
    vi.stubEnv(EXTRA_DISALLOWED_TOOLS_ENV, extra);
    vi.resetModules();
    const installer = await import('../installer/index.js');
    const result = installer.install({ skipClaudeCheck: true, skipHud: true, force: true });
    expect(result.success, `${result.message}\n${result.errors.join('\n')}`).toBe(true);
    expect(result.installedAgents.length).toBeGreaterThan(0);
    return join(claudeConfigDir, 'agents');
  }

  test('without the variable the installed agent files are byte-identical to the bundled ones', async () => {
    const installed = await installAgents(undefined);
    for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))) {
      expect(readFileSync(join(installed, file), 'utf-8')).toBe(readFileSync(join(AGENTS_DIR, file), 'utf-8'));
    }
  });

  test('with the variable the installed agent files gain the extras and nothing else changes', async () => {
    const installed = await installAgents('desktop');
    for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))) {
      const original = readFileSync(join(AGENTS_DIR, file), 'utf-8');
      const copy = readFileSync(join(installed, file), 'utf-8');
      expect(copy).toBe(applyExtraDisallowedToolsToMarkdown(original, DESKTOP_PATTERNS));
      expect(extractDisallowedTools(copy)).toEqual([...(extractDisallowedTools(original) ?? []), ...DESKTOP_PATTERNS]);
    }
  });
});
