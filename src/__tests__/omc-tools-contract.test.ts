/**
 * MCP Tools Contract Tests
 *
 * Verifies the contract for all tool definitions:
 * - Each tool has required fields (name, description, schema, handler)
 * - Tool names are unique across all tool sets
 * - Tool schemas are valid Zod shapes
 * - Tool handlers are async functions
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { lspTools } from '../tools/lsp-tools.js';
import { astTools } from '../tools/ast-tools.js';
import { pythonReplTool } from '../tools/python-repl/index.js';
import { stateTools } from '../tools/state-tools.js';
import { notepadTools } from '../tools/notepad-tools.js';
import { memoryTools } from '../tools/memory-tools.js';
import { traceTools } from '../tools/trace-tools.js';

// ============================================================================
// Types
// ============================================================================

interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown> | z.ZodRawShape;
  handler: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

// Aggregate all tool arrays
const allToolArrays: { category: string; tools: ToolDef[] }[] = [
  { category: 'lsp', tools: lspTools as unknown as ToolDef[] },
  { category: 'ast', tools: astTools as unknown as ToolDef[] },
  { category: 'python', tools: [pythonReplTool as unknown as ToolDef] },
  { category: 'state', tools: stateTools as unknown as ToolDef[] },
  { category: 'notepad', tools: notepadTools as unknown as ToolDef[] },
  { category: 'memory', tools: memoryTools as unknown as ToolDef[] },
  { category: 'trace', tools: traceTools as unknown as ToolDef[] },
];

const allTools: ToolDef[] = allToolArrays.flatMap(({ tools }) => tools);

// ============================================================================
// Required Fields
// ============================================================================

describe('MCP Tools Contract - Required Fields', () => {
  for (const { category, tools } of allToolArrays) {
    describe(`${category} tools`, () => {
      for (const tool of tools) {
        describe(`tool: ${tool.name}`, () => {
          it('should have a non-empty name', () => {
            expect(tool.name).toBeDefined();
            expect(typeof tool.name).toBe('string');
            expect(tool.name.length).toBeGreaterThan(0);
          });

          it('should have a non-empty description', () => {
            expect(tool.description).toBeDefined();
            expect(typeof tool.description).toBe('string');
            expect(tool.description.length).toBeGreaterThan(0);
          });

          it('should have a schema (Zod shape or object)', () => {
            expect(tool.schema).toBeDefined();
            expect(typeof tool.schema).toBe('object');
          });

          it('should have a handler function', () => {
            expect(tool.handler).toBeDefined();
            expect(typeof tool.handler).toBe('function');
          });
        });
      }
    });
  }
});

// ============================================================================
// Name Uniqueness
// ============================================================================

describe('MCP Tools Contract - Name Uniqueness', () => {
  it('should have no duplicate tool names', () => {
    const names = allTools.map(t => t.name);
    const uniqueNames = new Set(names);

    if (names.length !== uniqueNames.size) {
      // Find duplicates for better error message
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const name of names) {
        if (seen.has(name)) {
          duplicates.push(name);
        }
        seen.add(name);
      }
      expect(duplicates).toEqual([]);
    }

    expect(names.length).toBe(uniqueNames.size);
  });

  it('should have valid tool name format (no spaces, no special chars)', () => {
    for (const tool of allTools) {
      // Tool names should be alphanumeric with underscores/hyphens
      expect(tool.name).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
    }
  });
});

// ============================================================================
// Schema Validity
// ============================================================================

describe('MCP Tools Contract - Schema Validity', () => {
  for (const tool of allTools) {
    it(`${tool.name}: schema should have valid Zod types or plain objects`, () => {
      const schema = tool.schema;
      expect(typeof schema).toBe('object');
      expect(schema).not.toBeNull();

      // Each key in the schema should be defined
      for (const [key, value] of Object.entries(schema)) {
        expect(key).toBeDefined();
        expect(value).toBeDefined();

        // Value should be a Zod type or a plain object
        // Zod types have _def property
        const zodType = value as z.ZodTypeAny;
        if (zodType && typeof zodType === 'object' && '_def' in zodType) {
          // It's a Zod type - verify it has basic Zod structure
          expect(zodType._def).toBeDefined();
        }
      }
    });
  }
});

// ============================================================================
// Category Counts
// ============================================================================

describe('MCP Tools Contract - Category Counts', () => {
  it('should have LSP tools', () => {
    const lsp = allToolArrays.find(c => c.category === 'lsp');
    expect(lsp).toBeDefined();
    expect(lsp!.tools.length).toBeGreaterThan(0);
  });

  it('should have AST tools', () => {
    const ast = allToolArrays.find(c => c.category === 'ast');
    expect(ast).toBeDefined();
    expect(ast!.tools.length).toBeGreaterThan(0);
  });

  it('should have exactly 1 python REPL tool', () => {
    const python = allToolArrays.find(c => c.category === 'python');
    expect(python).toBeDefined();
    expect(python!.tools.length).toBe(1);
    expect(python!.tools[0].name).toBe('python_repl');
  });

  it('should have state tools', () => {
    const state = allToolArrays.find(c => c.category === 'state');
    expect(state).toBeDefined();
    expect(state!.tools.length).toBeGreaterThan(0);
  });

  it('should have notepad tools', () => {
    const notepad = allToolArrays.find(c => c.category === 'notepad');
    expect(notepad).toBeDefined();
    expect(notepad!.tools.length).toBeGreaterThan(0);
  });

  it('should have memory tools', () => {
    const memory = allToolArrays.find(c => c.category === 'memory');
    expect(memory).toBeDefined();
    expect(memory!.tools.length).toBeGreaterThan(0);
  });

  it('should have trace tools', () => {
    const trace = allToolArrays.find(c => c.category === 'trace');
    expect(trace).toBeDefined();
    expect(trace!.tools.length).toBeGreaterThan(0);
  });

  it('should have a reasonable total tool count', () => {
    // Total should be at least 20 (12 LSP + 2 AST + 1 python + state + notepad + memory + trace)
    expect(allTools.length).toBeGreaterThanOrEqual(20);
  });
});

// ============================================================================
// Handler Return Type Contract
// ============================================================================

describe('MCP Tools Contract - Handler Return Type', () => {
  it('all handlers should be functions', () => {
    for (const tool of allTools) {
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('description should be meaningful (>10 chars)', () => {
    for (const tool of allTools) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});
