import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const originalHome = process.env.HOME;
let testClaudeDir;
let testHomeDir;
async function loadInstaller() {
    vi.resetModules();
    return import('../index.js');
}
describe('install() standalone hook reconciliation', () => {
    beforeEach(() => {
        testClaudeDir = mkdtempSync(join(tmpdir(), 'omc-standalone-hooks-'));
        testHomeDir = mkdtempSync(join(tmpdir(), 'omc-home-'));
        mkdirSync(testHomeDir, { recursive: true });
        writeFileSync(join(testHomeDir, 'CLAUDE.md'), '# test home claude');
        process.env.CLAUDE_CONFIG_DIR = testClaudeDir;
        process.env.HOME = testHomeDir;
        delete process.env.CLAUDE_PLUGIN_ROOT;
    });
    afterEach(() => {
        rmSync(testClaudeDir, { recursive: true, force: true });
        rmSync(testHomeDir, { recursive: true, force: true });
        if (originalClaudeConfigDir !== undefined) {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        else {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        if (originalPluginRoot !== undefined) {
            process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
        }
        else {
            delete process.env.CLAUDE_PLUGIN_ROOT;
        }
        if (originalHome !== undefined) {
            process.env.HOME = originalHome;
        }
        else {
            delete process.env.HOME;
        }
    });
    it('restores OMC settings hooks for standalone installs during forced reconciliation', async () => {
        const settingsPath = join(testClaudeDir, 'settings.json');
        mkdirSync(testClaudeDir, { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));
        const { install } = await loadInstaller();
        const result = install({
            force: true,
            skipClaudeCheck: true,
        });
        const writtenSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(result.success).toBe(true);
        expect(result.hooksConfigured).toBe(true);
        expect(writtenSettings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe(`node "${join(testClaudeDir, 'hooks', 'keyword-detector.mjs').replace(/\\/g, '/')}"`);
        expect(writtenSettings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toBe(`node "${join(testClaudeDir, 'hooks', 'session-start.mjs').replace(/\\/g, '/')}"`);
        expect(writtenSettings.statusLine?.command).toContain(`${join(testClaudeDir, 'hud', 'omc-hud.mjs').replace(/\\/g, '/')}`);
        expect(writtenSettings.statusLine?.command).toContain('omc-hud-cache.sh');
        expect(readFileSync(join(testClaudeDir, 'hud', 'omc-hud-cache.sh'), 'utf-8')).toContain('HUD cached statusLine launcher');
        expect(readFileSync(join(testClaudeDir, 'hud', 'omc-hud.mjs'), 'utf-8')).toContain('const { getClaudeConfigDir } = await import(pathToFileURL(join(__dirname, "lib", "config-dir.mjs")).href);');
        expect(readFileSync(join(testClaudeDir, 'hud', 'lib', 'config-dir.mjs'), 'utf-8')).toContain('export function getClaudeConfigDir()');
        expect(readFileSync(join(testClaudeDir, 'hooks', 'lib', 'config-dir.mjs'), 'utf-8')).toContain('export function getClaudeConfigDir()');
        expect(readFileSync(join(testClaudeDir, 'hooks', 'keyword-detector.mjs'), 'utf-8')).toContain('Ralph keywords');
        expect(readFileSync(join(testClaudeDir, 'hooks', 'pre-tool-use.mjs'), 'utf-8')).toContain('PreToolUse');
        expect(readFileSync(join(testClaudeDir, 'hooks', 'code-simplifier.mjs'), 'utf-8')).toContain('Code Simplifier');
    });
    it('preserves non-OMC ~/.claude/hooks commands while adding standalone OMC hooks', async () => {
        const settingsPath = join(testClaudeDir, 'settings.json');
        mkdirSync(testClaudeDir, { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({
            hooks: {
                UserPromptSubmit: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: 'node $HOME/.claude/hooks/other-plugin.mjs',
                            },
                        ],
                    },
                ],
            },
        }, null, 2));
        const { install } = await loadInstaller();
        const result = install({
            force: true,
            skipClaudeCheck: true,
        });
        const writtenSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const commands = writtenSettings.hooks.UserPromptSubmit.map(group => group.hooks[0]?.command);
        expect(result.success).toBe(true);
        expect(commands).toContain('node $HOME/.claude/hooks/other-plugin.mjs');
        expect(commands).toContain(`node "${join(testClaudeDir, 'hooks', 'keyword-detector.mjs').replace(/\\/g, '/')}"`);
    });
    it('removes legacy OMC settings hooks in plugin mode without re-injecting them', async () => {
        const settingsPath = join(testClaudeDir, 'settings.json');
        const pluginRoot = join(testClaudeDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.1.5');
        mkdirSync(pluginRoot, { recursive: true });
        mkdirSync(testClaudeDir, { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({
            hooks: {
                UserPromptSubmit: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: 'node $HOME/.claude/hooks/keyword-detector.mjs',
                            },
                        ],
                    },
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: 'node $HOME/.claude/hooks/other-plugin.mjs',
                            },
                        ],
                    },
                ],
            },
        }, null, 2));
        process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
        const { install } = await loadInstaller();
        const result = install({
            force: true,
            skipClaudeCheck: true,
        });
        const writtenSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const commands = writtenSettings.hooks?.UserPromptSubmit?.map(group => group.hooks[0]?.command) ?? [];
        expect(result.success).toBe(true);
        expect(result.hooksConfigured).toBe(true);
        expect(commands).toEqual(['node $HOME/.claude/hooks/other-plugin.mjs']);
        expect(commands).not.toContain(`node "${join(testClaudeDir, 'hooks', 'keyword-detector.mjs').replace(/\\/g, '/')}"`);
        expect(writtenSettings.statusLine?.command).toContain(`${join(testClaudeDir, 'hud', 'omc-hud.mjs').replace(/\\/g, '/')}`);
    });
});
// ── Plugin-provided hooks: duplicate prevention (#2252) ─────────────────────
describe('install() plugin-provided hook deduplication (#2252)', () => {
    let fakePluginRoot;
    beforeEach(() => {
        testClaudeDir = mkdtempSync(join(tmpdir(), 'omc-hook-dedup-'));
        testHomeDir = mkdtempSync(join(tmpdir(), 'omc-home-dedup-'));
        mkdirSync(testHomeDir, { recursive: true });
        writeFileSync(join(testHomeDir, 'CLAUDE.md'), '# test home claude');
        process.env.CLAUDE_CONFIG_DIR = testClaudeDir;
        process.env.HOME = testHomeDir;
        delete process.env.CLAUDE_PLUGIN_ROOT;
    });
    afterEach(() => {
        if (fakePluginRoot) {
            rmSync(fakePluginRoot, { recursive: true, force: true });
        }
        rmSync(testClaudeDir, { recursive: true, force: true });
        rmSync(testHomeDir, { recursive: true, force: true });
        if (originalClaudeConfigDir !== undefined) {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        else {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        if (originalPluginRoot !== undefined) {
            process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
        }
        else {
            delete process.env.CLAUDE_PLUGIN_ROOT;
        }
        if (originalHome !== undefined) {
            process.env.HOME = originalHome;
        }
        else {
            delete process.env.HOME;
        }
    });
    function setupPluginWithHooks() {
        // Create a fake plugin root with hooks/hooks.json
        fakePluginRoot = mkdtempSync(join(tmpdir(), 'omc-fake-plugin-'));
        const hooksDir = join(fakePluginRoot, 'hooks');
        mkdirSync(hooksDir, { recursive: true });
        writeFileSync(join(hooksDir, 'hooks.json'), JSON.stringify({
            hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node test.mjs' }] }] },
        }));
        // Register plugin in installed_plugins.json
        const pluginsDir = join(testClaudeDir, 'plugins');
        mkdirSync(pluginsDir, { recursive: true });
        writeFileSync(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
            'oh-my-claudecode': [{ installPath: fakePluginRoot }],
        }));
        // Mark plugin as enabled in settings.json
        mkdirSync(testClaudeDir, { recursive: true });
        writeFileSync(join(testClaudeDir, 'settings.json'), JSON.stringify({
            enabledPlugins: { 'oh-my-claudecode': true },
        }, null, 2));
    }
    it('hasPluginProvidedHookFiles returns true when hooks.json exists in plugin root', async () => {
        setupPluginWithHooks();
        const { hasPluginProvidedHookFiles } = await loadInstaller();
        expect(hasPluginProvidedHookFiles()).toBe(true);
    });
    it('hasPluginProvidedHookFiles returns false when no plugin provides hooks', async () => {
        const { hasPluginProvidedHookFiles } = await loadInstaller();
        expect(hasPluginProvidedHookFiles()).toBe(false);
    });
    it('skips standalone hook scripts when plugin provides hooks.json', async () => {
        setupPluginWithHooks();
        const { install } = await loadInstaller();
        install({ force: true, skipClaudeCheck: true });
        // Standalone hook scripts should NOT be copied to ~/.claude/hooks/
        expect(existsSync(join(testClaudeDir, 'hooks', 'keyword-detector.mjs'))).toBe(false);
        expect(existsSync(join(testClaudeDir, 'hooks', 'pre-tool-use.mjs'))).toBe(false);
        expect(existsSync(join(testClaudeDir, 'hooks', 'session-start.mjs'))).toBe(false);
    });
    it('does not write OMC hook entries to settings.json when plugin provides hooks', async () => {
        setupPluginWithHooks();
        const { install } = await loadInstaller();
        const result = install({ force: true, skipClaudeCheck: true });
        const writtenSettings = JSON.parse(readFileSync(join(testClaudeDir, 'settings.json'), 'utf-8'));
        expect(result.success).toBe(true);
        // OMC hooks should NOT be in settings.json — plugin handles them via hooks.json
        expect(writtenSettings.hooks).toBeUndefined();
    });
    it('removes stale OMC hook entries from settings.json when plugin provides hooks', async () => {
        // Pre-populate settings.json with stale OMC hook entries (simulating prior standalone install)
        mkdirSync(testClaudeDir, { recursive: true });
        writeFileSync(join(testClaudeDir, 'settings.json'), JSON.stringify({
            enabledPlugins: { 'oh-my-claudecode': true },
            hooks: {
                UserPromptSubmit: [
                    {
                        hooks: [{
                                type: 'command',
                                command: 'node "$HOME/.claude/hooks/keyword-detector.mjs"',
                            }],
                    },
                ],
                SessionStart: [
                    {
                        hooks: [{
                                type: 'command',
                                command: 'node "$HOME/.claude/hooks/session-start.mjs"',
                            }],
                    },
                ],
            },
        }, null, 2));
        setupPluginWithHooks();
        const { install } = await loadInstaller();
        const result = install({ force: true, skipClaudeCheck: true });
        const writtenSettings = JSON.parse(readFileSync(join(testClaudeDir, 'settings.json'), 'utf-8'));
        expect(result.success).toBe(true);
        // Stale OMC hook entries should be cleaned up by legacy cleanup,
        // and NOT re-added because plugin provides hooks
        expect(writtenSettings.hooks).toBeUndefined();
    });
    it('preserves non-OMC hooks in settings.json when pruning plugin duplicates', async () => {
        // Set up plugin first (creates settings.json with enabledPlugins)
        setupPluginWithHooks();
        // Then overwrite settings.json with mixed OMC + non-OMC hooks
        writeFileSync(join(testClaudeDir, 'settings.json'), JSON.stringify({
            enabledPlugins: { 'oh-my-claudecode': true },
            hooks: {
                UserPromptSubmit: [
                    {
                        hooks: [{
                                type: 'command',
                                command: 'node $HOME/.claude/hooks/other-plugin.mjs',
                            }],
                    },
                    {
                        hooks: [{
                                type: 'command',
                                command: 'node "$HOME/.claude/hooks/keyword-detector.mjs"',
                            }],
                    },
                ],
            },
        }, null, 2));
        const { install } = await loadInstaller();
        install({ force: true, skipClaudeCheck: true });
        const writtenSettings = JSON.parse(readFileSync(join(testClaudeDir, 'settings.json'), 'utf-8'));
        // Non-OMC hook should be preserved
        const commands = writtenSettings.hooks?.UserPromptSubmit?.map(g => g.hooks[0]?.command) ?? [];
        expect(commands).toContain('node $HOME/.claude/hooks/other-plugin.mjs');
        // OMC hook should NOT be re-added
        expect(commands).not.toContain('node "$HOME/.claude/hooks/keyword-detector.mjs"');
    });
});
//# sourceMappingURL=standalone-hook-reconcile.test.js.map