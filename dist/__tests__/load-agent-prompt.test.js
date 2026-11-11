import { describe, test, expect } from 'vitest';
import { loadAgentPrompt, stripFrontmatter, extractDisallowedTools } from '../agents/utils.js';
describe('loadAgentPrompt', () => {
    describe('valid agent names', () => {
        test('loads an existing agent prompt with frontmatter', () => {
            const prompt = loadAgentPrompt('architect');
            expect(prompt).toBeTruthy();
            expect(prompt.length).toBeGreaterThan(100);
            // Should NOT contain frontmatter
            expect(prompt).not.toMatch(/^---/);
            // Should contain actual prompt content
            expect(prompt).toMatch(/architect|debugging/i);
        });
        test('loads different agents correctly', () => {
            const executor = loadAgentPrompt('executor');
            const explore = loadAgentPrompt('explore');
            expect(executor).toBeTruthy();
            expect(explore).toBeTruthy();
            expect(executor).not.toBe(explore);
        });
        test('handles agent names with hyphens', () => {
            const prompt = loadAgentPrompt('qa-tester');
            expect(prompt).toBeTruthy();
            expect(prompt.length).toBeGreaterThan(100);
        });
        test('loads tracer with evidence-driven tracing contract', () => {
            const prompt = loadAgentPrompt('tracer');
            expect(prompt).toBeTruthy();
            expect(prompt.length).toBeGreaterThan(100);
            expect(prompt).toMatch(/observation/i);
            expect(prompt).toMatch(/hypotheses?|hypothesis table/i);
            expect(prompt).toMatch(/evidence for/i);
            expect(prompt).toMatch(/evidence against|gaps/i);
            expect(prompt).toMatch(/next probe/i);
        });
    });
    describe('security: path traversal prevention', () => {
        test('rejects agent names with path traversal sequences', () => {
            expect(() => loadAgentPrompt('../etc/passwd')).toThrow('Invalid agent name');
            expect(() => loadAgentPrompt('../../etc/passwd')).toThrow('Invalid agent name');
            expect(() => loadAgentPrompt('foo/../bar')).toThrow('Invalid agent name');
        });
        test('rejects agent names with forward slashes', () => {
            expect(() => loadAgentPrompt('foo/bar')).toThrow('Invalid agent name');
            expect(() => loadAgentPrompt('/etc/passwd')).toThrow('Invalid agent name');
        });
        test('rejects agent names with backslashes', () => {
            expect(() => loadAgentPrompt('foo\\bar')).toThrow('Invalid agent name');
            expect(() => loadAgentPrompt('..\\..\\etc\\passwd')).toThrow('Invalid agent name');
        });
        test('rejects agent names with special characters', () => {
            expect(() => loadAgentPrompt('foo@bar')).toThrow('Invalid agent name');
            expect(() => loadAgentPrompt('foo$bar')).toThrow('Invalid agent name');
            expect(() => loadAgentPrompt('foo bar')).toThrow('Invalid agent name');
            expect(() => loadAgentPrompt('foo.bar')).toThrow('Invalid agent name');
        });
        test('allows valid agent names only', () => {
            // These should not throw
            expect(() => loadAgentPrompt('architect')).not.toThrow();
            expect(() => loadAgentPrompt('qa-tester')).not.toThrow();
            expect(() => loadAgentPrompt('explore')).not.toThrow();
        });
    });
    describe('error handling', () => {
        test('returns fallback for nonexistent agent', () => {
            const result = loadAgentPrompt('nonexistent-agent-xyz');
            expect(result).toContain('Agent: nonexistent-agent-xyz');
            expect(result).toContain('Prompt unavailable');
        });
        test('fallback does not leak internal paths', () => {
            const result = loadAgentPrompt('nonexistent-agent-xyz');
            expect(result).not.toContain('/home');
            expect(result).not.toContain('agents/');
            expect(result).not.toContain('.md');
        });
    });
});
describe('agent frontmatter helpers', () => {
    test('stripFrontmatter keeps the body when a frontmatter value contains ---', () => {
        const content = '---\nname: x\ndescription: Use for a --- separator\n---\nBody text';
        expect(stripFrontmatter(content)).toBe('Body text');
    });
    test('stripFrontmatter removes frontmatter after a UTF-8 BOM', () => {
        expect(stripFrontmatter('﻿---\nname: x\n---\nBody text')).toBe('Body text');
    });
    test('stripFrontmatter does not treat a leading horizontal rule as frontmatter', () => {
        expect(stripFrontmatter('---not frontmatter---\nBody')).toBe('---not frontmatter---\nBody');
    });
    test('extractDisallowedTools reads the list after a UTF-8 BOM', () => {
        expect(extractDisallowedTools('﻿---\nname: x\ndisallowedTools: Write, Edit\n---\nBody')).toEqual(['Write', 'Edit']);
    });
    test('extractDisallowedTools ignores disallowedTools text in the body', () => {
        expect(extractDisallowedTools('---\nname: x\n---\ndisallowedTools: Write')).toBeUndefined();
    });
    test('extractDisallowedTools reads the list when a value contains ---', () => {
        const content = '---\ndescription: a --- b\ndisallowedTools: Write, Edit\n---\nBody';
        expect(extractDisallowedTools(content)).toEqual(['Write', 'Edit']);
    });
});
//# sourceMappingURL=load-agent-prompt.test.js.map