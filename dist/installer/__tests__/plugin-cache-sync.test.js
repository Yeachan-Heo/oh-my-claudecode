import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
const ORIG_ENV = { ...process.env };
function writeFile(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
function writePayloadTree(root, version = '9.9.9-test') {
    mkdirSync(root, { recursive: true });
    writeFile(join(root, 'dist', 'lib', 'worktree-paths.js'), 'export const test = true;\n');
    writeFile(join(root, 'dist', 'hooks', 'skill-bridge.cjs'), 'console.log("skill bridge");\n');
    writeFile(join(root, 'bridge', 'cli.cjs'), 'console.log("bridge");\n');
    writeFile(join(root, 'bridge', 'claude-md-coordinator.cjs'), 'console.log("CLAUDE.md coordinator");\n');
    writeFile(join(root, 'hooks', 'hooks.json'), '{}\n');
    writeFile(join(root, 'scripts', 'run.cjs'), 'console.log("run");\n');
    writeFile(join(root, 'skills', 'plan', 'SKILL.md'), '# plan\n');
    writeFile(join(root, 'agents', 'executor.md'), '# executor\n');
    writeFile(join(root, 'commands', 'omc-setup.md'), 'Read skills/omc-setup/SKILL.md and pass $ARGUMENTS.\n');
    writeFile(join(root, 'templates', 'deliverables.json'), '{}\n');
    writeFile(join(root, 'docs', 'CLAUDE.md'), '# docs\n');
    writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'oh-my-claudecode', commands: './commands/', skills: ['./skills/plan/'] }, null, 2));
    writeFile(join(root, '.mcp.json'), '{}\n');
    writeFile(join(root, 'README.md'), '# readme\n');
    writeFile(join(root, 'LICENSE'), 'MIT\n');
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'oh-my-claude-sisyphus', version }, null, 2));
}
async function freshInstaller() {
    vi.resetModules();
    return await import('../index.js');
}
describe('syncInstalledPluginPayload', () => {
    let tempRoot;
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'omc-plugin-cache-sync-'));
        process.env.CLAUDE_CONFIG_DIR = join(tempRoot, '.claude');
        delete process.env.CLAUDE_PLUGIN_ROOT;
        delete process.env.OMC_PLUGIN_ROOT;
    });
    afterEach(() => {
        vi.restoreAllMocks();
        for (const key of Object.keys(process.env)) {
            if (!(key in ORIG_ENV))
                delete process.env[key];
        }
        Object.assign(process.env, ORIG_ENV);
        rmSync(tempRoot, { recursive: true, force: true });
    });
    it('repairs incomplete cache installs from the known marketplace source instead of reusing the installed root', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.12.0');
        const sourceRoot = join(tempRoot, 'marketplace-source');
        writePayloadTree(sourceRoot);
        mkdirSync(join(cacheRoot, 'agents'), { recursive: true });
        writeFileSync(join(cacheRoot, 'agents', 'executor.md'), '# stale executor\n');
        mkdirSync(join(configDir, 'plugins'), { recursive: true });
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: cacheRoot, version: '4.12.0' }],
            },
        }, null, 2));
        writeFileSync(join(configDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({
            omc: {
                installLocation: sourceRoot,
                source: { source: 'directory', path: sourceRoot },
            },
        }, null, 2));
        const installer = await freshInstaller();
        const result = installer.syncInstalledPluginPayload();
        expect(result.synced).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.sourceRoot).toBe(sourceRoot);
        expect(result.targetRoots).toEqual([cacheRoot]);
        expect(existsSync(join(cacheRoot, 'package.json'))).toBe(true);
        expect(existsSync(join(cacheRoot, 'skills', 'plan', 'SKILL.md'))).toBe(true);
        expect(existsSync(join(cacheRoot, 'hooks', 'hooks.json'))).toBe(true);
        expect(existsSync(join(cacheRoot, 'scripts', 'run.cjs'))).toBe(true);
        expect(existsSync(join(cacheRoot, 'commands', 'omc-setup.md'))).toBe(true);
        expect(JSON.parse(readFileSync(join(cacheRoot, 'package.json'), 'utf-8')).version).toBe('9.9.9-test');
    });
    it('excludes marketplace sources that canonicalize to an installed cache target', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.12.0');
        const samePhysicalSourceRoot = `${cacheRoot}/../${basename(cacheRoot)}`;
        const sourceRoot = join(tempRoot, 'alternate-marketplace-source');
        writePayloadTree(sourceRoot);
        mkdirSync(join(cacheRoot, 'agents'), { recursive: true });
        writeFileSync(join(cacheRoot, 'agents', 'executor.md'), '# stale executor\n');
        mkdirSync(join(configDir, 'plugins'), { recursive: true });
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: cacheRoot, version: '4.12.0' }],
            },
        }, null, 2));
        writeFileSync(join(configDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({
            omc: {
                installLocation: samePhysicalSourceRoot,
                source: { source: 'directory', path: samePhysicalSourceRoot },
            },
            'oh-my-claudecode-local': {
                installLocation: sourceRoot,
                source: { source: 'directory', path: sourceRoot },
            },
        }, null, 2));
        const installer = await freshInstaller();
        const result = installer.syncInstalledPluginPayload();
        expect(result.synced).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.sourceRoot).toBe(sourceRoot);
        expect(result.sourceRoot).not.toBe(samePhysicalSourceRoot);
        expect(existsSync(join(cacheRoot, 'package.json'))).toBe(true);
        expect(JSON.parse(readFileSync(join(cacheRoot, 'package.json'), 'utf-8')).version).toBe('9.9.9-test');
        const selfCopyResult = installer.copyPluginSyncPayload(samePhysicalSourceRoot, [cacheRoot]);
        expect(selfCopyResult).toEqual({ synced: false, errors: [] });
    });
    it('repairs incomplete cache installs during setup before plugin-provided file detection runs', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.12.0');
        const sourceRoot = join(tempRoot, 'marketplace-source-install');
        writePayloadTree(sourceRoot, '4.12.0');
        mkdirSync(join(cacheRoot, 'agents'), { recursive: true });
        writeFileSync(join(cacheRoot, 'agents', 'executor.md'), '# stale executor\n');
        mkdirSync(join(configDir, 'plugins'), { recursive: true });
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: cacheRoot, version: '4.12.0' }],
            },
        }, null, 2));
        writeFileSync(join(configDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({
            omc: {
                installLocation: sourceRoot,
                source: { source: 'directory', path: sourceRoot },
            },
        }, null, 2));
        writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: ['oh-my-claudecode@omc'] }, null, 2));
        const installer = await freshInstaller();
        const result = installer.install({
            skipClaudeCheck: true,
            skipHud: true,
        });
        expect(result.success).toBe(true);
        expect(result.installedAgents).toEqual([]);
        expect(result.installedSkills).toEqual([]);
        expect(installer.hasPluginProvidedAgentFiles()).toBe(true);
        expect(installer.hasPluginProvidedSkillFiles()).toBe(true);
        expect(installer.hasPluginProvidedHookFiles()).toBe(true);
        expect(existsSync(join(cacheRoot, 'package.json'))).toBe(true);
        expect(existsSync(join(cacheRoot, 'skills', 'plan', 'SKILL.md'))).toBe(true);
        expect(existsSync(join(cacheRoot, 'hooks', 'hooks.json'))).toBe(true);
        expect(existsSync(join(cacheRoot, 'scripts', 'run.cjs'))).toBe(true);
        expect(existsSync(join(cacheRoot, 'commands', 'omc-setup.md'))).toBe(true);
    });
    it('does not accept a cache root as plugin-provided when required commands are missing', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.4');
        writePayloadTree(cacheRoot, '4.14.4');
        rmSync(join(cacheRoot, 'commands'), { recursive: true, force: true });
        mkdirSync(join(configDir, 'plugins'), { recursive: true });
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: cacheRoot, version: '4.14.4' }],
            },
        }, null, 2));
        const installer = await freshInstaller();
        expect(installer.validatePluginCachePayload(cacheRoot)).toMatchObject({ valid: false });
        expect(installer.validatePluginCachePayload(cacheRoot).errors).toContain('Missing required plugin command markdown files in commands/');
        expect(installer.hasPluginProvidedAgentFiles()).toBe(false);
        expect(installer.hasPluginProvidedSkillFiles()).toBe(false);
        expect(installer.hasPluginProvidedHookFiles()).toBe(false);
    });
    it('rejects malformed plugin manifests instead of treating sentinel files as complete', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.4');
        writePayloadTree(cacheRoot, '4.14.4');
        writeFileSync(join(cacheRoot, '.claude-plugin', 'plugin.json'), '{not valid json');
        mkdirSync(join(configDir, 'plugins'), { recursive: true });
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: cacheRoot, version: '4.14.4' }],
            },
        }, null, 2));
        const installer = await freshInstaller();
        const validation = installer.validatePluginCachePayload(cacheRoot);
        expect(validation.valid).toBe(false);
        expect(validation.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('Invalid plugin manifest: .claude-plugin/plugin.json'),
        ]));
        expect(installer.hasPluginProvidedAgentFiles()).toBe(false);
    });
    it('rejects partial command and manifest-declared skill surfaces', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.4');
        writePayloadTree(cacheRoot, '4.14.4');
        rmSync(join(cacheRoot, 'commands', 'omc-setup.md'), { force: true });
        writeFile(join(cacheRoot, 'commands', 'unrelated.md'), '# unrelated\n');
        rmSync(join(cacheRoot, 'skills', 'plan'), { recursive: true, force: true });
        mkdirSync(join(configDir, 'plugins'), { recursive: true });
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: cacheRoot, version: '4.14.4' }],
            },
        }, null, 2));
        const installer = await freshInstaller();
        const validation = installer.validatePluginCachePayload(cacheRoot);
        expect(validation.valid).toBe(false);
        expect(validation.errors).toEqual(expect.arrayContaining([
            'Missing required plugin command file: commands/omc-setup.md',
            'Missing required plugin skill definitions in skills/',
            'Missing declared plugin skill file: skills/plan/SKILL.md',
        ]));
        expect(installer.hasPluginProvidedAgentFiles()).toBe(false);
    });
    it('rejects schema-malformed plugin manifests even when payload files exist', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.4');
        writePayloadTree(cacheRoot, '4.14.4');
        writeFileSync(join(cacheRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
            name: 'oh-my-claudecode',
            commands: 17,
            skills: './skills/plan/',
        }));
        const installer = await freshInstaller();
        const validation = installer.validatePluginCachePayload(cacheRoot);
        expect(validation.valid).toBe(false);
        expect(validation.errors).toEqual(expect.arrayContaining([
            'Invalid plugin manifest: .claude-plugin/plugin.json commands must be a non-empty relative path',
            'Invalid plugin manifest: .claude-plugin/plugin.json skills must be a non-empty array',
        ]));
    });
    it('rejects manifest-declared skill paths that escape the plugin root', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.4');
        writePayloadTree(cacheRoot, '4.14.4');
        writeFileSync(join(cacheRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
            name: 'oh-my-claudecode',
            commands: './commands/',
            skills: ['../outside/'],
        }));
        const installer = await freshInstaller();
        const validation = installer.validatePluginCachePayload(cacheRoot);
        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain('Invalid plugin skill declaration outside plugin root: ../outside/');
    });
    it('rejects required plugin file paths that exist only as directories', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.4');
        writePayloadTree(cacheRoot, '4.14.4');
        rmSync(join(cacheRoot, 'dist', 'hooks', 'skill-bridge.cjs'), { force: true });
        mkdirSync(join(cacheRoot, 'dist', 'hooks', 'skill-bridge.cjs'), { recursive: true });
        rmSync(join(cacheRoot, 'bridge', 'claude-md-coordinator.cjs'), { force: true });
        mkdirSync(join(cacheRoot, 'bridge', 'claude-md-coordinator.cjs'), { recursive: true });
        rmSync(join(cacheRoot, 'commands', 'omc-setup.md'), { force: true });
        mkdirSync(join(cacheRoot, 'commands', 'omc-setup.md'), { recursive: true });
        rmSync(join(cacheRoot, 'skills', 'plan', 'SKILL.md'), { force: true });
        mkdirSync(join(cacheRoot, 'skills', 'plan', 'SKILL.md'), { recursive: true });
        const installer = await freshInstaller();
        const validation = installer.validatePluginCachePayload(cacheRoot);
        expect(validation.valid).toBe(false);
        expect(validation.errors).toEqual(expect.arrayContaining([
            'Missing required plugin payload file: dist/hooks/skill-bridge.cjs',
            'Missing required plugin payload file: bridge/claude-md-coordinator.cjs',
            'Missing required plugin command file: commands/omc-setup.md',
            'Missing declared plugin skill file: skills/plan/SKILL.md',
        ]));
    });
    it('repairs cache roots missing commands, runtime dist hook, and bridge coordinator from a complete source', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.4');
        const sourceRoot = join(tempRoot, 'complete-marketplace-source');
        writePayloadTree(sourceRoot, '4.14.4');
        writePayloadTree(cacheRoot, '4.14.4');
        rmSync(join(cacheRoot, 'commands'), { recursive: true, force: true });
        rmSync(join(cacheRoot, 'dist', 'hooks'), { recursive: true, force: true });
        rmSync(join(cacheRoot, 'bridge'), { recursive: true, force: true });
        mkdirSync(join(configDir, 'plugins'), { recursive: true });
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: cacheRoot, version: '4.14.4' }],
            },
        }, null, 2));
        writeFileSync(join(configDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({
            omc: {
                installLocation: sourceRoot,
                source: { source: 'directory', path: sourceRoot },
            },
        }, null, 2));
        const installer = await freshInstaller();
        const result = installer.syncInstalledPluginPayload();
        expect(result.synced).toBe(true);
        expect(result.errors).toEqual([]);
        expect(installer.validatePluginCachePayload(cacheRoot)).toEqual({ valid: true, errors: [] });
        expect(existsSync(join(cacheRoot, 'commands', 'omc-setup.md'))).toBe(true);
        expect(existsSync(join(cacheRoot, 'dist', 'hooks', 'skill-bridge.cjs'))).toBe(true);
        expect(existsSync(join(cacheRoot, 'bridge', 'cli.cjs'))).toBe(true);
        expect(existsSync(join(cacheRoot, 'bridge', 'claude-md-coordinator.cjs'))).toBe(true);
    });
    it('rejects package sources missing runtime-critical dist hook or bridge payload files', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.4');
        const incompleteSourceRoot = join(tempRoot, 'incomplete-marketplace-source');
        writePayloadTree(incompleteSourceRoot, '4.14.4');
        rmSync(join(incompleteSourceRoot, 'dist', 'hooks'), { recursive: true, force: true });
        rmSync(join(incompleteSourceRoot, 'bridge'), { recursive: true, force: true });
        mkdirSync(cacheRoot, { recursive: true });
        mkdirSync(join(configDir, 'plugins'), { recursive: true });
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: cacheRoot, version: '4.14.4' }],
            },
        }, null, 2));
        writeFileSync(join(configDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({
            omc: {
                installLocation: incompleteSourceRoot,
                source: { source: 'directory', path: incompleteSourceRoot },
            },
        }, null, 2));
        const installer = await freshInstaller();
        const result = installer.copyPluginSyncPayload(incompleteSourceRoot, [cacheRoot]);
        expect(result.synced).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            `${incompleteSourceRoot}: Missing required plugin payload file: dist/hooks/skill-bridge.cjs`,
            `${incompleteSourceRoot}: Missing required plugin payload file: bridge/cli.cjs`,
            `${incompleteSourceRoot}: Missing required plugin payload file: bridge/claude-md-coordinator.cjs`,
        ]));
        expect(existsSync(join(cacheRoot, 'package.json'))).toBe(false);
    });
    it('rejects cache install roots that escape the cache directory via .. segments', async () => {
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const cacheBase = join(configDir, 'plugins', 'cache');
        const escapedInstallPath = `${cacheBase}/../../../escaped-target`;
        const escapedResolvedRoot = join(tempRoot, 'escaped-target');
        const sourceRoot = join(tempRoot, 'marketplace-source-escape');
        writePayloadTree(sourceRoot);
        mkdirSync(cacheBase, { recursive: true });
        mkdirSync(escapedResolvedRoot, { recursive: true });
        mkdirSync(join(configDir, 'plugins'), { recursive: true });
        writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: escapedInstallPath, version: '4.12.0' }],
            },
        }, null, 2));
        writeFileSync(join(configDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({
            omc: {
                installLocation: sourceRoot,
                source: { source: 'directory', path: sourceRoot },
            },
        }, null, 2));
        const installer = await freshInstaller();
        const result = installer.syncInstalledPluginPayload();
        expect(result.synced).toBe(false);
        expect(result.errors).toEqual([]);
        expect(result.sourceRoot).toBeNull();
        expect(result.targetRoots).toEqual([]);
        expect(existsSync(join(escapedResolvedRoot, 'package.json'))).toBe(false);
        expect(existsSync(join(escapedResolvedRoot, 'skills', 'plan', 'SKILL.md'))).toBe(false);
    });
});
//# sourceMappingURL=plugin-cache-sync.test.js.map