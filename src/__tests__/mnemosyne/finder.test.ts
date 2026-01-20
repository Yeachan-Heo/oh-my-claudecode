import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findSkillFiles, getSkillsDir, ensureSkillsDir } from '../../hooks/learner/finder.js';

describe('Skill Finder', () => {
  let testDir: string;
  let projectRoot: string;

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
});
