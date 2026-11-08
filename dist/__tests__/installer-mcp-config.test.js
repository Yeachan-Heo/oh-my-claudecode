import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    const { join: pathJoin } = await import('path');
    const repoRoot = process.cwd();
    const sourceClaudeMdPath = pathJoin(repoRoot, 'src', 'docs', 'CLAUDE.md');
    const realClaudeMdPath = pathJoin(repoRoot, 'docs', 'CLAUDE.md');
    const withRedirect = (pathLike) => {
        const normalized = String(pathLike).replace(/\\/g, '/');
        if (normalized === sourceClaudeMdPath.replace(/\\/g, '/')) {
            return realClaudeMdPath;
        }
        return String(pathLike);
    };
    return {
        ...actual,
        existsSync: vi.fn((pathLike) => actual.existsSync(withRedirect(pathLike))),
        readFileSync: vi.fn((pathLike, options) => actual.readFileSync(withRedirect(pathLike), options)),
    };
});
async function loadInstallerWithEnv(claudeConfigDir, homeDir, codexHome, omcHome) {
    vi.resetModules();
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    process.env.HOME = homeDir;
    process.env.CODEX_HOME = codexHome;
    process.env.OMC_HOME = omcHome;
    delete process.env.CLAUDE_MCP_CONFIG_PATH;
    delete process.env.OMC_MCP_REGISTRY_PATH;
    return import('../installer/index.js');
}
// Maps each hook event to the OMC script(s) it must reference after a
// first-install hook merge (mergeHookGroups). Shared by the mcp-config-owned
// settings.json test below and the dedicated first-install regression test,
// so both assert the same contract without pinning exact command strings,
// which vary by platform.
const EXPECTED_HOOK_SCRIPTS = {
    UserPromptSubmit: ['keyword-detector.mjs'],
    SessionStart: ['session-start.mjs'],
    PreToolUse: ['pre-tool-use.mjs'],
    PostToolUse: ['post-tool-use.mjs'],
    PostToolUseFailure: ['post-tool-use-failure.mjs'],
    Stop: ['persistent-mode.mjs', 'code-simplifier.mjs'],
};
describe('installer MCP config ownership (issue #1802)', () => {
    let tempRoot;
    let homeDir;
    let claudeConfigDir;
    let codexHome;
    let omcHome;
    let originalEnv;
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'omc-installer-mcp-config-'));
        homeDir = join(tempRoot, 'home');
        claudeConfigDir = join(homeDir, '.claude');
        codexHome = join(tempRoot, '.codex');
        omcHome = join(tempRoot, '.omc');
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(claudeConfigDir, { recursive: true });
        mkdirSync(codexHome, { recursive: true });
        mkdirSync(omcHome, { recursive: true });
        originalEnv = { ...process.env };
    });
    afterEach(() => {
        process.env = originalEnv;
        rmSync(tempRoot, { recursive: true, force: true });
        vi.resetModules();
    });
    it('moves legacy settings.json mcpServers into ~/.claude.json during install', async () => {
        const settingsPath = join(claudeConfigDir, 'settings.json');
        const claudeRootConfigPath = join(homeDir, '.claude.json');
        const codexConfigPath = join(codexHome, 'config.toml');
        const registryPath = join(omcHome, 'mcp-registry.json');
        writeFileSync(settingsPath, JSON.stringify({
            theme: 'dark',
            statusLine: {
                type: 'command',
                command: 'node hud.mjs',
            },
            mcpServers: {
                gitnexus: {
                    command: 'gitnexus',
                    args: ['mcp'],
                    timeout: 15,
                },
            },
        }, null, 2));
        const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir, codexHome, omcHome);
        const result = installer.install({
            skipClaudeCheck: true,
            skipHud: true,
        });
        expect(result.success).toBe(true);
        expect(existsSync(settingsPath)).toBe(true);
        expect(existsSync(claudeRootConfigPath)).toBe(true);
        expect(existsSync(registryPath)).toBe(true);
        expect(existsSync(codexConfigPath)).toBe(true);
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const { hooks, ...settingsWithoutHooks } = settings;
        expect(settingsWithoutHooks).toEqual({
            theme: 'dark',
            statusLine: {
                type: 'command',
                command: 'node hud.mjs',
            },
        });
        expect(settings).not.toHaveProperty('mcpServers');
        // This test's subject is MCP config ownership, not hooks, so we only assert
        // that the installer's first-install hook merge (mergeHookGroups) populated
        // every event with its OMC hook script rather than pinning exact command
        // strings, which vary by platform (see installer-hooks-merge.test.ts and the
        // dedicated first-install regression test below for the full hooks contract).
        for (const [eventType, scripts] of Object.entries(EXPECTED_HOOK_SCRIPTS)) {
            const groups = hooks?.[eventType];
            expect(groups, `${eventType} should have hook groups`).toBeDefined();
            expect(groups.length, `${eventType} should not be empty`).toBeGreaterThan(0);
            const commands = groups.flatMap(g => g.hooks.map(h => h.command));
            for (const script of scripts) {
                expect(commands.some(cmd => cmd.includes(script)), `${eventType} should reference ${script}`).toBe(true);
            }
        }
        const claudeRootConfig = JSON.parse(readFileSync(claudeRootConfigPath, 'utf-8'));
        expect(claudeRootConfig).toEqual({
            mcpServers: {
                gitnexus: {
                    command: 'gitnexus',
                    args: ['mcp'],
                    timeout: 15,
                },
            },
        });
        expect(JSON.parse(readFileSync(registryPath, 'utf-8'))).toEqual({
            gitnexus: {
                command: 'gitnexus',
                args: ['mcp'],
                timeout: 15,
            },
        });
        const codexConfig = readFileSync(codexConfigPath, 'utf-8');
        expect(codexConfig).toContain('# BEGIN OMC MANAGED MCP REGISTRY');
        expect(codexConfig).toContain('[mcp_servers.gitnexus]');
        expect(codexConfig).toContain('command = "gitnexus"');
    });
});
// ---------------------------------------------------------------------------
// This exercises the real installer's mergeHookGroups() first-install branch
// (src/installer/index.ts), not the local mirror in installer-hooks-merge.test.ts.
// That mirror test only proves its own copy of the merge logic is correct; it
// would keep passing even if the production fix were reverted. This test would
// not: it runs the actual `install()` entry point against a fresh, empty
// CLAUDE_CONFIG_DIR with no force flags and reads back the real settings.json.
// ---------------------------------------------------------------------------
describe('installer hook merge — first install writes non-empty hook groups', () => {
    let tempRoot;
    let homeDir;
    let claudeConfigDir;
    let codexHome;
    let omcHome;
    let originalEnv;
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'omc-installer-hooks-first-install-'));
        homeDir = join(tempRoot, 'home');
        claudeConfigDir = join(homeDir, '.claude');
        codexHome = join(tempRoot, '.codex');
        omcHome = join(tempRoot, '.omc');
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(claudeConfigDir, { recursive: true });
        mkdirSync(codexHome, { recursive: true });
        mkdirSync(omcHome, { recursive: true });
        originalEnv = { ...process.env };
    });
    afterEach(() => {
        process.env = originalEnv;
        rmSync(tempRoot, { recursive: true, force: true });
        vi.resetModules();
    });
    it('populates every event with its OMC hook script on a fresh install with no force flags', async () => {
        const settingsPath = join(claudeConfigDir, 'settings.json');
        // No settings.json is written beforehand: this is a first-time install
        // into a config dir that has never had OMC hooks configured.
        const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir, codexHome, omcHome);
        const result = installer.install({
            skipClaudeCheck: true,
            skipHud: true,
        });
        expect(result.success).toBe(true);
        expect(existsSync(settingsPath)).toBe(true);
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        for (const [eventType, scripts] of Object.entries(EXPECTED_HOOK_SCRIPTS)) {
            const groups = settings.hooks?.[eventType];
            expect(groups, `${eventType} should have hook groups`).toBeDefined();
            expect(groups.length, `${eventType} should not be an empty array`).toBeGreaterThan(0);
            const commands = groups.flatMap(g => g.hooks.map(h => h.command));
            for (const script of scripts) {
                expect(commands.some(cmd => cmd.includes(script)), `${eventType} should reference ${script}`).toBe(true);
            }
        }
    });
});
//# sourceMappingURL=installer-mcp-config.test.js.map