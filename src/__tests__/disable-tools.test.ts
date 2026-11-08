/**
 * Tests for OMC_DISABLE_TOOLS env var support
 *
 * Verifies that parseDisabledGroups() correctly maps user-facing group names
 * to ToolCategory values, and that the filtering logic works as expected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseDisabledGroups, DISABLE_TOOLS_GROUP_MAP } from '../mcp/omc-tools-server.js';
import { TOOL_CATEGORIES } from '../constants/index.js';

describe('OMC_DISABLE_TOOLS', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.OMC_DISABLE_TOOLS;
    delete process.env.OMC_DISABLE_TOOLS;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.OMC_DISABLE_TOOLS = savedEnv;
    } else {
      delete process.env.OMC_DISABLE_TOOLS;
    }
  });

  describe('parseDisabledGroups()', () => {
    describe('env var not set', () => {
      it('returns empty set when env var is absent', () => {
        const result = parseDisabledGroups();
        expect(result.size).toBe(0);
      });

      it('returns empty set when called with empty string', () => {
        const result = parseDisabledGroups('');
        expect(result.size).toBe(0);
      });

      it('returns empty set when called with whitespace only', () => {
        const result = parseDisabledGroups('   ');
        expect(result.size).toBe(0);
      });
    });

    describe('single group names', () => {
      it('disables lsp group', () => {
        const result = parseDisabledGroups('lsp');
        expect(result.has(TOOL_CATEGORIES.LSP)).toBe(true);
        expect(result.size).toBe(1);
      });

      it('disables ast group', () => {
        const result = parseDisabledGroups('ast');
        expect(result.has(TOOL_CATEGORIES.AST)).toBe(true);
        expect(result.size).toBe(1);
      });

      it('disables python group via canonical name', () => {
        const result = parseDisabledGroups('python');
        expect(result.has(TOOL_CATEGORIES.PYTHON)).toBe(true);
      });

      it('disables python group via alias python-repl', () => {
        const result = parseDisabledGroups('python-repl');
        expect(result.has(TOOL_CATEGORIES.PYTHON)).toBe(true);
      });

      it('disables trace group', () => {
        const result = parseDisabledGroups('trace');
        expect(result.has(TOOL_CATEGORIES.TRACE)).toBe(true);
      });

      it('disables state group', () => {
        const result = parseDisabledGroups('state');
        expect(result.has(TOOL_CATEGORIES.STATE)).toBe(true);
      });

      it('disables notepad group', () => {
        const result = parseDisabledGroups('notepad');
        expect(result.has(TOOL_CATEGORIES.NOTEPAD)).toBe(true);
      });

      it('disables memory group via canonical name', () => {
        const result = parseDisabledGroups('memory');
        expect(result.has(TOOL_CATEGORIES.MEMORY)).toBe(true);
      });

      it('disables memory group via alias project-memory', () => {
        const result = parseDisabledGroups('project-memory');
        expect(result.has(TOOL_CATEGORIES.MEMORY)).toBe(true);
      });

      it('disables skills group', () => {
        const result = parseDisabledGroups('skills');
        expect(result.has(TOOL_CATEGORIES.SKILLS)).toBe(true);
      });

      it('disables interop group', () => {
        const result = parseDisabledGroups('interop');
        expect(result.has(TOOL_CATEGORIES.INTEROP)).toBe(true);
      });

      it('accepts codex group (reserved, no tools in t server)', () => {
        const result = parseDisabledGroups('codex');
        expect(result.has(TOOL_CATEGORIES.CODEX)).toBe(true);
      });

      it('accepts gemini group (reserved, no tools in t server)', () => {
        const result = parseDisabledGroups('gemini');
        expect(result.has(TOOL_CATEGORIES.GEMINI)).toBe(true);
      });
    });

    describe('multiple groups', () => {
      it('disables multiple groups from comma-separated list', () => {
        const result = parseDisabledGroups('lsp,ast');
        expect(result.has(TOOL_CATEGORIES.LSP)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.AST)).toBe(true);
        expect(result.size).toBe(2);
      });

      it('disables all issue-722 specified groups', () => {
        const result = parseDisabledGroups('lsp,ast,python-repl,gemini,codex,trace,state,notepad,project-memory');
        expect(result.has(TOOL_CATEGORIES.LSP)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.AST)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.PYTHON)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.GEMINI)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.CODEX)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.TRACE)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.STATE)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.NOTEPAD)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.MEMORY)).toBe(true);
      });

      it('deduplicates aliased groups (python and python-repl map to same category)', () => {
        const result = parseDisabledGroups('python,python-repl');
        expect(result.has(TOOL_CATEGORIES.PYTHON)).toBe(true);
        expect(result.size).toBe(1);
      });

      it('deduplicates aliased groups (memory and project-memory)', () => {
        const result = parseDisabledGroups('memory,project-memory');
        expect(result.has(TOOL_CATEGORIES.MEMORY)).toBe(true);
        expect(result.size).toBe(1);
      });
    });

    describe('robustness', () => {
      it('is case-insensitive', () => {
        const result = parseDisabledGroups('LSP,AST');
        expect(result.has(TOOL_CATEGORIES.LSP)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.AST)).toBe(true);
      });

      it('trims whitespace around group names', () => {
        const result = parseDisabledGroups('  lsp , ast  ');
        expect(result.has(TOOL_CATEGORIES.LSP)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.AST)).toBe(true);
      });

      it('ignores empty segments from trailing/double commas', () => {
        const result = parseDisabledGroups('lsp,,ast,');
        expect(result.has(TOOL_CATEGORIES.LSP)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.AST)).toBe(true);
        expect(result.size).toBe(2);
      });

      it('silently ignores unknown group names', () => {
        const result = parseDisabledGroups('unknown-group,lsp');
        expect(result.has(TOOL_CATEGORIES.LSP)).toBe(true);
        expect(result.size).toBe(1);
      });

      it('returns empty set when all names are unknown', () => {
        const result = parseDisabledGroups('foo,bar,baz');
        expect(result.size).toBe(0);
      });

      it('reads from process.env.OMC_DISABLE_TOOLS when no argument given', () => {
        process.env.OMC_DISABLE_TOOLS = 'lsp,ast';
        const result = parseDisabledGroups();
        expect(result.has(TOOL_CATEGORIES.LSP)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.AST)).toBe(true);
      });

      it('explicit argument takes precedence over env var', () => {
        process.env.OMC_DISABLE_TOOLS = 'lsp';
        const result = parseDisabledGroups('ast');
        expect(result.has(TOOL_CATEGORIES.AST)).toBe(true);
        expect(result.has(TOOL_CATEGORIES.LSP)).toBe(false);
      });
    });
  });

  describe('DISABLE_TOOLS_GROUP_MAP', () => {
    it('contains all issue-722 specified group names', () => {
      const requiredGroups = ['lsp', 'ast', 'python-repl', 'gemini', 'codex', 'trace', 'state', 'notepad', 'project-memory', 'interop'];
      for (const group of requiredGroups) {
        expect(DISABLE_TOOLS_GROUP_MAP).toHaveProperty(group);
      }
    });

    it('maps python-repl and python to the same category', () => {
      expect(DISABLE_TOOLS_GROUP_MAP['python-repl']).toBe(DISABLE_TOOLS_GROUP_MAP['python']);
    });

    it('maps project-memory and memory to the same category', () => {
      expect(DISABLE_TOOLS_GROUP_MAP['project-memory']).toBe(DISABLE_TOOLS_GROUP_MAP['memory']);
    });

    it('maps to valid ToolCategory values', () => {
      const validCategories = new Set(Object.values(TOOL_CATEGORIES));
      for (const [name, category] of Object.entries(DISABLE_TOOLS_GROUP_MAP)) {
        expect(validCategories.has(category), `${name} should map to a valid ToolCategory`).toBe(true);
      }
    });
  });
});
