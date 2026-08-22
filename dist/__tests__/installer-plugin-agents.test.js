import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, } from 'node:fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    const { join: pathJoin } = await import('path');
    const repoRoot = process.cwd();
    const sourceAgentsDir = pathJoin(repoRoot, 'src', 'agents');
    const sourceClaudeMdPath = pathJoin(repoRoot, 'src', 'docs', 'CLAUDE.md');
    const realAgentsDir = pathJoin(repoRoot, 'agents');
    const realClaudeMdPath = pathJoin(repoRoot, 'docs', 'CLAUDE.md');
    const withRedirect = (pathLike) => {
        const normalized = String(pathLike).replace(/\\/g, '/');
        const normalizedSourceAgentsDir = sourceAgentsDir.replace(/\\/g, '/');
        const normalizedRealAgentsDir = realAgentsDir.replace(/\\/g, '/');
        if (normalized === normalizedSourceAgentsDir) {
            return realAgentsDir;
        }
        if (normalized.startsWith(`${normalizedSourceAgentsDir}/`)) {
            return normalized.replace(normalizedSourceAgentsDir, normalizedRealAgentsDir);
        }
        if (normalized === sourceClaudeMdPath.replace(/\\/g, '/')) {
            return realClaudeMdPath;
        }
        return String(pathLike);
    };
    return {
        ...actual,
        existsSync: vi.fn((pathLike) => actual.existsSync(withRedirect(pathLike))),
        readFileSync: vi.fn((pathLike, options) => actual.readFileSync(withRedirect(pathLike), options)),
        readdirSync: vi.fn((pathLike, options) => actual.readdirSync(withRedirect(pathLike), options)),
    };
});
async function loadInstallerWithEnv(claudeConfigDir, homeDir) {
    vi.resetModules();
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    process.env.HOME = homeDir;
    return import('../installer/index.js');
}
function writePluginFile(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
function writeCompletePluginPayload(root) {
    writePluginFile(join(root, 'dist', 'hooks', 'skill-bridge.cjs'), 'console.log("skill bridge");\n');
    writePluginFile(join(root, 'bridge', 'cli.cjs'), 'console.log("bridge");\n');
    writePluginFile(join(root, 'bridge', 'claude-md-coordinator.cjs'), 'console.log("coordinator");\n');
    writePluginFile(join(root, 'hooks', 'hooks.json'), '{}\n');
    writePluginFile(join(root, 'skills', 'plan', 'SKILL.md'), '# plan\n');
    writePluginFile(join(root, 'commands', 'omc-setup.md'), 'Read skills/omc-setup/SKILL.md and pass $ARGUMENTS.\n');
    writePluginFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
        name: 'oh-my-claudecode',
        commands: './commands/',
        skills: ['./skills/plan/'],
    }, null, 2));
    writePluginFile(join(root, 'package.json'), JSON.stringify({ name: 'oh-my-claude-sisyphus', version: '9.9.9' }, null, 2));
}
describe('installer legacy agent sync gating (issue #1502)', () => {
    let tempRoot;
    let homeDir;
    let claudeConfigDir;
    let originalClaudeConfigDir;
    let originalHome;
    let originalOmcPluginRoot;
    let originalClaudePluginRoot;
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'omc-installer-plugin-agents-'));
        homeDir = join(tempRoot, 'home');
        claudeConfigDir = join(homeDir, '.claude');
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(claudeConfigDir, { recursive: true });
        originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        originalHome = process.env.HOME;
        originalOmcPluginRoot = process.env.OMC_PLUGIN_ROOT;
        originalClaudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
        delete process.env.OMC_PLUGIN_ROOT;
        delete process.env.CLAUDE_PLUGIN_ROOT;
    });
    afterEach(() => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        if (originalHome === undefined) {
            delete process.env.HOME;
        }
        else {
            process.env.HOME = originalHome;
        }
        if (originalOmcPluginRoot === undefined) {
            delete process.env.OMC_PLUGIN_ROOT;
        }
        else {
            process.env.OMC_PLUGIN_ROOT = originalOmcPluginRoot;
        }
        if (originalClaudePluginRoot === undefined) {
            delete process.env.CLAUDE_PLUGIN_ROOT;
        }
        else {
            process.env.CLAUDE_PLUGIN_ROOT = originalClaudePluginRoot;
        }
        rmSync(tempRoot, { recursive: true, force: true });
        vi.resetModules();
    });
    it('skips recreating ~/.claude/agents when installed plugin agent files already exist', async () => {
        const pluginInstallPath = join(claudeConfigDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '9.9.9');
        const pluginAgentsDir = join(pluginInstallPath, 'agents');
        writeCompletePluginPayload(pluginInstallPath);
        mkdirSync(pluginAgentsDir, { recursive: true });
        writeFileSync(join(pluginAgentsDir, 'executor.md'), '---\nname: executor\ndescription: test\n---\n');
        const installedPluginsPath = join(claudeConfigDir, 'plugins', 'installed_plugins.json');
        mkdirSync(join(claudeConfigDir, 'plugins'), { recursive: true });
        writeFileSync(installedPluginsPath, JSON.stringify({
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: pluginInstallPath }],
            },
        }, null, 2));
        const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
        expect(installer.validatePluginCachePayload(pluginInstallPath)).toEqual({
            valid: true,
            errors: [],
        });
        const result = installer.install({
            skipClaudeCheck: true,
            skipHud: true,
        });
        expect(result.success, `${result.message}\n${result.errors.join('\n')}`).toBe(true);
        expect(result.installedAgents).toEqual([]);
        expect(installer.hasPluginProvidedAgentFiles()).toBe(true);
        expect(existsSync(join(claudeConfigDir, 'agents'))).toBe(false);
        expect(installer.isInstalled()).toBe(true);
    });
    it('recognizes the documented local-marketplace plugin id', async () => {
        const pluginInstallPath = join(claudeConfigDir, 'plugins', 'cache', 'oh-my-claudecode', 'oh-my-claudecode', '9.9.9');
        const pluginAgentsDir = join(pluginInstallPath, 'agents');
        writeCompletePluginPayload(pluginInstallPath);
        mkdirSync(pluginAgentsDir, { recursive: true });
        writeFileSync(join(pluginAgentsDir, 'executor.md'), '---\nname: executor\ndescription: test\n---\n');
        mkdirSync(join(claudeConfigDir, 'plugins'), { recursive: true });
        writeFileSync(join(claudeConfigDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            plugins: {
                'oh-my-claudecode@oh-my-claudecode': [
                    { installPath: pluginInstallPath },
                ],
            },
        }, null, 2));
        const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
        expect(installer.getInstalledOmcPluginRoots()).toEqual([pluginInstallPath]);
        expect(installer.hasPluginProvidedAgentFiles()).toBe(true);
        const result = installer.install({ skipClaudeCheck: true, skipHud: true });
        expect(result.success).toBe(true);
        expect(result.installedAgents).toEqual([]);
        expect(existsSync(join(claudeConfigDir, 'agents'))).toBe(false);
    });
    it('keeps exact-ID availability while fail-closing destructive cleanup beside a lookalike', async () => {
        const exactRoot = join(claudeConfigDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '9.9.9');
        const lookalikeRoot = join(tempRoot, 'lookalike-plugin');
        writeCompletePluginPayload(exactRoot);
        mkdirSync(join(exactRoot, 'agents'), { recursive: true });
        writeFileSync(join(exactRoot, 'agents', 'executor.md'), '---\nname: executor\ndescription: test\n---\n');
        mkdirSync(join(claudeConfigDir, 'plugins'), { recursive: true });
        writeFileSync(join(claudeConfigDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: exactRoot }],
                'oh-my-claudecode-local': [{ installPath: lookalikeRoot }],
            },
        }, null, 2));
        const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
        expect(installer.getInstalledOmcPluginRoots()).toEqual([exactRoot]);
        expect(installer.hasPluginProvidedAgentFiles()).toBe(true);
        const result = installer.install({ skipClaudeCheck: true, skipHud: true });
        expect(result.success).toBe(true);
        expect(result.installedAgents).toEqual([]);
        expect(existsSync(join(claudeConfigDir, 'agents'))).toBe(false);
        const agentsDir = join(claudeConfigDir, 'agents');
        mkdirSync(agentsDir, { recursive: true });
        const historicalPath = join(process.cwd(), 'src', 'installer', '__tests__', 'fixtures', 'historical-agents', 'build-fixer.md');
        writeFileSync(join(agentsDir, 'build-fixer.md'), readFileSync(historicalPath));
        expect(installer.cleanupStaleAgents(() => { })).toEqual([]);
        expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(true);
    });
    it('still installs legacy agent files when no plugin-provided agent files are available', async () => {
        const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
        const result = installer.install({
            skipClaudeCheck: true,
            skipHud: true,
        });
        expect(result.success).toBe(true);
        expect(result.installedAgents.length).toBeGreaterThan(0);
        expect(existsSync(join(claudeConfigDir, 'agents'))).toBe(true);
        expect(readdirSync(join(claudeConfigDir, 'agents')).some((file) => file.endsWith('.md'))).toBe(true);
        expect(existsSync(join(claudeConfigDir, 'hooks', 'lib', 'stdin.mjs'))).toBe(true);
        expect(existsSync(join(claudeConfigDir, 'hooks', 'lib', 'atomic-write.mjs'))).toBe(true);
        expect(installer.hasPluginProvidedAgentFiles()).toBe(false);
        expect(installer.isInstalled()).toBe(true);
    });
});
//# sourceMappingURL=installer-plugin-agents.test.js.map