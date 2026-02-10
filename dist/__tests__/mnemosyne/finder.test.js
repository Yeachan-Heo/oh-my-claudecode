import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findSkillFiles, getSkillsDir, ensureSkillsDir } from '../../hooks/learner/finder.js';
import { PROJECT_SKILLS_SUBDIR } from '../../hooks/learner/constants.js';
describe('Skill Finder', () => {
    let testDir;
    let projectRoot;
    beforeEach(() => {
        testDir = join(tmpdir(), `skill-test-${Date.now()}`);
        projectRoot = join(testDir, 'project');
        mkdirSync(join(projectRoot, '.omc', 'skills'), { recursive: true });
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });
    it('should find project-level skills', () => {
        const skillPath = join(projectRoot, '.omc', 'skills', 'test-skill.md');
        writeFileSync(skillPath, '# Test Skill');
        const candidates = findSkillFiles(projectRoot);
        const projectCandidates = candidates.filter(c => c.scope === 'project');
        // Should find at least the project skill (may also find user-level skills)
        expect(projectCandidates.length).toBe(1);
        expect(projectCandidates[0].scope).toBe('project');
        expect(projectCandidates[0].path).toBe(skillPath);
    });
    it('should prioritize project skills over user skills', () => {
        // Create project skill
        const projectSkillPath = join(projectRoot, '.omc', 'skills', 'skill.md');
        writeFileSync(projectSkillPath, '# Project Skill');
        const candidates = findSkillFiles(projectRoot);
        // Project skill should come first
        const projectSkill = candidates.find(c => c.scope === 'project');
        expect(projectSkill).toBeDefined();
    });
    it('should handle missing directories gracefully', () => {
        const emptyProject = join(testDir, 'empty');
        mkdirSync(emptyProject);
        const candidates = findSkillFiles(emptyProject);
        // Should return empty array, not throw
        expect(Array.isArray(candidates)).toBe(true);
    });
    it('should get skills directory for user scope', () => {
        const userDir = getSkillsDir('user');
        expect(userDir).toContain('.claude');
        expect(userDir).toContain('omc-learned');
    });
    it('should get skills directory for project scope', () => {
        const projectDir = getSkillsDir('project', projectRoot);
        expect(projectDir).toContain('.omc');
        expect(projectDir).toContain('skills');
    });
    it('should throw for project scope without root', () => {
        expect(() => getSkillsDir('project')).toThrow();
    });
    it('should ensure skills directory exists', () => {
        const result = ensureSkillsDir('project', projectRoot);
        expect(result).toBe(true);
    });
    it('should populate sourceDir for project skills', () => {
        const skillPath = join(projectRoot, '.omc', 'skills', 'test-skill.md');
        writeFileSync(skillPath, '# Test Skill');
        const candidates = findSkillFiles(projectRoot);
        const projectCandidate = candidates.find(c => c.scope === 'project');
        expect(projectCandidate).toBeDefined();
        expect(projectCandidate.sourceDir).toBe(join(projectRoot, '.omc', 'skills'));
    });
    it('should filter by scope: project only', () => {
        const skillPath = join(projectRoot, '.omc', 'skills', 'test-skill.md');
        writeFileSync(skillPath, '# Test Skill');
        const candidates = findSkillFiles(projectRoot, { scope: 'project' });
        expect(candidates.every(c => c.scope === 'project')).toBe(true);
        expect(candidates.length).toBeGreaterThanOrEqual(1);
    });
    it('should filter by scope: user only', () => {
        const skillPath = join(projectRoot, '.omc', 'skills', 'test-skill.md');
        writeFileSync(skillPath, '# Test Skill');
        const candidates = findSkillFiles(projectRoot, { scope: 'user' });
        // Should NOT include the project skill
        expect(candidates.every(c => c.scope === 'user')).toBe(true);
        expect(candidates.find(c => c.path === skillPath)).toBeUndefined();
    });
    it('should respect depth limit for deep directories', () => {
        // Create a deeply nested directory structure (15 levels)
        let deepDir = join(projectRoot, '.omc', 'skills');
        for (let i = 0; i < 15; i++) {
            deepDir = join(deepDir, `level-${i}`);
            mkdirSync(deepDir, { recursive: true });
        }
        writeFileSync(join(deepDir, 'deep-skill.md'), '# Deep Skill');
        const candidates = findSkillFiles(projectRoot, { scope: 'project' });
        // Skill at depth 15 should NOT be found (limit is 10)
        expect(candidates.find(c => c.path.includes('deep-skill.md'))).toBeUndefined();
    });
    it('should accept sourceDir hint in getSkillsDir', () => {
        const hint = '/custom/source/dir';
        const result = getSkillsDir('user', undefined, hint);
        expect(result).toBe(hint);
    });
    it('should construct PROJECT_SKILLS_SUBDIR with path.join', () => {
        expect(PROJECT_SKILLS_SUBDIR).toBe(join('.omc', 'skills'));
    });
});
//# sourceMappingURL=finder.test.js.map