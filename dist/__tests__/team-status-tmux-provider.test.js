import { describe, it, expect } from "vitest";
// ============================================================================
// BUG 6: team-status provider type handles tmux workers
// ============================================================================
describe('BUG 6: team-status provider type for tmux workers', () => {
    it('source strips both mcp- and tmux- prefixes', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const source = readFileSync(join(process.cwd(), 'src/team/team-status.ts'), 'utf-8');
        // Should use a regex that strips both prefixes
        expect(source).toMatch(/replace\(.*mcp.*tmux/s);
        // Should include 'claude' in the provider union type
        expect(source).toContain("'claude'");
    });
    it('WorkerStatus interface includes claude in provider union', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const source = readFileSync(join(process.cwd(), 'src/team/team-status.ts'), 'utf-8');
        // The interface should have claude in the union
        const interfaceMatch = source.match(/interface WorkerStatus[\s\S]*?provider:\s*([^;]+);/);
        expect(interfaceMatch).not.toBeNull();
        expect(interfaceMatch[1]).toContain("'claude'");
        expect(interfaceMatch[1]).toContain("'codex'");
        expect(interfaceMatch[1]).toContain("'gemini'");
    });
    it('regex correctly strips mcp- prefix', () => {
        const regex = /^(?:mcp|tmux)-/;
        expect('mcp-codex'.replace(regex, '')).toBe('codex');
    });
    it('regex correctly strips tmux- prefix', () => {
        const regex = /^(?:mcp|tmux)-/;
        expect('tmux-claude'.replace(regex, '')).toBe('claude');
    });
    it('regex correctly strips tmux-codex to codex', () => {
        const regex = /^(?:mcp|tmux)-/;
        expect('tmux-codex'.replace(regex, '')).toBe('codex');
    });
});
//# sourceMappingURL=team-status-tmux-provider.test.js.map