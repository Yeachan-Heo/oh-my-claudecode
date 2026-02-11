import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAskCodex } from '../mcp/codex-core.js';
import { handleAskGemini } from '../mcp/gemini-core.js';

// Mock CLI detection to return available
vi.mock('../mcp/cli-detection.js', () => ({
  detectCodexCli: vi.fn(() => ({ available: true, path: '/usr/bin/codex', version: '1.0.0', installHint: '' })),
  detectGeminiCli: vi.fn(() => ({ available: true, path: '/usr/bin/gemini', version: '1.0.0', installHint: '' })),
  resetDetectionCache: vi.fn(),
}));

// Mock child_process to avoid actual CLI calls
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

describe('prompt_file-only enforcement', () => {
  describe('handleAskCodex', () => {
    it('should return error when neither prompt nor prompt_file is provided', async () => {
      const result = await handleAskCodex({
        agent_role: 'architect',
        output_file: '/tmp/test-output.md',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Either 'prompt' (inline) or 'prompt_file' (file path) is required");
    });

    it('should return error when prompt_file is empty string', async () => {
      const result = await handleAskCodex({
        prompt_file: '',
        agent_role: 'architect',
        output_file: '/tmp/test-output.md',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Either 'prompt' (inline) or 'prompt_file' (file path) is required");
    });

    it('should return error for invalid agent_role', async () => {
      const result = await handleAskCodex({
        prompt_file: 'some-file.md',
        agent_role: 'invalid_role', // underscore is not allowed (security check)
        output_file: '/tmp/test-output.md',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid agent_role');
    });

    it('should return error for unknown but syntactically valid agent_role', async () => {
      const result = await handleAskCodex({
        prompt_file: 'some-file.md',
        agent_role: 'totally-fake-agent', // passes regex but not in allowlist
        output_file: '/tmp/test-output.md',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown agent_role');
    });
  });

  describe('handleAskGemini', () => {
    it('should return error when neither prompt nor prompt_file is provided', async () => {
      const result = await handleAskGemini({
        agent_role: 'designer',
        output_file: '/tmp/test-output.md',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/prompt.*required/i);
    });

    it('should return error when prompt_file is empty string', async () => {
      const result = await handleAskGemini({
        prompt_file: '',
        agent_role: 'designer',
        output_file: '/tmp/test-output.md',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/prompt.*required/i);
    });

    it('should return error for invalid agent_role', async () => {
      const result = await handleAskGemini({
        prompt_file: 'some-file.md',
        agent_role: 'invalid_role', // underscore is not allowed (security check)
        output_file: '/tmp/test-output.md',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid agent_role');
    });

    it('should return error for unknown but syntactically valid agent_role', async () => {
      const result = await handleAskGemini({
        prompt_file: 'some-file.md',
        agent_role: 'totally-fake-agent', // passes regex but not in allowlist
        output_file: '/tmp/test-output.md',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown agent_role');
    });
  });
});

describe('inline prompt mode', () => {
  describe('handleAskCodex', () => {
    it('should accept inline prompt and auto-persist to file', async () => {
      // Inline prompt should be written to .omc/prompts/ and the flow should proceed
      // It will fail at CLI execution (not mocked for full flow) but should NOT fail
      // at parameter validation
      const result = await handleAskCodex({
        prompt: 'Analyze the architecture of this project',
        agent_role: 'architect',
      });
      // Should not get a parameter validation error
      if (result.isError) {
        expect(result.content[0].text).not.toContain("Either 'prompt' (inline) or 'prompt_file' (file path) is required");
        expect(result.content[0].text).not.toContain('output_file is required');
      }
    });

    it('should require output_file when prompt_file is used (backward compat)', async () => {
      const result = await handleAskCodex({
        prompt_file: 'some-file.md',
        agent_role: 'architect',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('output_file is required');
    });

    it('should prefer prompt_file over inline prompt when both provided', async () => {
      // When both are provided, prompt_file takes precedence, so isInlineMode is false
      // Without output_file and using prompt_file, it should require output_file
      const result = await handleAskCodex({
        prompt: 'inline prompt text',
        prompt_file: 'some-file.md',
        agent_role: 'architect',
      });
      expect(result.isError).toBe(true);
      // Because prompt_file is used (not inline mode), output_file is required
      expect(result.content[0].text).toContain('output_file is required');
    });

    it('should error when neither prompt nor prompt_file is provided', async () => {
      const result = await handleAskCodex({
        agent_role: 'architect',
        output_file: '/tmp/test-output.md',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Either 'prompt' (inline) or 'prompt_file' (file path) is required");
    });
  });

  describe('handleAskGemini', () => {
    it('should accept inline prompt and auto-persist to file', async () => {
      const result = await handleAskGemini({
        prompt: 'Review the UI design patterns',
        agent_role: 'designer',
      });
      // Should not get a parameter validation error
      if (result.isError) {
        expect(result.content[0].text).not.toMatch(/prompt.*required/i);
        expect(result.content[0].text).not.toContain('output_file is required');
      }
    });

    it('should require output_file when prompt_file is used (backward compat)', async () => {
      const result = await handleAskGemini({
        prompt_file: 'some-file.md',
        agent_role: 'designer',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('output_file is required');
    });

    it('should prefer prompt_file over inline prompt when both provided', async () => {
      const result = await handleAskGemini({
        prompt: 'inline prompt text',
        prompt_file: 'some-file.md',
        agent_role: 'designer',
      });
      expect(result.isError).toBe(true);
      // Because prompt_file is used (not inline mode), output_file is required
      expect(result.content[0].text).toContain('output_file is required');
    });

    it('should error when neither prompt nor prompt_file is provided', async () => {
      const result = await handleAskGemini({
        agent_role: 'designer',
        output_file: '/tmp/test-output.md',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/prompt.*required/i);
    });
  });
});
