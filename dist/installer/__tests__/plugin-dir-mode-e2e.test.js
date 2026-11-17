/**
 * End-to-end filesystem tests for `--plugin-dir-mode`.
 *
 * Unlike `plugin-dir-mode.test.ts`, which exercises the CLI precedence helper
 * in isolation, this suite calls the real `install()` function from
 * `src/installer/index.ts` against a throwaway `CLAUDE_CONFIG_DIR` and asserts
 * the resulting on-disk shape matches the documented contract.
 *
 * Scope: installer contract only. The CLI auto-detection log message and the
 * `--no-plugin` / `--plugin-dir-mode` conflict warning live in `src/cli/index.ts`
 * and are exercised by Slice C's CLI tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OMC_PLUGIN_ROOT_ENV } from '../../lib/env-vars.js';
const SAVED_ENV_KEYS = [
    'CLAUDE_CONFIG_DIR',
    OMC_PLUGIN_ROOT_ENV,
    'CLAUDE_PLUGIN_ROOT',
    'OMC_DEV',
];
let testDir;
let savedEnv;
async function freshInstaller() {
    vi.resetModules();
    return await import('../index.js');
}
function isPopulated(dir) {
    return existsSync(dir) && readdirSync(dir).length > 0;
}
beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'omc-pdm-e2e-'));
    savedEnv = {};
    for (const key of SAVED_ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = testDir;
});
afterEach(() => {
    for (const key of SAVED_ENV_KEYS) {
        const prev = savedEnv[key];
        if (prev === undefined) {
            delete process.env[key];
        }
        else {
            process.env[key] = prev;
        }
    }
    try {
        rmSync(testDir, { recursive: true, force: true });
    }
    catch { /* ignore */ }
});
describe('install() — plugin-dir-mode end-to-end filesystem shape', () => {
    it('case 1: pluginDirMode=true → installs HUD/CLAUDE.md/settings/.omc-config but NOT agents/skills', async () => {
        const { install } = await freshInstaller();
        install({ verbose: false, skipClaudeCheck: true, pluginDirMode: true });
        // HUD wrapper present and non-empty
        const hudPath = join(testDir, 'hud', 'omc-hud.mjs');
        expect(existsSync(hudPath)).toBe(true);
        expect(statSync(hudPath).size).toBeGreaterThan(0);
        // CLAUDE.md present with merge markers
        const claudeMdPath = join(testDir, 'CLAUDE.md');
        expect(existsSync(claudeMdPath)).toBe(true);
        const claudeMdContent = readFileSync(claudeMdPath, 'utf8');
        expect(claudeMdContent).toContain('<!-- OMC:START -->');
        expect(claudeMdContent).toContain('<!-- OMC:END -->');
        // settings.json present with hooks
        const settingsPath = join(testDir, 'settings.json');
        expect(existsSync(settingsPath)).toBe(true);
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        expect(settings.hooks).toBeDefined();
        // .omc-config.json present
        expect(existsSync(join(testDir, '.omc-config.json'))).toBe(true);
        // agents/ NOT created
        expect(existsSync(join(testDir, 'agents'))).toBe(false);
        // skills/ either missing or empty
        const skillsDir = join(testDir, 'skills');
        if (existsSync(skillsDir)) {
            expect(readdirSync(skillsDir)).toEqual([]);
        }
    });
    it('case 2: OMC_PLUGIN_ROOT env set + pluginDirMode=true → same shape as case 1', async () => {
        // The CLI's auto-detection of OMC_PLUGIN_ROOT lives in src/cli/index.ts and
        // is covered by Slice C. Here we test the installer contract: setting
        // pluginDirMode produces the same on-disk shape regardless of whether
        // OMC_PLUGIN_ROOT points anywhere real.
        process.env[OMC_PLUGIN_ROOT_ENV] = '/tmp/fake-nonexistent-root-for-pdm-e2e';
        const { install } = await freshInstaller();
        install({ verbose: false, skipClaudeCheck: true, pluginDirMode: true });
        expect(existsSync(join(testDir, 'hud', 'omc-hud.mjs'))).toBe(true);
        expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(true);
        expect(existsSync(join(testDir, 'settings.json'))).toBe(true);
        expect(existsSync(join(testDir, '.omc-config.json'))).toBe(true);
        expect(existsSync(join(testDir, 'agents'))).toBe(false);
        const skillsDir = join(testDir, 'skills');
        if (existsSync(skillsDir)) {
            expect(readdirSync(skillsDir)).toEqual([]);
        }
    });
    it('case 3: pluginDirMode + noPlugin → noPlugin wins, skills and agents are populated', async () => {
        const { install, hasEnabledOmcPlugin } = await freshInstaller();
        const result = install({
            verbose: false,
            skipClaudeCheck: true,
            pluginDirMode: true,
            noPlugin: true,
        });
        // noPlugin forces bundled skills regardless of pluginDirMode
        expect(result.installedSkills.length).toBeGreaterThan(0);
        expect(isPopulated(join(testDir, 'skills'))).toBe(true);
        // Legacy agents are written when not running as a plugin
        if (!hasEnabledOmcPlugin()) {
            expect(result.installedAgents.length).toBeGreaterThan(0);
            expect(isPopulated(join(testDir, 'agents'))).toBe(true);
        }
    });
    it('case 4: no flag, no env → baseline behavior populates skills and agents', async () => {
        const { install, hasEnabledOmcPlugin } = await freshInstaller();
        // Fresh tmp config dir is guaranteed not to have an enabled plugin.
        expect(hasEnabledOmcPlugin()).toBe(false);
        const result = install({ verbose: false, skipClaudeCheck: true });
        expect(result.installedAgents.length).toBeGreaterThan(0);
        expect(result.installedSkills.length).toBeGreaterThan(0);
        expect(isPopulated(join(testDir, 'agents'))).toBe(true);
        expect(isPopulated(join(testDir, 'skills'))).toBe(true);
    });
});
//# sourceMappingURL=plugin-dir-mode-e2e.test.js.map