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
      expect(prompt).toMatch(/architect|Oracle|debugging/i);
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

  describe('provider-aware loading', () => {
    test('loadAgentPrompt with codex provider returns prompt without XML tags', () => {
      const prompt = loadAgentPrompt('architect', 'codex');
      expect(prompt).toBeTruthy();
      expect(prompt).not.toContain('<Agent_Prompt>');
      expect(prompt).not.toContain('<Role>');
    });

    test('loadAgentPrompt without provider returns Claude-style prompt with XML tags', () => {
      const prompt = loadAgentPrompt('architect');
      expect(prompt).toBeTruthy();
      expect(prompt).toContain('<Agent_Prompt>');
    });

    test('loadAgentPrompt with codex provider returns flat markdown style', () => {
      const prompt = loadAgentPrompt('architect', 'codex');
      expect(prompt).toContain('**Role**');
    });

    test('loadAgentPrompt with codex provider falls back for nonexistent agent', () => {
      const prompt = loadAgentPrompt('nonexistent-agent-xyz', 'codex');
      // Should fall back to the default agents/ directory fallback
      expect(prompt).toContain('Agent: nonexistent-agent-xyz');
      expect(prompt).toContain('Prompt unavailable');
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
