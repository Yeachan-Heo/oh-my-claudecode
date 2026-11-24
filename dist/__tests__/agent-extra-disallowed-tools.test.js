import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgentDefinitions } from '../agents/definitions.js';
import { collectCapabilitySurface } from '../cli/commands/capabilities.js';
import { DESKTOP_APP_DISALLOWED_TOOLS, EXTRA_DISALLOWED_TOOLS_ENV, applyExtraDisallowedToolsToMarkdown, extractDisallowedTools, getExtraDisallowedTools, isPlainYamlToken, mergeDisallowedTools, } from '../agents/utils.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
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
function frontmatterLines(content) {
    const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
    return match ? match[1].split(/\r?\n/) : [];
}
/** Metadata of the output must equal the original's, except for the disallowedTools value. */
function expectFrontmatterIntact(original, out) {
    const before = parseFrontmatter(original).metadata;
    const after = parseFrontmatter(out).metadata;
    expect(Object.keys(after).sort()).toEqual([...new Set([...Object.keys(before), 'disallowedTools'])].sort());
    for (const key of Object.keys(before)) {
        if (key !== 'disallowedTools')
            expect(after[key]).toBe(before[key]);
    }
    expect(parseFrontmatter(out).body).toBe(parseFrontmatter(original).body);
}
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
        expect(getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: 'Extra, DESKTOP, Artifact' })).toEqual(['Extra', ...DESKTOP_PATTERNS]);
    });
    test('ignores a token that contains a line break', () => {
        expect(getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: 'Good,a\nmodel: opus,Fine' })).toEqual(['Good', 'Fine']);
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
        expect(applyExtraDisallowedToolsToMarkdown(content, ['Foo'])).toBe('---\nname: x\ndisallowedTools: Foo\n---\ndisallowedTools: Body\n');
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
describe('isPlainYamlToken', () => {
    test.each([
        ...DESKTOP_PATTERNS,
        'mcp__server__*',
        'mcp__*__x*',
        'Bash(git push:*)',
        'Foo$&bar',
        'Foo$`bar',
        "Foo$'bar",
        'Foo$$bar',
        'Foo$1bar',
        'a"b',
        "a'b",
        'a\\b',
        'a\tb',
        'T'.repeat(10000),
    ])('accepts %s', (token) => {
        expect(isPlainYamlToken(token)).toBe(true);
    });
    test.each([
        ['a line feed', 'a\nmodel: opus'],
        ['a carriage return', 'a\r\nmodel: opus'],
        ['U+0085', 'a\u0085model: opus'],
        ['U+2028', 'a\u2028model: opus'],
        ['U+2029', 'a\u2029model: opus'],
        ['a colon followed by a space', 'a: b'],
        ['a colon followed by a tab', 'a:\tb'],
        ['a trailing colon', 'a:'],
        ['a hash preceded by a space', 'x #y'],
        ['a leading hash', '#comment'],
        ['a leading dash', '-x'],
        ['a leading dash and space', '- x'],
        ['a document separator', '---'],
        ['a leading question mark', '? x'],
        ['a leading brace', '{x}'],
        ['a leading bracket', '[a]'],
        ['a closing brace', '}'],
        ['a closing bracket', ']'],
        ['a leading ampersand', '&anchor'],
        ['a leading star', '*alias'],
        ['a lone star', '*'],
        ['a leading exclamation mark', '!tag'],
        ['a leading pipe', '|'],
        ['a leading greater-than sign', '>'],
        ['a leading percent sign', '%x'],
        ['a leading at sign', '@x'],
        ['a leading backtick', '`x'],
        ['a leading double quote', '"quoted"'],
        ['a leading single quote', "'single'"],
        ['the word null', 'null'],
        ['a tilde', '~'],
        ['the word true', 'true'],
        ['an integer', '123'],
        ['a float', '1.5e3'],
    ])('rejects a token with %s', (_name, token) => {
        expect(isPlainYamlToken(token)).toBe(false);
    });
});
describe('applyExtraDisallowedToolsToMarkdown with unusual token values', () => {
    const WITH_LIST = '---\nname: x\ndescription: Test\ndisallowedTools: Write, Edit\nmodel: haiku\n---\nBody\n';
    const WITHOUT_LIST = '---\nname: x\ndescription: Test\nmodel: sonnet\n---\nBody\n';
    const REPLACEMENT_PATTERNS = ['Foo$&bar', 'Foo$`bar', "Foo$'bar", 'Foo$$bar', 'Foo$1bar', '$&', '$`', '$$'];
    test.each(REPLACEMENT_PATTERNS)('keeps the replacement pattern %s literal on an agent with its own list', (token) => {
        const out = applyExtraDisallowedToolsToMarkdown(WITH_LIST, [token]);
        expect(out).toBe(`---\nname: x\ndescription: Test\ndisallowedTools: Write, Edit, ${token}\nmodel: haiku\n---\nBody\n`);
        expect(extractDisallowedTools(out)).toEqual(['Write', 'Edit', token]);
        expect(frontmatterLines(out)).toHaveLength(frontmatterLines(WITH_LIST).length);
        expectFrontmatterIntact(WITH_LIST, out);
    });
    test.each(REPLACEMENT_PATTERNS)('keeps the replacement pattern %s literal on an agent without a list', (token) => {
        const out = applyExtraDisallowedToolsToMarkdown(WITHOUT_LIST, [token]);
        expect(out).toBe(`---\nname: x\ndescription: Test\nmodel: sonnet\ndisallowedTools: ${token}\n---\nBody\n`);
        expectFrontmatterIntact(WITHOUT_LIST, out);
    });
    test('a value that tries to add a model line through a replacement pattern changes nothing', () => {
        const extra = getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: 'Foo$`model: opus' });
        expect(applyExtraDisallowedToolsToMarkdown(WITH_LIST, extra)).toBe(WITH_LIST);
        const ampersand = getExtraDisallowedTools({ [EXTRA_DISALLOWED_TOOLS_ENV]: 'Foo$&\nmodel: opus' });
        expect(applyExtraDisallowedToolsToMarkdown(WITH_LIST, ampersand)).toBe(WITH_LIST);
    });
    test.each([
        ['a line feed', 'x\nmodel: opus'],
        ['a carriage return and line feed', 'x\r\nmodel: opus'],
        ['U+0085', 'x\u0085model: opus'],
        ['U+2028', 'x\u2028model: opus'],
        ['U+2029', 'x\u2029model: opus'],
        ['a colon and a space', 'a: b'],
        ['a hash after a space', 'x #y'],
        ['quotes around the token', '"quoted"'],
        ['a document separator', '---'],
        ['a document separator in a model line', 'x\n---\nmodel: opus'],
    ])('skips a token with %s and keeps the agent file unchanged', (_name, token) => {
        expect(applyExtraDisallowedToolsToMarkdown(WITH_LIST, [token])).toBe(WITH_LIST);
        expect(applyExtraDisallowedToolsToMarkdown(WITHOUT_LIST, [token])).toBe(WITHOUT_LIST);
    });
    test('skips the unusable tokens and still applies the usable ones', () => {
        const out = applyExtraDisallowedToolsToMarkdown(WITH_LIST, ['a: b', 'Good', '#c', 'mcp__x__*']);
        expect(extractDisallowedTools(out)).toEqual(['Write', 'Edit', 'Good', 'mcp__x__*']);
        expectFrontmatterIntact(WITH_LIST, out);
    });
    test('handles a 10 000 character token', () => {
        const token = 'T'.repeat(10000);
        const out = applyExtraDisallowedToolsToMarkdown(WITH_LIST, [token]);
        expect(extractDisallowedTools(out)).toEqual(['Write', 'Edit', token]);
        expectFrontmatterIntact(WITH_LIST, out);
    });
    test('every desktop preset token and a custom pattern keep the frontmatter valid for every bundled agent', () => {
        const tokens = [...DESKTOP_PATTERNS, 'mcp__custom__*', 'Bash(git push:*)'];
        for (const token of tokens)
            expect(isPlainYamlToken(token)).toBe(true);
        for (const agent of AGENTS) {
            const original = readFileSync(join(AGENTS_DIR, `${agent}.md`), 'utf-8');
            const out = applyExtraDisallowedToolsToMarkdown(original, tokens);
            expect(extractDisallowedTools(out)).toEqual([...(extractDisallowedTools(original) ?? []), ...tokens]);
            expectFrontmatterIntact(original, out);
        }
    });
    test('every skipped token leaves every bundled agent file unchanged', () => {
        const skipped = ['a: b', 'x #y', '*alias', '*', '!tag', '@x', '%x', '`x', '- x', '? x', '{x}', '[a]', '}', ']', '|', '>', '&a', 'null', '123', 'a\u2028b'];
        for (const token of skipped)
            expect(isPlainYamlToken(token)).toBe(false);
        for (const agent of AGENTS) {
            const original = readFileSync(join(AGENTS_DIR, `${agent}.md`), 'utf-8');
            expect(applyExtraDisallowedToolsToMarkdown(original, skipped)).toBe(original);
        }
    });
    test('a hostile token never changes the other frontmatter keys of any bundled agent', () => {
        const hostile = [...REPLACEMENT_PATTERNS, 'T'.repeat(10000), 'a"b', "a'b", 'mcp__*__x*', 'a\tb'];
        for (const agent of AGENTS) {
            const original = readFileSync(join(AGENTS_DIR, `${agent}.md`), 'utf-8');
            for (const token of hostile) {
                const out = applyExtraDisallowedToolsToMarkdown(original, [token]);
                expect(extractDisallowedTools(out)).toEqual([...(extractDisallowedTools(original) ?? []), token]);
                expect(frontmatterLines(out)).toHaveLength(frontmatterLines(original).length + (extractDisallowedTools(original) ? 0 : 1));
                expectFrontmatterIntact(original, out);
            }
        }
    });
    test.each([
        ['an empty key', '---\nname: x\ndisallowedTools:\n---\nBody\n'],
        ['a block list', '---\nname: x\ndisallowedTools:\n  - Write\n  - Edit\n---\nBody\n'],
        ['a flow list', '---\nname: x\ndisallowedTools: [Write, Edit]\n---\nBody\n'],
        ['a trailing comment', '---\nname: x\ndisallowedTools: Write, Edit # read-only\n---\nBody\n'],
        ['CRLF with a flow list', '---\r\nname: x\r\ndisallowedTools: [Write]\r\n---\r\nBody\r\n'],
    ])('returns the content unchanged when the existing entry is %s', (_name, content) => {
        expect(applyExtraDisallowedToolsToMarkdown(content, ['Foo', 'mcp__x__*'])).toBe(content);
    });
    test('still rewrites a quoted existing list as plain text', () => {
        const out = applyExtraDisallowedToolsToMarkdown('---\nname: x\ndisallowedTools: "Write, Edit"\n---\nBody\n', ['Foo']);
        expect(out).toBe('---\nname: x\ndisallowedTools: Write, Edit, Foo\n---\nBody\n');
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
            const tools = defs[agent].disallowedTools;
            expect(tools.slice(0, own.length)).toEqual(own);
            for (const pattern of DESKTOP_PATTERNS) {
                expect(tools).toContain(pattern);
            }
            if (READ_ONLY_AGENTS.includes(agent)) {
                expect(tools.slice(0, 2)).toEqual(['Write', 'Edit']);
            }
            else {
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
        const find = (name) => collectCapabilitySurface().agents.find((a) => a.name === name);
        expect(find('executor').disallowedTools).toEqual([]);
        vi.stubEnv(EXTRA_DISALLOWED_TOOLS_ENV, 'mcp__custom__*');
        expect(find('executor').disallowedTools).toEqual(['mcp__custom__*']);
        expect(find('explore').disallowedTools).toEqual(['Edit', 'mcp__custom__*', 'Write']);
    });
});
describe('legacy agent install with OMC_AGENT_EXTRA_DISALLOWED_TOOLS', () => {
    let tempRoot;
    let originalClaudeConfigDir;
    let originalHome;
    let originalOmcPluginRoot;
    let originalClaudePluginRoot;
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
        const restore = (key, value) => {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        };
        restore('CLAUDE_CONFIG_DIR', originalClaudeConfigDir);
        restore('HOME', originalHome);
        restore('OMC_PLUGIN_ROOT', originalOmcPluginRoot);
        restore('CLAUDE_PLUGIN_ROOT', originalClaudePluginRoot);
        rmSync(tempRoot, { recursive: true, force: true });
        vi.resetModules();
    });
    async function installAgents(extra) {
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
    test('a token that is not a plain YAML value is skipped with one log line naming it, the rest is applied', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const claudeConfigDir = join(tempRoot, 'home', '.claude');
            process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
            process.env.HOME = join(tempRoot, 'home');
            vi.stubEnv(EXTRA_DISALLOWED_TOOLS_ENV, 'Good, a: b, mcp__server__*, Foo$`model: opus, x #y');
            vi.resetModules();
            const installer = await import('../installer/index.js');
            const result = installer.install({ skipClaudeCheck: true, skipHud: true, force: true, verbose: true });
            expect(result.success, `${result.message}\n${result.errors.join('\n')}`).toBe(true);
            const warnings = logSpy.mock.calls
                .map((call) => String(call[0]))
                .filter((line) => line.includes('Skipping extra disallowed tool'));
            expect(warnings).toHaveLength(3);
            expect(warnings.some((line) => line.includes('"a: b"'))).toBe(true);
            expect(warnings.some((line) => line.includes('"Foo$`model: opus"'))).toBe(true);
            expect(warnings.some((line) => line.includes('"x #y"'))).toBe(true);
            const installed = join(claudeConfigDir, 'agents');
            for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))) {
                const original = readFileSync(join(AGENTS_DIR, file), 'utf-8');
                const copy = readFileSync(join(installed, file), 'utf-8');
                expect(extractDisallowedTools(copy)).toEqual([...(extractDisallowedTools(original) ?? []), 'Good', 'mcp__server__*']);
                expectFrontmatterIntact(original, copy);
            }
        }
        finally {
            logSpy.mockRestore();
        }
    });
    test('a value that tries to inject a model line leaves every installed agent file as the bundled one', async () => {
        const installed = await installAgents('Foo$`model: opus');
        for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))) {
            expect(readFileSync(join(installed, file), 'utf-8')).toBe(readFileSync(join(AGENTS_DIR, file), 'utf-8'));
        }
    });
});
describe('agent cleanup with a copy that has the extra tools', () => {
    let tempDir;
    let originalConfigDir;
    const log = vi.fn();
    const extra = [...DESKTOP_PATTERNS];
    function historical(fixturePath) {
        return readFileSync(join(process.cwd(), 'src', 'installer', '__tests__', 'fixtures', 'historical-agents', fixturePath), 'utf-8');
    }
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'omc-agent-extra-cleanup-'));
        originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = tempDir;
        log.mockClear();
    });
    afterEach(() => {
        if (originalConfigDir === undefined)
            delete process.env.CLAUDE_CONFIG_DIR;
        else
            process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
        rmSync(tempDir, { recursive: true, force: true });
        vi.resetModules();
    });
    test('prunePluginDuplicateAgents removes an unchanged copy and keeps the copy with the extra tools', async () => {
        vi.resetModules();
        const { prunePluginDuplicateAgents, AGENTS_DIR: agentsDir } = await import('../installer/index.js');
        mkdirSync(agentsDir, { recursive: true });
        writeFileSync(join(agentsDir, 'architect.md'), historical('v4.5.0/architect.md'));
        const analyst = applyExtraDisallowedToolsToMarkdown(historical('v4.4.0/analyst.md'), extra);
        expect(analyst).not.toBe(historical('v4.4.0/analyst.md'));
        writeFileSync(join(agentsDir, 'analyst.md'), analyst);
        expect(prunePluginDuplicateAgents(log)).toEqual(['architect.md']);
        expect(existsSync(join(agentsDir, 'architect.md'))).toBe(false);
        expect(readFileSync(join(agentsDir, 'analyst.md'), 'utf-8')).toBe(analyst);
    });
    test('cleanupStaleAgents removes an unchanged stale agent and keeps the copy with the extra tools', async () => {
        vi.resetModules();
        const { cleanupStaleAgents, AGENTS_DIR: agentsDir } = await import('../installer/index.js');
        mkdirSync(agentsDir, { recursive: true });
        writeFileSync(join(agentsDir, 'build-fixer.md'), historical('build-fixer.md'));
        const deepExecutor = applyExtraDisallowedToolsToMarkdown(historical('deep-executor.md'), extra);
        expect(deepExecutor).not.toBe(historical('deep-executor.md'));
        writeFileSync(join(agentsDir, 'deep-executor.md'), deepExecutor);
        expect(cleanupStaleAgents(log)).toEqual(['build-fixer.md']);
        expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(false);
        expect(readFileSync(join(agentsDir, 'deep-executor.md'), 'utf-8')).toBe(deepExecutor);
    });
});
//# sourceMappingURL=agent-extra-disallowed-tools.test.js.map