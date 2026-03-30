import { describe, it, expect } from "vitest";
// ============================================================================
// BUG 7: outbox-reader only parses complete lines
// ============================================================================
describe('BUG 7: outbox-reader partial line handling', () => {
    it('source only parses lines from completePortion', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const source = readFileSync(join(process.cwd(), 'src/team/outbox-reader.ts'), 'utf-8');
        // The fix introduces a `completePortion` variable
        expect(source).toContain('completePortion');
        // Lines should be split from completePortion, not from chunk directly
        expect(source).toMatch(/completePortion\.split/);
    });
    it('does not parse partial trailing line when chunk lacks trailing newline', () => {
        // Simulate the logic from the fix
        const chunk = '{"msg":"line1"}\n{"msg":"line2"}\n{"msg":"partial';
        let completePortion = chunk;
        if (!chunk.endsWith('\n')) {
            const lastNewline = chunk.lastIndexOf('\n');
            completePortion = lastNewline >= 0 ? chunk.slice(0, lastNewline + 1) : '';
        }
        const lines = completePortion.split('\n').filter((l) => l.trim());
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe('{"msg":"line1"}');
        expect(lines[1]).toBe('{"msg":"line2"}');
    });
    it('parses all lines when chunk ends with newline', () => {
        const chunk = '{"msg":"line1"}\n{"msg":"line2"}\n';
        let completePortion = chunk;
        if (!chunk.endsWith('\n')) {
            const lastNewline = chunk.lastIndexOf('\n');
            completePortion = lastNewline >= 0 ? chunk.slice(0, lastNewline + 1) : '';
        }
        const lines = completePortion.split('\n').filter((l) => l.trim());
        expect(lines).toHaveLength(2);
    });
    it('returns empty when chunk is a single partial line with no newline', () => {
        const chunk = '{"msg":"partial';
        let completePortion = chunk;
        if (!chunk.endsWith('\n')) {
            const lastNewline = chunk.lastIndexOf('\n');
            completePortion = lastNewline >= 0 ? chunk.slice(0, lastNewline + 1) : '';
        }
        const lines = completePortion.split('\n').filter((l) => l.trim());
        expect(lines).toHaveLength(0);
    });
});
//# sourceMappingURL=outbox-reader-partial-lines.test.js.map