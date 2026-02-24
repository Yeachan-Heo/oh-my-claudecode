import { describe, test, expect } from 'vitest';
import { loadAgentPrompt } from '../agents/utils.js';

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
      expect(() => loadAgentPrompt('explore-high')).not.toThrow();
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
