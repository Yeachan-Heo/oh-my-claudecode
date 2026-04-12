import { describe, it, expect } from 'vitest';
import { lspTools } from '../tools/lsp-tools.js';
import { astTools } from '../tools/ast-tools.js';
import { pythonReplTool } from '../tools/python-repl/tool.js';
import { stateTools } from '../tools/state-tools.js';
import { notepadTools } from '../tools/notepad-tools.js';
import { memoryTools } from '../tools/memory-tools.js';
import { traceTools } from '../tools/trace-tools.js';
describe('standalone-server tool composition', () => {
    // These are the exact same tool arrays that standalone-server.ts imports
    // This test validates our expectations about tool counts
    const expectedTools = [
        ...lspTools,
        ...astTools,
        pythonReplTool,
        ...stateTools,
        ...notepadTools,
        ...memoryTools,
        ...traceTools,
    ];
    it('should have at least the expected total tool count', () => {
        // 12 LSP + 2 AST + 1 python + 5 state + 6 notepad + 4 memory + 3 trace = 33 baseline.
        // Use ≥ so this guard doesn't break when new tools are legitimately added.
        expect(expectedTools.length).toBeGreaterThanOrEqual(33);
    });
    it('should include 3 trace tools', () => {
        expect(traceTools).toHaveLength(3);
    });
    it('should include trace_timeline tool', () => {
        const names = traceTools.map(t => t.name);
        expect(names).toContain('trace_timeline');
    });
    it('should include trace_summary tool', () => {
        const names = traceTools.map(t => t.name);
        expect(names).toContain('trace_summary');
    });
    it('should include session_search tool', () => {
        const names = traceTools.map(t => t.name);
        expect(names).toContain('session_search');
    });
    it('should have no duplicate tool names', () => {
        const names = expectedTools.map(t => t.name);
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(names.length);
    });
    it('all tools should have required properties', () => {
        for (const tool of expectedTools) {
            expect(tool).toHaveProperty('name');
            expect(tool).toHaveProperty('description');
            expect(tool).toHaveProperty('schema');
            expect(tool).toHaveProperty('handler');
            expect(typeof tool.name).toBe('string');
            expect(typeof tool.description).toBe('string');
            expect(typeof tool.handler).toBe('function');
        }
    });
});
//# sourceMappingURL=standalone-server.test.js.map