/**
 * Stale OMC Agent/Skill Cleanup Tests
 *
 * Verifies that the installer removes stale OMC-created files from the config
 * directory while preserving user-created files.
 *
 * Contract: setup must clean up ~/.claude/agents and ~/.claude/skills that were
 * created by OMC in previous versions but are no longer shipped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test the exported cleanup functions directly
import { cleanupStaleAgents, cleanupStaleSkills } from '../index.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function createAgentFile(dir: string, filename: string, name: string): void {
  writeFileSync(join(dir, filename), `---\nname: ${name}\ndescription: Test agent\nmodel: claude-sonnet-4-6\n---\n\n# ${name}\nTest content.\n`);
}

function createSkillDir(dir: string, skillName: string, name: string): void {
  const skillDir = join(dir, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\nTest content.\n`);
}

function createUserFile(dir: string, filename: string): void {
  // User-created file without OMC frontmatter
  writeFileSync(join(dir, filename), `# My Custom Agent\n\nThis is a user-created agent definition.\n`);
}

function createUserSkillDir(dir: string, skillName: string): void {
  const skillDir = join(dir, skillName);
  mkdirSync(skillDir, { recursive: true });
  // No frontmatter — just user prose
  writeFileSync(join(skillDir, 'SKILL.md'), `# My Custom Skill\n\nThis is a user-created skill.\n`);
}

// ── Stale Agent Cleanup ──────────────────────────────────────────────────────

describe('cleanupStaleAgents', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;
  const log = vi.fn();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-stale-agents-'));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    log.mockClear();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes agent files that have OMC frontmatter but are no longer in the package', async () => {
    // Re-import with fresh CLAUDE_CONFIG_DIR
    vi.resetModules();
    const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });

    // Create a fake "stale" agent that looks like OMC-created but isn't in current package
    createAgentFile(agentsDir, 'removed-agent.md', 'removed-agent');

    const removed = cleanup(log);

    expect(removed).toContain('removed-agent.md');
    expect(existsSync(join(agentsDir, 'removed-agent.md'))).toBe(false);
  });

  it('preserves agent files that are in the current package', async () => {
    vi.resetModules();
    const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });

    // Create an agent that matches a real current agent name (architect)
    createAgentFile(agentsDir, 'architect.md', 'architect');

    const removed = cleanup(log);

    expect(removed).not.toContain('architect.md');
    expect(existsSync(join(agentsDir, 'architect.md'))).toBe(true);
  });

  it('preserves user-created files without OMC frontmatter', async () => {
    vi.resetModules();
    const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });

    // User-created file with no frontmatter
    createUserFile(agentsDir, 'my-custom-agent.md');

    const removed = cleanup(log);

    expect(removed).not.toContain('my-custom-agent.md');
    expect(existsSync(join(agentsDir, 'my-custom-agent.md'))).toBe(true);
  });

  it('preserves AGENTS.md even though it is not a current agent definition', async () => {
    vi.resetModules();
    const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'AGENTS.md'), '# Agent Catalog\nDocumentation file.\n');

    const removed = cleanup(log);

    expect(removed).not.toContain('AGENTS.md');
    expect(existsSync(join(agentsDir, 'AGENTS.md'))).toBe(true);
  });

  it('returns empty array when agents directory does not exist', () => {
    const removed = cleanupStaleAgents(log);
    // No agents dir at the temp path — should not error
    expect(removed).toEqual([]);
  });
});

// ── Stale Skill Cleanup ──────────────────────────────────────────────────────

describe('cleanupStaleSkills', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;
  const log = vi.fn();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-stale-skills-'));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    log.mockClear();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes skill directories that have OMC frontmatter but are no longer in the package', async () => {
    vi.resetModules();
    const { cleanupStaleSkills: cleanup, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    // Create a fake stale skill
    createSkillDir(skillsDir, 'removed-skill', 'removed-skill');

    const removed = cleanup(log);

    expect(removed).toContain('removed-skill');
    expect(existsSync(join(skillsDir, 'removed-skill'))).toBe(false);
  });

  it('preserves skill directories that are in the current package', async () => {
    vi.resetModules();
    const { cleanupStaleSkills: cleanup, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    // Create a skill that matches a real current skill name (ralph)
    createSkillDir(skillsDir, 'ralph', 'ralph');

    const removed = cleanup(log);

    expect(removed).not.toContain('ralph');
    expect(existsSync(join(skillsDir, 'ralph'))).toBe(true);
  });

  it('preserves user-created skill directories without OMC frontmatter', async () => {
    vi.resetModules();
    const { cleanupStaleSkills: cleanup, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    createUserSkillDir(skillsDir, 'my-custom-skill');

    const removed = cleanup(log);

    expect(removed).not.toContain('my-custom-skill');
    expect(existsSync(join(skillsDir, 'my-custom-skill'))).toBe(true);
  });

  it('preserves omc-learned directory (user-created skills)', async () => {
    vi.resetModules();
    const { cleanupStaleSkills: cleanup, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    // omc-learned is the user skills directory — must never be removed
    createSkillDir(skillsDir, 'omc-learned', 'omc-learned');

    const removed = cleanup(log);

    expect(removed).not.toContain('omc-learned');
    expect(existsSync(join(skillsDir, 'omc-learned'))).toBe(true);
  });

  it('returns empty array when skills directory does not exist', () => {
    const removed = cleanupStaleSkills(log);
    expect(removed).toEqual([]);
  });

  it('does not remove directories without SKILL.md', async () => {
    vi.resetModules();
    const { cleanupStaleSkills: cleanup, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    // Directory with no SKILL.md — not a skill, should be left alone
    const randomDir = join(skillsDir, 'random-directory');
    mkdirSync(randomDir, { recursive: true });
    writeFileSync(join(randomDir, 'notes.txt'), 'some notes');

    const removed = cleanup(log);

    expect(removed).not.toContain('random-directory');
    expect(existsSync(randomDir)).toBe(true);
  });
});
