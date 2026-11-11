import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const entitlementFixture = {
    schemaVersion: 1,
    skininthegamebrosOnlySkills: [' Remember ', 'VERIFY', 'debug'],
};
const entitlementNames = ['remember', 'verify', 'debug'];
const originalUserType = process.env.USER_TYPE;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalHome = process.env.HOME;
async function withEntitlementFixture(run) {
    vi.resetModules();
    vi.doMock('../config/builtin-skill-entitlements.json', () => ({
        default: entitlementFixture,
    }));
    try {
        await run();
    }
    finally {
        vi.doUnmock('../config/builtin-skill-entitlements.json');
        vi.resetModules();
    }
}
afterEach(() => {
    if (originalUserType === undefined)
        delete process.env.USER_TYPE;
    else
        process.env.USER_TYPE = originalUserType;
    if (originalClaudeConfigDir === undefined)
        delete process.env.CLAUDE_CONFIG_DIR;
    else
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    if (originalHome === undefined)
        delete process.env.HOME;
    else
        process.env.HOME = originalHome;
});
describe('nonempty skill entitlement fixture', () => {
    it('applies mixed-case values in the plugin loader for remember, verify, and debug', async () => {
        await withEntitlementFixture(async () => {
            const { clearSkillsCache, listBuiltinSkillNames } = await import('../features/builtin-skills/skills.js');
            process.env.USER_TYPE = '';
            clearSkillsCache();
            expect(listBuiltinSkillNames({ includeAliases: true })).not.toEqual(expect.arrayContaining(entitlementNames));
            process.env.USER_TYPE = 'ant';
            clearSkillsCache();
            expect(listBuiltinSkillNames({ includeAliases: true })).toEqual(expect.arrayContaining(entitlementNames));
        });
    });
    it('withholds delegation guidance for mixed-case hidden skill invocations', async () => {
        await withEntitlementFixture(async () => {
            const { enforceModel } = await import('../features/delegation-enforcer.js');
            const { clearSkillsCache } = await import('../features/builtin-skills/skills.js');
            for (const skill of ['Remember', 'VERIFY', 'Debug']) {
                process.env.USER_TYPE = '';
                clearSkillsCache();
                expect(() => enforceModel({ description: 't', prompt: 'p', subagent_type: `oh-my-claudecode:${skill}` }))
                    .toThrow(/Unknown agent type/);
                expect(() => enforceModel({ description: 't', prompt: 'p', subagent_type: `oh-my-claudecode:${skill}` }))
                    .not.toThrow(/Skill\(skill=/);
                process.env.USER_TYPE = 'ant';
                clearSkillsCache();
                expect(() => enforceModel({ description: 't', prompt: 'p', subagent_type: `oh-my-claudecode:${skill}` }))
                    .toThrow(`Skill(skill="oh-my-claudecode:${skill.toLowerCase()}")`);
            }
        });
    });
    it('keeps mixed-case entitled skills out of non-ant standalone installs and installs them for ant users', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'omc-entitlement-installer-'));
        try {
            await withEntitlementFixture(async () => {
                const homeDir = join(tempRoot, 'home');
                const claudeConfigDir = join(homeDir, '.claude');
                mkdirSync(claudeConfigDir, { recursive: true });
                process.env.HOME = homeDir;
                process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
                process.env.USER_TYPE = '';
                const installer = await import('../installer/index.js');
                const result = installer.install({ skipClaudeCheck: true, skipHud: true, noPlugin: true });
                for (const skill of entitlementNames) {
                    expect(result.installedSkills).not.toContain(`${skill}/SKILL.md`);
                }
                process.env.USER_TYPE = 'ant';
                const antResult = installer.install({ skipClaudeCheck: true, skipHud: true, noPlugin: true });
                for (const skill of entitlementNames) {
                    expect(antResult.installedSkills).toContain(`${skill}/SKILL.md`);
                    expect(existsSync(join(claudeConfigDir, 'skills', skill, 'SKILL.md'))).toBe(true);
                }
            });
        }
        finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=skill-entitlements-cross-surface.test.js.map