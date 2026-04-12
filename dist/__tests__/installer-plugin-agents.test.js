import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'path';
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
describe('installer legacy agent sync gating (issue #1502)', () => {
    let tempRoot;
    let homeDir;
    let claudeConfigDir;
    let originalClaudeConfigDir;
    let originalOmcPluginRoot;
    let originalHome;
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'omc-installer-plugin-agents-'));
        homeDir = join(tempRoot, 'home');
        claudeConfigDir = join(homeDir, '.claude');
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(claudeConfigDir, { recursive: true });
        originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        originalOmcPluginRoot = process.env.OMC_PLUGIN_ROOT;
        originalHome = process.env.HOME;
        delete process.env.OMC_PLUGIN_ROOT;
    });
    afterEach(() => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        if (originalOmcPluginRoot === undefined) {
            delete process.env.OMC_PLUGIN_ROOT;
        }
        else {
            process.env.OMC_PLUGIN_ROOT = originalOmcPluginRoot;
        }
        if (originalHome === undefined) {
            delete process.env.HOME;
        }
        else {
            process.env.HOME = originalHome;
        }
        rmSync(tempRoot, { recursive: true, force: true });
        vi.resetModules();
    });
    it('skips recreating ~/.claude/agents when installed plugin agent files already exist', async () => {
        const pluginInstallPath = join(claudeConfigDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '9.9.9');
        const pluginAgentsDir = join(pluginInstallPath, 'agents');
        mkdirSync(pluginAgentsDir, { recursive: true });
        writeFileSync(join(pluginAgentsDir, 'executor.md'), '---\nname: executor\ndescription: test\n---\n');
        const installedPluginsPath = join(claudeConfigDir, 'plugins', 'installed_plugins.json');
        mkdirSync(join(claudeConfigDir, 'plugins'), { recursive: true });
        writeFileSync(installedPluginsPath, JSON.stringify({
            plugins: {
                'oh-my-claudecode@omc': [
                    { installPath: pluginInstallPath }
                ]
            }
        }, null, 2));
        const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
        const result = installer.install({
            skipClaudeCheck: true,
            skipHud: true,
        });
        expect(result.success).toBe(true);
        expect(result.installedAgents).toEqual([]);
        expect(installer.hasPluginProvidedAgentFiles()).toBe(true);
        expect(existsSync(join(claudeConfigDir, 'agents'))).toBe(false);
        expect(installer.isInstalled()).toBe(true);
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
        expect(readdirSync(join(claudeConfigDir, 'agents')).some(file => file.endsWith('.md'))).toBe(true);
        expect(installer.hasPluginProvidedAgentFiles()).toBe(false);
        expect(installer.isInstalled()).toBe(true);
    });
});
//# sourceMappingURL=installer-plugin-agents.test.js.map