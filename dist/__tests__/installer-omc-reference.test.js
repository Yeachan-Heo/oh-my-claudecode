import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'path';
import { tmpdir } from 'os';
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    const { join: pathJoin } = await import('path');
    const repoRoot = process.cwd();
    const sourceSkillsDir = pathJoin(repoRoot, 'src', 'skills');
    const sourceClaudeMdPath = pathJoin(repoRoot, 'src', 'docs', 'CLAUDE.md');
    const realSkillsDir = pathJoin(repoRoot, 'skills');
    const realClaudeMdPath = pathJoin(repoRoot, 'docs', 'CLAUDE.md');
    const withRedirect = (pathLike) => {
        const normalized = String(pathLike).replace(/\\/g, '/');
        const normalizedSourceSkillsDir = sourceSkillsDir.replace(/\\/g, '/');
        const normalizedRealSkillsDir = realSkillsDir.replace(/\\/g, '/');
        if (normalized === normalizedSourceSkillsDir) {
            return realSkillsDir;
        }
        if (normalized.startsWith(`${normalizedSourceSkillsDir}/`)) {
            return normalized.replace(normalizedSourceSkillsDir, normalizedRealSkillsDir);
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
describe('installer omc-reference legacy skill sync (issue #1812)', () => {
    let tempRoot;
    let homeDir;
    let claudeConfigDir;
    let originalClaudeConfigDir;
    let originalHome;
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'omc-installer-omc-reference-'));
        homeDir = join(tempRoot, 'home');
        claudeConfigDir = join(homeDir, '.claude');
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(claudeConfigDir, { recursive: true });
        originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        originalHome = process.env.HOME;
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
        rmSync(tempRoot, { recursive: true, force: true });
        vi.resetModules();
    });
    it('installs only the omc-reference skill during legacy install', async () => {
        const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
        const result = installer.install({
            skipClaudeCheck: true,
            skipHud: true,
        });
        expect(result.success).toBe(true);
        expect(result.installedSkills).toContain('omc-reference/SKILL.md');
        const installedSkillPath = join(claudeConfigDir, 'skills', 'omc-reference', 'SKILL.md');
        expect(existsSync(installedSkillPath)).toBe(true);
        expect(readFileSync(installedSkillPath, 'utf-8')).toContain('name: omc-reference');
    });
});
//# sourceMappingURL=installer-omc-reference.test.js.map