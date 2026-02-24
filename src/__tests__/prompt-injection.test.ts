import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveSystemPrompt, buildPromptWithSystemContext, VALID_AGENT_ROLES, getValidAgentRoles, isValidAgentRoleName, SUBAGENT_HEADER } from '../mcp/prompt-injection.js';

describe('prompt-injection', () => {
  describe('VALID_AGENT_ROLES', () => {
    test('contains expected agent roles', () => {
      expect(VALID_AGENT_ROLES).toContain('architect');
      expect(VALID_AGENT_ROLES).toContain('executor');
      expect(VALID_AGENT_ROLES).toContain('designer');
      expect(VALID_AGENT_ROLES).toContain('planner');
      expect(VALID_AGENT_ROLES).toContain('critic');
    });

    test('is immutable (readonly array)', () => {
      // TypeScript enforces this at compile time, but we can verify the array exists
      expect(Array.isArray(VALID_AGENT_ROLES)).toBe(true);
      expect(VALID_AGENT_ROLES.length).toBeGreaterThanOrEqual(21);
    });

    test('includes all agents with .md files', () => {
      // Verify known agents that have .md files are included
      expect(VALID_AGENT_ROLES).toContain('debugger');
      expect(VALID_AGENT_ROLES).toContain('verifier');
      expect(VALID_AGENT_ROLES).toContain('quality-reviewer');
      expect(VALID_AGENT_ROLES).toContain('code-reviewer');
      expect(VALID_AGENT_ROLES).toContain('document-specialist');
    });
  });

  describe('getValidAgentRoles', () => {
    test('returns array of role names from agents/*.md files', () => {
      const roles = getValidAgentRoles();
      expect(Array.isArray(roles)).toBe(true);
      expect(roles.length).toBeGreaterThanOrEqual(21);
      // Should be sorted
      expect(roles).toEqual([...roles].sort());
    });

    test('returns cached result on subsequent calls', () => {
      const first = getValidAgentRoles();
      const second = getValidAgentRoles();
      expect(first).toBe(second); // Same reference due to caching
    });
  });

  describe('isValidAgentRoleName', () => {
    test('returns true for valid role names', () => {
      expect(isValidAgentRoleName('architect')).toBe(true);
      expect(isValidAgentRoleName('executor-high')).toBe(true);
      expect(isValidAgentRoleName('product-manager')).toBe(true);
      expect(isValidAgentRoleName('code-reviewer')).toBe(true);
      expect(isValidAgentRoleName('test123')).toBe(true);
    });

    test('returns false for invalid role names', () => {
      expect(isValidAgentRoleName('')).toBe(false);
      expect(isValidAgentRoleName('architect_medium')).toBe(false); // underscore
      expect(isValidAgentRoleName('architect.medium')).toBe(false); // dot
      expect(isValidAgentRoleName('architect medium')).toBe(false); // space
      expect(isValidAgentRoleName('../../etc/passwd')).toBe(false); // path traversal
      expect(isValidAgentRoleName('architect;rm -rf')).toBe(false); // special chars
    });
  });

  describe('resolveSystemPrompt', () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleWarnSpy.mockRestore();
    });

    test('returns system_prompt when provided', () => {
      const result = resolveSystemPrompt('You are a reviewer', undefined);
      expect(result).toBe('You are a reviewer');
    });

    test('trims system_prompt', () => {
      const result = resolveSystemPrompt('  You are a reviewer  ', undefined);
      expect(result).toBe('You are a reviewer');
    });

    test('system_prompt takes precedence over agent_role', () => {
      const result = resolveSystemPrompt('Custom prompt', 'architect');
      expect(result).toBe('Custom prompt');
    });

    test('loads agent prompt when agent_role provided', () => {
      const result = resolveSystemPrompt(undefined, 'architect');
      expect(result).toBeDefined();
      expect(result).not.toContain('Prompt unavailable');
      // Architect prompt should contain meaningful content
      expect(result!.length).toBeGreaterThan(50);
    });

    test('loads different agent roles correctly', () => {
      const architect = resolveSystemPrompt(undefined, 'architect');
      const executor = resolveSystemPrompt(undefined, 'executor');
      const designer = resolveSystemPrompt(undefined, 'designer');

      expect(architect).toBeDefined();
      expect(executor).toBeDefined();
      expect(designer).toBeDefined();

      // They should be different prompts
      expect(architect).not.toBe(executor);
      expect(executor).not.toBe(designer);
    });

    test('returns undefined for invalid agent_role', () => {
      const result = resolveSystemPrompt(undefined, 'nonexistent-agent-xyz');
      expect(result).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('nonexistent-agent-xyz')
      );
    });

    test('returns undefined when neither param provided', () => {
      const result = resolveSystemPrompt(undefined, undefined);
      expect(result).toBeUndefined();
    });

    test('returns undefined for empty strings', () => {
      expect(resolveSystemPrompt('', '')).toBeUndefined();
      expect(resolveSystemPrompt('  ', '  ')).toBeUndefined();
    });

    test('trims agent_role before lookup', () => {
      const result = resolveSystemPrompt(undefined, '  architect  ');
      expect(result).toBeDefined();
      expect(result).not.toContain('Prompt unavailable');
    });

    test('empty system_prompt falls back to agent_role', () => {
      const result = resolveSystemPrompt('', 'architect');
      expect(result).toBeDefined();
      expect(result).not.toContain('Prompt unavailable');
      expect(result!.length).toBeGreaterThan(50);
    });

    test('whitespace-only system_prompt falls back to agent_role', () => {
      const result = resolveSystemPrompt('   ', 'architect');
      expect(result).toBeDefined();
      expect(result).not.toContain('Prompt unavailable');
    });
  });

  describe('buildPromptWithSystemContext', () => {
    test('returns subagent header + user prompt when no extras', () => {
      const result = buildPromptWithSystemContext('Hello', undefined, undefined);
      expect(result).toBe(`${SUBAGENT_HEADER}\n\nHello`);
    });

    test('prepends system prompt with delimiters', () => {
      const result = buildPromptWithSystemContext('Hello', undefined, 'You are a reviewer');
      expect(result).toContain('<system-instructions>');
      expect(result).toContain('You are a reviewer');
      expect(result).toContain('</system-instructions>');
      expect(result.indexOf('system-instructions')).toBeLessThan(result.indexOf('Hello'));
    });

    test('orders: system > files > user', () => {
      const result = buildPromptWithSystemContext('User prompt', 'File contents', 'System prompt');
      const sysIdx = result.indexOf('System prompt');
      const fileIdx = result.indexOf('File contents');
      const userIdx = result.indexOf('User prompt');
      expect(sysIdx).toBeLessThan(fileIdx);
      expect(fileIdx).toBeLessThan(userIdx);
    });

    test('handles file context without system prompt', () => {
      const result = buildPromptWithSystemContext('Hello', 'File contents', undefined);
      expect(result).not.toContain('system-instructions');
      expect(result).toContain('File contents');
      expect(result).toContain('Hello');
      // File context should come before user prompt
      expect(result.indexOf('File contents')).toBeLessThan(result.indexOf('Hello'));
    });

    test('handles system prompt without file context', () => {
      const result = buildPromptWithSystemContext('Hello', undefined, 'System prompt');
      expect(result).toContain('<system-instructions>');
      expect(result).toContain('System prompt');
      expect(result).toContain('Hello');
      expect(result).not.toContain('File contents');
    });

    test('separates sections with double newlines', () => {
      const result = buildPromptWithSystemContext('User', 'Files', 'System');
      // Should have double newline separators between sections
      expect(result).toContain('</system-instructions>\n\nFiles');
      expect(result).toContain('Files\n\nUser');
    });

    test('preserves multiline content in each section', () => {
      const systemPrompt = 'Line 1\nLine 2\nLine 3';
      const fileContext = 'File line 1\nFile line 2';
      const userPrompt = 'User line 1\nUser line 2';

      const result = buildPromptWithSystemContext(userPrompt, fileContext, systemPrompt);

      expect(result).toContain('Line 1\nLine 2\nLine 3');
      expect(result).toContain('File line 1\nFile line 2');
      expect(result).toContain('User line 1\nUser line 2');
    });

    test('handles empty string file context as falsy', () => {
      const result = buildPromptWithSystemContext('Hello', '', 'System');
      // Empty string should be treated as no file context
      expect(result).not.toContain('\n\n\n\n'); // No extra blank sections
    });
  });

  describe('integration: resolveSystemPrompt + buildPromptWithSystemContext', () => {
    test('full flow with agent_role', () => {
      const systemPrompt = resolveSystemPrompt(undefined, 'architect');
      const fileContext = '--- File: test.ts ---\nconst x = 1;';
      const userPrompt = 'Review this code';

      const result = buildPromptWithSystemContext(userPrompt, fileContext, systemPrompt);

      expect(result).toContain('<system-instructions>');
      expect(result).toContain('</system-instructions>');
      expect(result).toContain('--- File: test.ts ---');
      expect(result).toContain('Review this code');

      // Verify ordering
      const sysEnd = result.indexOf('</system-instructions>');
      const fileStart = result.indexOf('--- File:');
      const userStart = result.indexOf('Review this code');

      expect(sysEnd).toBeLessThan(fileStart);
      expect(fileStart).toBeLessThan(userStart);
    });

    test('full flow with explicit system_prompt', () => {
      const systemPrompt = resolveSystemPrompt('You are a code reviewer', 'architect');
      const result = buildPromptWithSystemContext('Review this', undefined, systemPrompt);

      // Should use explicit system_prompt, not architect's
      expect(result).toContain('You are a code reviewer');
      expect(result).toContain('Review this');
    });

    test('full flow with no system prompt', () => {
      const systemPrompt = resolveSystemPrompt(undefined, undefined);
      const result = buildPromptWithSystemContext('Hello', '--- File ---', systemPrompt);

      expect(result).not.toContain('system-instructions');
      expect(result).toContain('--- File ---');
      expect(result).toContain('Hello');
    });
  });
});
