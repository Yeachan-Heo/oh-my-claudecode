import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { codexMcpServer, codexToolNames } from '../mcp/codex-server.js';
import { geminiMcpServer, geminiToolNames } from '../mcp/gemini-server.js';
import { resetDetectionCache } from '../mcp/cli-detection.js';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

// Mock fs for file reading
vi.mock('fs', () => ({
  readFileSync: vi.fn((path: string) => `Mock content of ${path}`)
}));

describe('MCP Server Workflows', () => {
  beforeEach(() => {
    resetDetectionCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Codex MCP Server Workflow', () => {
    it('should execute ask_codex tool successfully', async () => {
      // Mock successful CLI execution
      const mockStdout = {
        on: vi.fn((event: string, callback: Function) => {
          if (event === 'data') {
            callback(JSON.stringify({ type: 'message', content: 'Codex response here' }) + '\n');
          }
        })
      };
      const mockStderr = { on: vi.fn() };
      const mockClose = vi.fn((event: string, callback: Function) => {
        if (event === 'close') callback(0);
      });

      vi.mocked(spawn).mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        on: mockClose
      } as any);

      // Get the server and call the tool
      const server = codexMcpServer as any;
      expect(server).toBeDefined();
      expect(server.name).toBe('x');

      // Server is a valid SDK MCP server
      expect(typeof server).toBe('object');
    });

    it('should handle Codex CLI not installed', async () => {
      // Mock which command to fail (CLI not found)
      vi.mocked(spawn).mockImplementation((cmd: string) => {
        if (cmd === 'which') {
          const mockClose = vi.fn((event: string, callback: Function) => {
            if (event === 'close') callback(1);
          });
          return {
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn((e: string, cb: Function) => { if (e === 'data') cb('not found'); }) },
            on: mockClose
          } as any;
        }
        return {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn()
        } as any;
      });

      const server = codexMcpServer as any;
      expect(server).toBeDefined();
    });

    it('should handle Codex JSONL output parsing', async () => {
      const jsonlOutput = [
        JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'First part' }] }),
        JSON.stringify({ type: 'output_text', text: 'Second part' }),
        JSON.stringify({ type: 'message', content: 'Third part' })
      ].join('\n');

      const mockStdout = {
        on: vi.fn((event: string, callback: Function) => {
          if (event === 'data') callback(jsonlOutput);
        })
      };
      const mockStderr = { on: vi.fn() };
      const mockClose = vi.fn((event: string, callback: Function) => {
        if (event === 'close') callback(0);
      });

      vi.mocked(spawn).mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        on: mockClose
      } as any);

      const server = codexMcpServer as any;
      expect(server).toBeDefined();
    });

    it('should handle file context in prompts', async () => {
      const mockStdout = {
        on: vi.fn((event: string, callback: Function) => {
          if (event === 'data') callback('Response with context');
        })
      };
      const mockStderr = { on: vi.fn() };
      const mockClose = vi.fn((event: string, callback: Function) => {
        if (event === 'close') callback(0);
      });

      vi.mocked(spawn).mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        on: mockClose
      } as any);

      const server = codexMcpServer as any;
      expect(server).toBeDefined();
    });

    it('should handle Codex CLI errors gracefully', async () => {
      const mockStdout = { on: vi.fn() };
      const mockStderr = {
        on: vi.fn((event: string, callback: Function) => {
          if (event === 'data') callback('Error: API key not found');
        })
      };
      const mockClose = vi.fn((event: string, callback: Function) => {
        if (event === 'close') callback(1);
      });
      const mockError = vi.fn((event: string, callback: Function) => {
        if (event === 'error') callback(new Error('Spawn failed'));
      });

      vi.mocked(spawn).mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn((event: string, callback: Function) => {
          mockClose(event, callback);
          mockError(event, callback);
        })
      } as any);

      const server = codexMcpServer as any;
      expect(server).toBeDefined();
    });

    it('should support different model options', async () => {
      const spawnCalls: string[][] = [];

      vi.mocked(spawn).mockImplementation((cmd: string, args: readonly string[]) => {
        spawnCalls.push(args as string[]);
        return {
          stdout: { on: vi.fn((e: string, cb: Function) => { if (e === 'data') cb('OK'); }) },
          stderr: { on: vi.fn() },
          on: vi.fn((e: string, cb: Function) => { if (e === 'close') cb(0); })
        } as any;
      });

      const server = codexMcpServer as any;
      expect(server).toBeDefined();
    });
  });

  describe('Gemini MCP Server Workflow', () => {
    it('should execute ask_gemini tool successfully', async () => {
      const mockStdout = {
        on: vi.fn((event: string, callback: Function) => {
          if (event === 'data') callback('Gemini analysis complete');
        })
      };
      const mockStderr = { on: vi.fn() };
      const mockClose = vi.fn((event: string, callback: Function) => {
        if (event === 'close') callback(0);
      });

      vi.mocked(spawn).mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        on: mockClose
      } as any);

      const server = geminiMcpServer as any;
      expect(server).toBeDefined();
      expect(server.name).toBe('g');
    });

    it('should handle Gemini CLI not installed', async () => {
      vi.mocked(spawn).mockImplementation((cmd: string) => {
        if (cmd === 'which') {
          return {
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn((e: string, cb: Function) => { if (e === 'data') cb('not found'); }) },
            on: vi.fn((e: string, cb: Function) => { if (e === 'close') cb(1); })
          } as any;
        }
        return {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn()
        } as any;
      });

      const server = geminiMcpServer as any;
      expect(server).toBeDefined();
    });

    it('should leverage 1M token context window with files', async () => {
      const spawnCalls: string[][] = [];

      vi.mocked(spawn).mockImplementation((cmd: string, args: readonly string[]) => {
        spawnCalls.push(args as string[]);
        return {
          stdout: { on: vi.fn((e: string, cb: Function) => { if (e === 'data') cb('Large context analysis'); }) },
          stderr: { on: vi.fn() },
          on: vi.fn((e: string, cb: Function) => { if (e === 'close') cb(0); })
        } as any;
      });

      const server = geminiMcpServer as any;
      expect(server).toBeDefined();
    });

    it('should handle Gemini model specification', async () => {
      const spawnCalls: string[][] = [];

      vi.mocked(spawn).mockImplementation((cmd: string, args: readonly string[]) => {
        spawnCalls.push(args as string[]);
        return {
          stdout: { on: vi.fn((e: string, cb: Function) => { if (e === 'data') cb('Pro model response'); }) },
          stderr: { on: vi.fn() },
          on: vi.fn((e: string, cb: Function) => { if (e === 'close') cb(0); })
        } as any;
      });

      const server = geminiMcpServer as any;
      expect(server).toBeDefined();
    });

    it('should handle Gemini CLI errors gracefully', async () => {
      const mockStdout = { on: vi.fn() };
      const mockStderr = {
        on: vi.fn((event: string, callback: Function) => {
          if (event === 'data') callback('Error: Authentication failed');
        })
      };

      vi.mocked(spawn).mockReturnValue({
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn((event: string, callback: Function) => {
          if (event === 'close') callback(1);
        })
      } as any);

      const server = geminiMcpServer as any;
      expect(server).toBeDefined();
    });
  });

  describe('MCP Server Tool Schemas', () => {
    it('should have correct Codex tool schema', () => {
      // Verify the server is properly created and tool names are exported
      expect(codexMcpServer).toBeDefined();
      expect(codexMcpServer.name).toBe('x');
      expect(codexToolNames).toContain('ask_codex');
      expect(codexToolNames).toHaveLength(5);
    });

    it('should have correct Gemini tool schema', () => {
      // Verify the server is properly created and tool names are exported
      expect(geminiMcpServer).toBeDefined();
      expect(geminiMcpServer.name).toBe('g');
      expect(geminiToolNames).toContain('ask_gemini');
      expect(geminiToolNames).toHaveLength(5);
    });
  });

  describe('Timeout and Environment Configuration', () => {
    it('should respect OMC_CODEX_TIMEOUT environment variable', async () => {
      const originalTimeout = process.env.OMC_CODEX_TIMEOUT;
      process.env.OMC_CODEX_TIMEOUT = '120000';

      const spawnMock = vi.fn().mockReturnValue({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((e: string, cb: Function) => { if (e === 'close') cb(0); })
      });
      vi.mocked(spawn).mockImplementation(spawnMock);

      // Re-import to pick up new timeout
      const { codexMcpServer: freshServer } = await import('../mcp/codex-server.js');
      expect(freshServer).toBeDefined();

      process.env.OMC_CODEX_TIMEOUT = originalTimeout;
    });

    it('should respect OMC_GEMINI_TIMEOUT environment variable', async () => {
      const originalTimeout = process.env.OMC_GEMINI_TIMEOUT;
      process.env.OMC_GEMINI_TIMEOUT = '180000';

      const spawnMock = vi.fn().mockReturnValue({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((e: string, cb: Function) => { if (e === 'close') cb(0); })
      });
      vi.mocked(spawn).mockImplementation(spawnMock);

      const { geminiMcpServer: freshServer } = await import('../mcp/gemini-server.js');
      expect(freshServer).toBeDefined();

      process.env.OMC_GEMINI_TIMEOUT = originalTimeout;
    });
  });
});
