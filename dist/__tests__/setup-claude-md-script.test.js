import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const REPO_ROOT = join(__dirname, '..', '..');
const SETUP_SCRIPT = join(REPO_ROOT, 'scripts', 'setup-claude-md.sh');
const tempRoots = [];
function createPluginFixture(claudeMdContent) {
    const root = mkdtempSync(join(tmpdir(), 'omc-setup-claude-md-'));
    tempRoots.push(root);
    const pluginRoot = join(root, 'plugin');
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');
    mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
    mkdirSync(join(pluginRoot, 'docs'), { recursive: true });
    mkdirSync(join(pluginRoot, 'skills', 'omc-reference'), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });
    copyFileSync(SETUP_SCRIPT, join(pluginRoot, 'scripts', 'setup-claude-md.sh'));
    writeFileSync(join(pluginRoot, 'docs', 'CLAUDE.md'), claudeMdContent);
    writeFileSync(join(pluginRoot, 'skills', 'omc-reference', 'SKILL.md'), `---
name: omc-reference
description: Test fixture reference skill
user-invocable: false
---

# Test OMC Reference
`);
    return {
        pluginRoot,
        projectRoot,
        homeRoot,
        scriptPath: join(pluginRoot, 'scripts', 'setup-claude-md.sh'),
    };
}
afterEach(() => {
    while (tempRoots.length > 0) {
        const root = tempRoots.pop();
        if (root) {
            rmSync(root, { recursive: true, force: true });
        }
    }
});
describe('setup-claude-md.sh (issue #1572)', () => {
    it('installs the canonical docs/CLAUDE.md content with OMC markers', () => {
        const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);
        const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
            cwd: fixture.projectRoot,
            env: {
                ...process.env,
                HOME: fixture.homeRoot,
            },
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        const installedPath = join(fixture.projectRoot, '.claude', 'CLAUDE.md');
        expect(existsSync(installedPath)).toBe(true);
        const installed = readFileSync(installedPath, 'utf-8');
        expect(installed).toContain('<!-- OMC:START -->');
        expect(installed).toContain('<!-- OMC:END -->');
        expect(installed).toContain('<!-- OMC:VERSION:9.9.9 -->');
        expect(installed).toContain('# Canonical CLAUDE');
        const installedSkillPath = join(fixture.projectRoot, '.claude', 'skills', 'omc-reference', 'SKILL.md');
        expect(existsSync(installedSkillPath)).toBe(true);
        expect(readFileSync(installedSkillPath, 'utf-8')).toContain('# Test OMC Reference');
    });
    it('refuses to install a canonical source that lacks OMC markers', () => {
        const fixture = createPluginFixture(`# oh-my-claudecode (OMC) v9.9.9 Summary

This is a summarized CLAUDE.md without markers.
`);
        const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
            cwd: fixture.projectRoot,
            env: {
                ...process.env,
                HOME: fixture.homeRoot,
            },
            encoding: 'utf-8',
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('missing required OMC markers');
        expect(existsSync(join(fixture.projectRoot, '.claude', 'CLAUDE.md'))).toBe(false);
    });
    it('adds a local git exclude block for .omc artifacts while preserving .omc/skills', () => {
        const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);
        const gitInit = spawnSync('git', ['init'], {
            cwd: fixture.projectRoot,
            env: {
                ...process.env,
                HOME: fixture.homeRoot,
            },
            encoding: 'utf-8',
        });
        expect(gitInit.status).toBe(0);
        const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
            cwd: fixture.projectRoot,
            env: {
                ...process.env,
                HOME: fixture.homeRoot,
            },
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        const excludePath = join(fixture.projectRoot, '.git', 'info', 'exclude');
        expect(existsSync(excludePath)).toBe(true);
        const excludeContents = readFileSync(excludePath, 'utf-8');
        expect(excludeContents).toContain('# BEGIN OMC local artifacts');
        expect(excludeContents).toContain('.omc/*');
        expect(excludeContents).toContain('!.omc/skills/');
        expect(excludeContents).toContain('!.omc/skills/**');
        expect(excludeContents).toContain('# END OMC local artifacts');
    });
    it('does not duplicate the local git exclude block on repeated local setup runs', () => {
        const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);
        const gitInit = spawnSync('git', ['init'], {
            cwd: fixture.projectRoot,
            env: {
                ...process.env,
                HOME: fixture.homeRoot,
            },
            encoding: 'utf-8',
        });
        expect(gitInit.status).toBe(0);
        const firstRun = spawnSync('bash', [fixture.scriptPath, 'local'], {
            cwd: fixture.projectRoot,
            env: {
                ...process.env,
                HOME: fixture.homeRoot,
            },
            encoding: 'utf-8',
        });
        expect(firstRun.status).toBe(0);
        const secondRun = spawnSync('bash', [fixture.scriptPath, 'local'], {
            cwd: fixture.projectRoot,
            env: {
                ...process.env,
                HOME: fixture.homeRoot,
            },
            encoding: 'utf-8',
        });
        expect(secondRun.status).toBe(0);
        const excludeContents = readFileSync(join(fixture.projectRoot, '.git', 'info', 'exclude'), 'utf-8');
        expect(excludeContents.match(/# BEGIN OMC local artifacts/g)).toHaveLength(1);
    });
});
describe('setup-claude-md.sh stale CLAUDE_PLUGIN_ROOT resolution', () => {
    it('uses docs/CLAUDE.md from the active version in installed_plugins.json, not the stale script location', () => {
        // Simulate: script lives at old version (4.8.2), but installed_plugins.json points to new version (4.9.0)
        const root = mkdtempSync(join(tmpdir(), 'omc-stale-root-'));
        tempRoots.push(root);
        const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        const oldVersion = join(cacheBase, '4.8.2');
        const newVersion = join(cacheBase, '4.9.0');
        const projectRoot = join(root, 'project');
        const homeRoot = join(root, 'home');
        // Create old version (where the script will be copied)
        mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
        mkdirSync(join(oldVersion, 'docs'), { recursive: true });
        copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
        writeFileSync(join(oldVersion, 'docs', 'CLAUDE.md'), `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n\n# Old Version\n<!-- OMC:END -->\n`);
        // Create new version (the active one)
        mkdirSync(join(newVersion, 'docs'), { recursive: true });
        writeFileSync(join(newVersion, 'docs', 'CLAUDE.md'), `<!-- OMC:START -->\n<!-- OMC:VERSION:4.9.0 -->\n\n# New Version\n<!-- OMC:END -->\n`);
        // Create installed_plugins.json pointing to the new version
        mkdirSync(join(homeRoot, '.claude', 'plugins'), { recursive: true });
        writeFileSync(join(homeRoot, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
            'oh-my-claudecode@omc': [
                {
                    installPath: newVersion,
                    version: '4.9.0',
                },
            ],
        }));
        // Create project dir and settings.json (needed for plugin verification)
        mkdirSync(projectRoot, { recursive: true });
        mkdirSync(join(homeRoot, '.claude'), { recursive: true });
        writeFileSync(join(homeRoot, '.claude', 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));
        // Run the OLD version's script — it should resolve to the NEW version's docs/CLAUDE.md
        const result = spawnSync('bash', [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'], {
            cwd: projectRoot,
            env: {
                ...process.env,
                HOME: homeRoot,
                CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
            },
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
        // Should contain the NEW version, not the old one
        expect(installed).toContain('<!-- OMC:VERSION:4.9.0 -->');
        expect(installed).toContain('# New Version');
        expect(installed).not.toContain('<!-- OMC:VERSION:4.8.2 -->');
    });
    it('uses docs/CLAUDE.md from the active version when installed_plugins.json wraps plugins under a plugins key', () => {
        const root = mkdtempSync(join(tmpdir(), 'omc-stale-wrapped-root-'));
        tempRoots.push(root);
        const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        const oldVersion = join(cacheBase, '4.8.2');
        const newVersion = join(cacheBase, '4.9.0');
        const projectRoot = join(root, 'project');
        const homeRoot = join(root, 'home');
        mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
        mkdirSync(join(oldVersion, 'docs'), { recursive: true });
        copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
        writeFileSync(join(oldVersion, 'docs', 'CLAUDE.md'), `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n\n# Old Version\n<!-- OMC:END -->\n`);
        mkdirSync(join(newVersion, 'docs'), { recursive: true });
        writeFileSync(join(newVersion, 'docs', 'CLAUDE.md'), `<!-- OMC:START -->\n<!-- OMC:VERSION:4.9.0 -->\n\n# New Version\n<!-- OMC:END -->\n`);
        mkdirSync(join(homeRoot, '.claude', 'plugins'), { recursive: true });
        writeFileSync(join(homeRoot, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
            plugins: {
                'oh-my-claudecode@omc': [
                    {
                        installPath: newVersion,
                        version: '4.9.0',
                    },
                ],
            },
        }));
        mkdirSync(projectRoot, { recursive: true });
        mkdirSync(join(homeRoot, '.claude'), { recursive: true });
        writeFileSync(join(homeRoot, '.claude', 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));
        const result = spawnSync('bash', [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'], {
            cwd: projectRoot,
            env: {
                ...process.env,
                HOME: homeRoot,
                CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
            },
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
        expect(installed).toContain('<!-- OMC:VERSION:4.9.0 -->');
        expect(installed).toContain('# New Version');
        expect(installed).not.toContain('<!-- OMC:VERSION:4.8.2 -->');
    });
    it('falls back to scanning cache for latest version when installed_plugins.json is unavailable', () => {
        const root = mkdtempSync(join(tmpdir(), 'omc-stale-fallback-'));
        tempRoots.push(root);
        const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        const oldVersion = join(cacheBase, '4.8.2');
        const newVersion = join(cacheBase, '4.9.0');
        const projectRoot = join(root, 'project');
        const homeRoot = join(root, 'home');
        // Create old version (where the script lives)
        mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
        mkdirSync(join(oldVersion, 'docs'), { recursive: true });
        copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
        writeFileSync(join(oldVersion, 'docs', 'CLAUDE.md'), `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n\n# Old\n<!-- OMC:END -->\n`);
        // Create new version (no installed_plugins.json, relies on cache scan)
        mkdirSync(join(newVersion, 'docs'), { recursive: true });
        writeFileSync(join(newVersion, 'docs', 'CLAUDE.md'), `<!-- OMC:START -->\n<!-- OMC:VERSION:4.9.0 -->\n\n# New\n<!-- OMC:END -->\n`);
        // No installed_plugins.json — fallback to cache scan
        mkdirSync(join(homeRoot, '.claude'), { recursive: true });
        mkdirSync(projectRoot, { recursive: true });
        writeFileSync(join(homeRoot, '.claude', 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));
        const result = spawnSync('bash', [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'], {
            cwd: projectRoot,
            env: {
                ...process.env,
                HOME: homeRoot,
                CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
            },
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
        expect(installed).toContain('<!-- OMC:VERSION:4.9.0 -->');
        expect(installed).not.toContain('<!-- OMC:VERSION:4.8.2 -->');
    });
});
//# sourceMappingURL=setup-claude-md-script.test.js.map