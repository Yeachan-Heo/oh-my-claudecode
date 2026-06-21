import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
/**
 * Negative tests: antigravity is a tmux CLI-worker provider ONLY. It must never
 * be routed through the deprecated MCP team backend, which is hard-gated to
 * codex/gemini at the bridge daemon and bridge entry point. These tests assert
 * the runtime gates still reject antigravity (constraint C1).
 */
describe('antigravity is rejected by the MCP team backend', () => {
    const bridgeSource = readFileSync(join(__dirname, '..', 'mcp-team-bridge.ts'), 'utf-8');
    const bridgeEntrySource = readFileSync(join(__dirname, '..', 'bridge-entry.ts'), 'utf-8');
    it('mcp-team-bridge validateProvider only permits codex or gemini', () => {
        // The runtime validator throws "Must be 'codex' or 'gemini'" for anything else,
        // so antigravity can never spawn an MCP bridge subprocess.
        expect(bridgeSource).toContain("Must be 'codex' or 'gemini'");
        expect(bridgeSource).toContain('provider !== "codex" && provider !== "gemini"');
        // The provider literal type stays codex/gemini-only; antigravity is absent.
        expect(bridgeSource).not.toMatch(/['"]antigravity['"]/);
    });
    it('bridge-entry rejects a provider that is not codex or gemini', () => {
        expect(bridgeEntrySource).toContain("config.provider !== 'codex'");
        expect(bridgeEntrySource).toContain("config.provider !== 'gemini'");
        expect(bridgeEntrySource).toContain("Must be 'codex' or 'gemini'");
        // antigravity must NOT be added to the MCP bridge entry allowlist.
        expect(bridgeEntrySource).not.toMatch(/['"]antigravity['"]/);
    });
    it('the worker backend exposes tmux-antigravity but never mcp-antigravity', () => {
        const typesSource = readFileSync(join(__dirname, '..', 'types.ts'), 'utf-8');
        expect(typesSource).toContain("'tmux-antigravity'");
        expect(typesSource).not.toContain('mcp-antigravity');
    });
    it('synthesizeBridgeConfig (restart path) keeps the MCP provider cast codex/gemini-only', () => {
        const restartSource = readFileSync(join(__dirname, '..', 'worker-restart.ts'), 'utf-8');
        expect(restartSource).toContain("as 'codex' | 'gemini'");
        expect(restartSource).not.toMatch(/['"]antigravity['"]/);
    });
});
//# sourceMappingURL=antigravity-mcp-rejection.test.js.map