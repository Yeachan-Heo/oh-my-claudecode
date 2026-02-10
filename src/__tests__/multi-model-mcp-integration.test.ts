import { describe, it, expect } from 'vitest';
import { createSisyphusSession } from '../index.js';

describe('Multi-Model MCP Integration', () => {
  describe('createSisyphusSession', () => {
    it('should include Codex MCP server in mcpServers', () => {
      const session = createSisyphusSession();

      expect(session.queryOptions.options.mcpServers).toHaveProperty('x');
      expect(session.queryOptions.options.mcpServers['x']).toBeDefined();
    });

    it('should include Gemini MCP server in mcpServers', () => {
      const session = createSisyphusSession();

      expect(session.queryOptions.options.mcpServers).toHaveProperty('g');
      expect(session.queryOptions.options.mcpServers['g']).toBeDefined();
    });

    it('should include OMC Tools MCP server in mcpServers', () => {
      const session = createSisyphusSession();

      expect(session.queryOptions.options.mcpServers).toHaveProperty('t');
      expect(session.queryOptions.options.mcpServers['t']).toBeDefined();
    });

    it('should add Codex tool pattern to allowedTools', () => {
      const session = createSisyphusSession();

      expect(session.queryOptions.options.allowedTools).toContain('mcp__x__*');
    });

    it('should add Gemini tool pattern to allowedTools', () => {
      const session = createSisyphusSession();

      expect(session.queryOptions.options.allowedTools).toContain('mcp__g__*');
    });

    it('should include standard tools in allowedTools', () => {
      const session = createSisyphusSession();
      const allowedTools = session.queryOptions.options.allowedTools;

      expect(allowedTools).toContain('Read');
      expect(allowedTools).toContain('Bash');
      expect(allowedTools).toContain('Task');
    });

    it('should have OMC tools with mcp__t__ prefix', () => {
      const session = createSisyphusSession();
      const allowedTools = session.queryOptions.options.allowedTools;

      const omcTools = allowedTools.filter((t: string) => t.startsWith('mcp__t__'));
      expect(omcTools.length).toBeGreaterThan(0);
    });

    it('should export Codex and Gemini servers from main module', async () => {
      const index = await import('../index.js');

      // The servers themselves are not exported directly, but they should be
      // accessible via createSisyphusSession
      expect(index.createSisyphusSession).toBeDefined();
    });
  });

  describe('MCP Server Exports', () => {
    it('should export Codex server from mcp module', async () => {
      const mcp = await import('../mcp/index.js');

      expect(mcp.codexMcpServer).toBeDefined();
      expect(mcp.codexToolNames).toBeDefined();
      expect(mcp.codexToolNames).toContain('ask_codex');
    });

    it('should export Gemini server from mcp module', async () => {
      const mcp = await import('../mcp/index.js');

      expect(mcp.geminiMcpServer).toBeDefined();
      expect(mcp.geminiToolNames).toBeDefined();
      expect(mcp.geminiToolNames).toContain('ask_gemini');
    });

    it('should export OMC Tools server from mcp module', async () => {
      const mcp = await import('../mcp/index.js');

      expect(mcp.omcToolsServer).toBeDefined();
      expect(mcp.omcToolNames).toBeDefined();
      expect(mcp.getOmcToolNames).toBeDefined();
    });
  });
});
