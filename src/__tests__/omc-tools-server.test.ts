import { describe, it, expect } from 'vitest';
import { omcToolsServer, omcToolNames, getOmcToolNames } from '../mcp/omc-tools-server.js';

describe('omc-tools-server', () => {
  describe('omcToolNames', () => {
    it('should export 35 tools total', () => {
      expect(omcToolNames).toHaveLength(35);
    });

    it('should have 12 LSP tools', () => {
      const lspTools = omcToolNames.filter(n => n.includes('lsp_'));
      expect(lspTools).toHaveLength(12);
    });

    it('should have 2 AST tools', () => {
      const astTools = omcToolNames.filter(n => n.includes('ast_'));
      expect(astTools).toHaveLength(2);
    });

    it('should have python_repl tool', () => {
      expect(omcToolNames).toContain('mcp__t__python_repl');
    });

    it('should use correct MCP naming format', () => {
      omcToolNames.forEach(name => {
        expect(name).toMatch(/^mcp__t__/);
      });
    });
  });

  describe('getOmcToolNames', () => {
    it('should return all tools by default', () => {
      const tools = getOmcToolNames();
      expect(tools).toHaveLength(35);
    });

    it('should filter out LSP tools when includeLsp is false', () => {
      const tools = getOmcToolNames({ includeLsp: false });
      expect(tools.some(t => t.includes('lsp_'))).toBe(false);
      expect(tools).toHaveLength(23); // 2 AST + 1 python + 3 skills + 5 state + 6 notepad + 4 memory + 2 trace
    });

    it('should filter out AST tools when includeAst is false', () => {
      const tools = getOmcToolNames({ includeAst: false });
      expect(tools.some(t => t.includes('ast_'))).toBe(false);
      expect(tools).toHaveLength(33); // 12 LSP + 1 python + 3 skills + 5 state + 6 notepad + 4 memory + 2 trace
    });

    it('should filter out python_repl when includePython is false', () => {
      const tools = getOmcToolNames({ includePython: false });
      expect(tools.some(t => t.includes('python_repl'))).toBe(false);
      expect(tools).toHaveLength(34); // 12 LSP + 2 AST + 3 skills + 5 state + 6 notepad + 4 memory + 2 trace
    });

    it('should filter out skills tools', () => {
      const names = getOmcToolNames({ includeSkills: false });
      expect(names).toHaveLength(32);
      expect(names.every(n => !n.includes('load_omc_skills') && !n.includes('list_omc_skills'))).toBe(true);
    });

    it('should have 3 skills tools', () => {
      const skillsTools = omcToolNames.filter(n => n.includes('load_omc_skills') || n.includes('list_omc_skills'));
      expect(skillsTools).toHaveLength(3);
    });
  });

  describe('omcToolsServer', () => {
    it('should be defined', () => {
      expect(omcToolsServer).toBeDefined();
    });
  });
});
