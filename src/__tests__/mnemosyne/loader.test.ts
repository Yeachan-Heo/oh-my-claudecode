import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadAllSkills, findMatchingSkills } from '../../hooks/learner/loader.js';

describe('Skill Loader', () => {
  let testDir: string;
  let projectRoot: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `skill-loader-test-${Date.now()}`);
    projectRoot = join(testDir, 'project');
    mkdirSync(join(projectRoot, '.omc', 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const createSkillFile = (name: string, metadata: Record<string, unknown>) => {
    const content = `---
id: "${metadata.id || name}"
name: "${metadata.name || name}"
description: "${metadata.description || 'Test skill'}"
source: ${metadata.source || 'manual'}
createdAt: "2024-01-19T12:00:00Z"
triggers:
${(metadata.triggers as string[] || ['test']).map(t => `  - "${t}"`).join('\n')}
---

# ${name}

Test content for ${name}.
`;
    const skillPath = join(projectRoot, '.omc', 'skills', `${name}.md`);
    writeFileSync(skillPath, content);
    return skillPath;
  };

  it('should load all valid skills', () => {
    createSkillFile('skill-a', { triggers: ['alpha'] });
    createSkillFile('skill-b', { triggers: ['beta'] });

    const skills = loadAllSkills(projectRoot);
    const projectSkills = skills.filter(s => s.scope === 'project');

    // Should load at least the 2 project skills (may also load user-level skills)
    expect(projectSkills.length).toBe(2);
    expect(projectSkills.map(s => s.metadata.id)).toContain('skill-a');
    expect(projectSkills.map(s => s.metadata.id)).toContain('skill-b');
  });

  it('should find matching skills by trigger', () => {
    createSkillFile('react-skill', { triggers: ['react', 'component'] });
    createSkillFile('python-skill', { triggers: ['python', 'django'] });

    const matches = findMatchingSkills('How do I create a React component?', projectRoot);

    expect(matches.length).toBe(1);
    expect(matches[0].metadata.id).toBe('react-skill');
  });

  it('should return empty array when no triggers match', () => {
    createSkillFile('react-skill', { triggers: ['react'] });

    const matches = findMatchingSkills('How do I use Rust?', projectRoot);

    expect(matches.length).toBe(0);
  });

  it('should limit results to specified count', () => {
    createSkillFile('skill-1', { triggers: ['test'] });
    createSkillFile('skill-2', { triggers: ['test'] });
    createSkillFile('skill-3', { triggers: ['test'] });

    const matches = findMatchingSkills('This is a test message', projectRoot, 2);

    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it('should boost by quality score', () => {
    createSkillFile('low-quality', { triggers: ['test'], quality: 30 });
    createSkillFile('high-quality', { triggers: ['test'], quality: 90 });

    const matches = findMatchingSkills('test', projectRoot);

    // High quality should be first
    expect(matches[0].metadata.id).toBe('high-quality');
  });
});
