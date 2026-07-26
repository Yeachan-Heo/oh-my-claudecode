import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'repair-plugin-cache.mjs');
const tempRoots = [];
function writePluginRoot(root, version) {
    mkdirSync(join(root, 'hooks'), { recursive: true });
    mkdirSync(join(root, 'skills', 'omc-setup'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'hooks.json'), '{}\n');
    writeFileSync(join(root, 'skills', 'omc-setup', 'SKILL.md'), '# setup\n');
    writeFileSync(join(root, 'docs', 'CLAUDE.md'), `<!-- OMC:VERSION:${version} -->\n`);
}
afterEach(() => {
    while (tempRoots.length > 0) {
        const root = tempRoots.pop();
        if (root)
            rmSync(root, { recursive: true, force: true });
    }
});
describe('repair-plugin-cache.mjs', () => {
    it('rewrites stale installed_plugins.json and keeps old cache path as a symlink fallback', () => {
        const root = mkdtempSync(join(tmpdir(), 'omc-repair-plugin-cache-'));
        tempRoots.push(root);
        const configDir = join(root, '.claude');
        const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        const oldRoot = join(cacheBase, '4.11.6');
        const newRoot = join(cacheBase, '4.14.1');
        mkdirSync(join(configDir, 'plugins'), { recursive: true });
        writePluginRoot(oldRoot, '4.11.6');
        writePluginRoot(newRoot, '4.14.1');
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: oldRoot, version: '4.11.6', enabled: true }],
            },
        }, null, 2));
        const result = spawnSync(process.execPath, [SCRIPT_PATH], {
            env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, OMC_REPAIR_PLUGIN_CACHE_PLATFORM: 'linux' },
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Repaired plugin cache references');
        const registry = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf-8'));
        expect(registry.plugins['oh-my-claudecode@omc'][0]).toMatchObject({
            installPath: newRoot,
            version: '4.14.1',
            enabled: true,
        });
        expect(existsSync(oldRoot)).toBe(true);
        expect(lstatSync(oldRoot).isSymbolicLink()).toBe(true);
        expect(readlinkSync(oldRoot)).toBe('4.14.1');
        expect(existsSync(join(oldRoot, 'hooks', 'hooks.json'))).toBe(true);
    });
    it('repairs a registry entry whose old cache path was already deleted', () => {
        const root = mkdtempSync(join(tmpdir(), 'omc-repair-missing-cache-'));
        tempRoots.push(root);
        const configDir = join(root, '.claude');
        const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        const oldRoot = join(cacheBase, '4.11.6');
        const newRoot = join(cacheBase, '4.14.1');
        mkdirSync(join(configDir, 'plugins'), { recursive: true });
        writePluginRoot(newRoot, '4.14.1');
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            'oh-my-claudecode@omc': [{ installPath: oldRoot, version: '4.11.6' }],
        }, null, 2));
        const result = spawnSync(process.execPath, [SCRIPT_PATH], {
            env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, OMC_REPAIR_PLUGIN_CACHE_PLATFORM: 'linux' },
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        expect(existsSync(oldRoot)).toBe(true);
        expect(lstatSync(oldRoot).isSymbolicLink()).toBe(true);
        expect(readlinkSync(oldRoot)).toBe('4.14.1');
        expect(existsSync(join(oldRoot, 'hooks', 'hooks.json'))).toBe(true);
        const registry = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf-8'));
        expect(registry['oh-my-claudecode@omc'][0]).toMatchObject({
            installPath: newRoot,
            version: '4.14.1',
        });
    });
    it.runIf(process.platform !== 'win32')('repairs Unix cache hooks from direct node to the find-node bootstrap', () => {
        const root = mkdtempSync(join(tmpdir(), 'omc-repair-unix-hooks-'));
        tempRoots.push(root);
        const configDir = join(root, '.claude');
        const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        const pluginRoot = join(cacheBase, '4.14.4');
        writePluginRoot(pluginRoot, '4.14.4');
        writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({
            hooks: {
                SessionEnd: [{
                        matcher: '*',
                        hooks: [{
                                type: 'command',
                                command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs',
                            }],
                    }],
            },
        }, null, 2));
        const result = spawnSync(process.execPath, [SCRIPT_PATH], {
            env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('hooks=platform');
        const hooksJson = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf-8'));
        expect(hooksJson.hooks.SessionEnd[0].hooks[0].command).toBe('sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs');
    });
    it.runIf(process.platform !== 'win32')('repairs every bundled direct-node hook command to find-node on Unix/macOS', () => {
        const root = mkdtempSync(join(tmpdir(), 'omc-repair-unix-bundled-hooks-'));
        tempRoots.push(root);
        const configDir = join(root, '.claude');
        const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        const pluginRoot = join(cacheBase, '4.14.4');
        writePluginRoot(pluginRoot, '4.14.4');
        writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
        const result = spawnSync(process.execPath, [SCRIPT_PATH], {
            env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        const hooksJson = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf-8'));
        const commands = Object.entries(hooksJson.hooks).flatMap(([event, groups]) => groups.flatMap(group => group.hooks
            .map(hook => hook.command)
            .filter((command) => typeof command === 'string')
            .map(command => ({ event, command }))));
        expect(commands.length).toBeGreaterThan(0);
        for (const { event, command } of commands) {
            expect(command, event).toMatch(/^sh "\$CLAUDE_PLUGIN_ROOT"\/scripts\/find-node\.sh "\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs /);
            expect(command, event).not.toContain('/bin/sh');
        }
    });
    it('repairs Windows cache hooks from find-node to direct node', () => {
        const root = mkdtempSync(join(tmpdir(), 'omc-repair-win-hooks-'));
        tempRoots.push(root);
        const configDir = join(root, '.claude');
        const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        const pluginRoot = join(cacheBase, '4.14.4');
        writePluginRoot(pluginRoot, '4.14.4');
        writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({
            hooks: {
                SessionEnd: [{
                        matcher: '*',
                        hooks: [{
                                type: 'command',
                                command: 'sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs',
                            }],
                    }],
            },
        }, null, 2));
        const result = spawnSync(process.execPath, [SCRIPT_PATH], {
            env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, OMC_REPAIR_PLUGIN_CACHE_PLATFORM: 'win32' },
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        const hooksJson = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf-8'));
        expect(hooksJson.hooks.SessionEnd[0].hooks[0].command).toBe('node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs');
    });
    it('setup instructions delegate cache resolution and retain phase repair without unsafe deletion', () => {
        const setupSkill = readFileSync(join(REPO_ROOT, 'skills', 'omc-setup', 'SKILL.md'), 'utf-8');
        const phase = readFileSync(join(REPO_ROOT, 'skills', 'omc-setup', 'phases', '02-configure.md'), 'utf-8');
        const setupInvocationIndex = setupSkill.indexOf('## Setup Invocation');
        const cacheResolverIndex = setupSkill.indexOf('The script is the sole cache resolver.');
        const preSetupCheckIndex = setupSkill.indexOf('## Pre-Setup Check');
        expect(setupInvocationIndex).toBeGreaterThan(-1);
        expect(cacheResolverIndex).toBeGreaterThan(setupInvocationIndex);
        expect(cacheResolverIndex).toBeLessThan(preSetupCheckIndex);
        expect(setupSkill).not.toContain('repair-plugin-cache.mjs');
        expect(phase).toContain('Repair Stale Plugin Cache References');
        expect(phase).toContain('repair-plugin-cache.mjs');
        expect(phase).not.toContain('rmSync(p.join(b,x)');
    });
});
//# sourceMappingURL=repair-plugin-cache-script.test.js.map