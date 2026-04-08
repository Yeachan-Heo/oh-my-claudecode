import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOrphanStandaloneSkills } from '../plugin-cache-heal.js';
describe('plugin-cache-heal', () => {
    let workDir;
    let pluginRoot;
    let skillsDir;
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'omc-heal-'));
        pluginRoot = join(workDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.11.1');
        mkdirSync(join(pluginRoot, 'skills'), { recursive: true });
        skillsDir = join(workDir, 'skills');
        mkdirSync(skillsDir, { recursive: true });
    });
    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true });
    });
    describe('pruneOrphanStandaloneSkills', () => {
        function seedPluginSkill(name, content) {
            mkdirSync(join(pluginRoot, 'skills', name), { recursive: true });
            writeFileSync(join(pluginRoot, 'skills', name, 'SKILL.md'), content);
        }
        function seedStandaloneSkill(name, content) {
            mkdirSync(join(skillsDir, name), { recursive: true });
            writeFileSync(join(skillsDir, name, 'SKILL.md'), content);
        }
        it('removes standalone skills whose SKILL.md content matches the plugin', () => {
            // Plugin provides ralph + team with specific content
            const ralphContent = '---\nname: ralph\n---\nbody';
            const teamContent = '---\nname: team\n---\nbody';
            seedPluginSkill('ralph', ralphContent);
            seedPluginSkill('team', teamContent);
            // Standalone copies match the plugin content (the orphan case)
            seedStandaloneSkill('ralph', ralphContent);
            seedStandaloneSkill('team', teamContent);
            // user-custom does not collide with any plugin skill
            seedStandaloneSkill('user-custom', '---\nname: user-custom\n---\n');
            const logs = [];
            const result = pruneOrphanStandaloneSkills({
                skillsDir,
                pluginRoots: [pluginRoot],
                log: msg => logs.push(msg),
            });
            expect(result.removed.sort()).toEqual(['ralph', 'team']);
            expect(result.preserved).toContain('user-custom');
            expect(existsSync(join(skillsDir, 'ralph'))).toBe(false);
            expect(existsSync(join(skillsDir, 'team'))).toBe(false);
            expect(existsSync(join(skillsDir, 'user-custom'))).toBe(true);
            expect(logs.some(line => line.includes('Removed orphan standalone skill ralph'))).toBe(true);
            // Backup directory was created
            expect(existsSync(join(skillsDir, '.omc-trash'))).toBe(true);
            const trashEntries = readdirSync(join(skillsDir, '.omc-trash'));
            expect(trashEntries.some(e => e.startsWith('ralph.'))).toBe(true);
            expect(trashEntries.some(e => e.startsWith('team.'))).toBe(true);
        });
        it('preserves a user-authored skill whose name collides with a plugin skill (different content)', () => {
            // Plugin ships skills/plan/SKILL.md with a specific body. User has
            // hand-written ~/.claude/skills/plan/SKILL.md with completely
            // different content. We must NOT delete the user copy.
            seedPluginSkill('plan', '---\nname: omc-plan\n---\nplugin body');
            const userContent = '---\nname: my-personal-plan\n---\nmy custom workflow';
            seedStandaloneSkill('plan', userContent);
            const result = pruneOrphanStandaloneSkills({
                skillsDir,
                pluginRoots: [pluginRoot],
            });
            expect(result.removed).toEqual([]);
            expect(result.preserved).toContain('plan');
            expect(existsSync(join(skillsDir, 'plan', 'SKILL.md'))).toBe(true);
            expect(readFileSync(join(skillsDir, 'plan', 'SKILL.md'), 'utf-8')).toBe(userContent);
        });
        it('matches against ANY installed plugin version (multi-version cache)', () => {
            // 4.11.0 ships ralph with content A; 4.11.1 ships ralph with content B.
            // The standalone copy can match either.
            const olderRoot = join(workDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.11.0');
            mkdirSync(join(olderRoot, 'skills', 'ralph'), { recursive: true });
            writeFileSync(join(olderRoot, 'skills', 'ralph', 'SKILL.md'), 'older ralph body');
            seedPluginSkill('ralph', 'newer ralph body');
            // Standalone matches the older version
            seedStandaloneSkill('ralph', 'older ralph body');
            const result = pruneOrphanStandaloneSkills({
                skillsDir,
                pluginRoots: [olderRoot, pluginRoot],
            });
            expect(result.removed).toEqual(['ralph']);
            expect(existsSync(join(skillsDir, 'ralph'))).toBe(false);
        });
        it('never removes a skill whose name is not in the plugin set', () => {
            seedPluginSkill('ralph', 'plugin ralph');
            seedStandaloneSkill('private-skill', 'user-authored');
            const result = pruneOrphanStandaloneSkills({
                skillsDir,
                pluginRoots: [pluginRoot],
            });
            expect(result.removed).toEqual([]);
            expect(existsSync(join(skillsDir, 'private-skill'))).toBe(true);
        });
        it('does not remove a directory that lacks SKILL.md (defensive)', () => {
            seedPluginSkill('ralph', 'plugin ralph');
            // Standalone directory named "ralph" but with no SKILL.md inside
            mkdirSync(join(skillsDir, 'ralph'), { recursive: true });
            writeFileSync(join(skillsDir, 'ralph', 'random.txt'), 'not a skill');
            const result = pruneOrphanStandaloneSkills({
                skillsDir,
                pluginRoots: [pluginRoot],
            });
            expect(result.removed).toEqual([]);
            expect(existsSync(join(skillsDir, 'ralph', 'random.txt'))).toBe(true);
        });
        it('never recursively prunes its own .omc-trash directory', () => {
            seedPluginSkill('ralph', 'plugin ralph');
            seedStandaloneSkill('ralph', 'plugin ralph');
            // Pre-create a trash entry that happens to share the name "ralph"
            mkdirSync(join(skillsDir, '.omc-trash', 'ralph.preexisting'), { recursive: true });
            const result = pruneOrphanStandaloneSkills({
                skillsDir,
                pluginRoots: [pluginRoot],
            });
            expect(result.removed).toEqual(['ralph']);
            expect(result.preserved).toContain('.omc-trash');
            expect(existsSync(join(skillsDir, '.omc-trash', 'ralph.preexisting'))).toBe(true);
        });
        it('is idempotent — second run is a no-op', () => {
            const ralphContent = 'plugin ralph';
            seedPluginSkill('ralph', ralphContent);
            seedStandaloneSkill('ralph', ralphContent);
            const first = pruneOrphanStandaloneSkills({
                skillsDir,
                pluginRoots: [pluginRoot],
            });
            expect(first.removed).toEqual(['ralph']);
            const second = pruneOrphanStandaloneSkills({
                skillsDir,
                pluginRoots: [pluginRoot],
            });
            expect(second.removed).toEqual([]);
        });
        it('returns empty result when skillsDir does not exist', () => {
            const result = pruneOrphanStandaloneSkills({
                skillsDir: join(workDir, 'no-skills-here'),
                pluginRoots: [pluginRoot],
            });
            expect(result.removed).toEqual([]);
            expect(result.preserved).toEqual([]);
        });
        it('returns empty result when no plugin roots are provided', () => {
            seedStandaloneSkill('ralph', 'standalone');
            const result = pruneOrphanStandaloneSkills({
                skillsDir,
                pluginRoots: [],
            });
            expect(result.removed).toEqual([]);
            expect(existsSync(join(skillsDir, 'ralph'))).toBe(true);
        });
    });
});
//# sourceMappingURL=plugin-cache-heal.test.js.map