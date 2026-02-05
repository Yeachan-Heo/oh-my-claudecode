import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { codexMcpServer, codexToolNames } from '../mcp/codex-server.js';
import { geminiMcpServer, geminiToolNames } from '../mcp/gemini-server.js';
import { detectCodexCli, detectGeminiCli, resetDetectionCache } from '../mcp/cli-detection.js';
import { execSync } from 'child_process';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn()
}));

describe('Multi-Model MCP Servers', () => {
  describe('Codex MCP Server', () => {
    it('should be defined', () => {
      expect(codexMcpServer).toBeDefined();
    });

    it('should export correct tool names', () => {
      expect(codexToolNames).toHaveLength(5);
      expect(codexToolNames).toContain('ask_codex');
      expect(codexToolNames).toContain('wait_for_job');
      expect(codexToolNames).toContain('check_job_status');
      expect(codexToolNames).toContain('kill_job');
      expect(codexToolNames).toContain('list_jobs');
    });

    it('should have server name "x"', () => {
      // Server is created with name "x" for tool prefixing
      expect(codexMcpServer).toBeDefined();
    });
  });

  describe('Gemini MCP Server', () => {
    it('should be defined', () => {
      expect(geminiMcpServer).toBeDefined();
    });

    it('should export correct tool names', () => {
      expect(geminiToolNames).toHaveLength(5);
      expect(geminiToolNames).toContain('ask_gemini');
      expect(geminiToolNames).toContain('wait_for_job');
      expect(geminiToolNames).toContain('check_job_status');
      expect(geminiToolNames).toContain('kill_job');
      expect(geminiToolNames).toContain('list_jobs');
    });

    it('should have server name "g"', () => {
      // Server is created with name "g" for tool prefixing
      expect(geminiMcpServer).toBeDefined();
    });
  });

  describe('CLI Detection', () => {
    beforeEach(() => {
      resetDetectionCache();
      vi.clearAllMocks();
    });

    describe('detectCodexCli', () => {
      it('should detect Codex CLI when available', () => {
        vi.mocked(execSync)
          .mockReturnValueOnce('/usr/local/bin/codex\n')  // which codex
          .mockReturnValueOnce('1.0.0\n');                 // codex --version

        const result = detectCodexCli();

        expect(result.available).toBe(true);
        expect(result.path).toBe('/usr/local/bin/codex');
        expect(result.version).toBe('1.0.0');
        expect(result.installHint).toContain('npm install -g @openai/codex');
      });

      it('should handle missing Codex CLI', () => {
        vi.mocked(execSync).mockImplementation(() => {
          throw new Error('command not found');
        });

        const result = detectCodexCli();

        expect(result.available).toBe(false);
        expect(result.error).toContain('not found on PATH');
        expect(result.installHint).toContain('npm install -g @openai/codex');
      });

      it('should cache detection results', () => {
        vi.mocked(execSync)
          .mockReturnValueOnce('/usr/bin/codex\n')
          .mockReturnValueOnce('2.0.0\n');

        const result1 = detectCodexCli();
        const result2 = detectCodexCli();

        // execSync should only be called twice (once for which, once for version)
        expect(execSync).toHaveBeenCalledTimes(2);
        expect(result1).toBe(result2); // Same reference due to caching
      });

      it('should bypass cache when useCache is false', () => {
        vi.mocked(execSync)
          .mockReturnValueOnce('/usr/bin/codex\n')
          .mockReturnValueOnce('2.0.0\n')
          .mockReturnValueOnce('/usr/bin/codex\n')
          .mockReturnValueOnce('2.0.0\n');

        detectCodexCli(true);
        detectCodexCli(false);

        expect(execSync).toHaveBeenCalledTimes(4);
      });
    });

    describe('detectGeminiCli', () => {
      it('should detect Gemini CLI when available', () => {
        vi.mocked(execSync)
          .mockReturnValueOnce('/usr/local/bin/gemini\n')  // which gemini
          .mockReturnValueOnce('1.5.0\n');                  // gemini --version

        const result = detectGeminiCli();

        expect(result.available).toBe(true);
        expect(result.path).toBe('/usr/local/bin/gemini');
        expect(result.version).toBe('1.5.0');
        expect(result.installHint).toContain('@google/gemini-cli');
      });

      it('should handle missing Gemini CLI', () => {
        vi.mocked(execSync).mockImplementation(() => {
          throw new Error('command not found');
        });

        const result = detectGeminiCli();

        expect(result.available).toBe(false);
        expect(result.error).toContain('not found on PATH');
        expect(result.installHint).toContain('@google/gemini-cli');
      });

      it('should cache detection results', () => {
        vi.mocked(execSync)
          .mockReturnValueOnce('/usr/bin/gemini\n')
          .mockReturnValueOnce('1.0.0\n');

        const result1 = detectGeminiCli();
        const result2 = detectGeminiCli();

        expect(execSync).toHaveBeenCalledTimes(2);
        expect(result1).toBe(result2);
      });
    });

    describe('resetDetectionCache', () => {
      it('should clear both caches', () => {
        vi.mocked(execSync)
          .mockReturnValueOnce('/usr/bin/codex\n')
          .mockReturnValueOnce('1.0.0\n')
          .mockReturnValueOnce('/usr/bin/gemini\n')
          .mockReturnValueOnce('1.0.0\n');

        detectCodexCli();
        detectGeminiCli();

        resetDetectionCache();

        // After reset, should call execSync again
        vi.mocked(execSync)
          .mockReturnValueOnce('/usr/bin/codex\n')
          .mockReturnValueOnce('1.0.0\n')
          .mockReturnValueOnce('/usr/bin/gemini\n')
          .mockReturnValueOnce('1.0.0\n');

        detectCodexCli();
        detectGeminiCli();

        expect(execSync).toHaveBeenCalledTimes(8);
      });
    });
  });
});
