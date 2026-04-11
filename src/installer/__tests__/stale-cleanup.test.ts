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
import { cleanupStaleAgents, cleanupStaleSkills, prunePluginDuplicateSkills, prunePluginDuplicateAgents } from '../index.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function createAgentFile(dir: string, filename: string, name: string): void {
  writeFileSync(join(dir, filename), `---\nsource: omc\nname: ${name}\ndescription: Test agent\nmodel: claude-sonnet-4-6\n---\n\n# ${name}\nTest content.\n`);
}

function createSkillDir(dir: string, skillName: string, name: string): void {
  const skillDir = join(dir, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nsource: omc\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\nTest content.\n`);
}

function createUserSkillDirWithFrontmatter(dir: string, skillName: string, name: string): void {
  const skillDir = join(dir, skillName);
  mkdirSync(skillDir, { recursive: true });
  // User-created skill WITH standard frontmatter but WITHOUT `source: omc`
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: User-created skill\n---\n\n# ${name}\nUser content.\n`);
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

  it('preserves user-created agent files that have frontmatter but no source: omc marker', async () => {
    vi.resetModules();
    const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });

    // User-created agent with standard frontmatter (name: field) but no `source: omc`
    writeFileSync(join(agentsDir, 'my-custom-agent.md'), `---\nname: my-custom-agent\ndescription: User-created agent\nmodel: claude-sonnet-4-6\n---\n\n# My Agent\nUser content.\n`);

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

  it('preserves user-created skill directories that have frontmatter but no source: omc marker', async () => {
    vi.resetModules();
    const { cleanupStaleSkills: cleanup, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    // User-created skill with standard frontmatter (name: field) but no `source: omc`
    createUserSkillDirWithFrontmatter(skillsDir, 'my-gstack-skill', 'my-gstack-skill');

    const removed = cleanup(log);

    expect(removed).not.toContain('my-gstack-skill');
    expect(existsSync(join(skillsDir, 'my-gstack-skill'))).toBe(true);
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

// ── Plugin Duplicate Skill Pruning (#2252) ──────────────────────────────────

describe('prunePluginDuplicateSkills', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;
  const log = vi.fn();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-prune-dupes-'));
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

  it('removes standalone skills that match plugin-provided skills', async () => {
    vi.resetModules();
    const { prunePluginDuplicateSkills: prune, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    // Create a standalone copy of 'ralph' (which the plugin also provides)
    createSkillDir(skillsDir, 'ralph', 'ralph');

    const removed = prune(log);

    expect(removed).toContain('ralph');
    expect(existsSync(join(skillsDir, 'ralph'))).toBe(false);
  });

  it('preserves user-authored skills without OMC frontmatter even if name matches', async () => {
    vi.resetModules();
    const { prunePluginDuplicateSkills: prune, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    // User-created skill with a name that collides with plugin skill but no OMC frontmatter
    createUserSkillDir(skillsDir, 'ralph');

    const removed = prune(log);

    expect(removed).not.toContain('ralph');
    expect(existsSync(join(skillsDir, 'ralph'))).toBe(true);
  });

  it('preserves omc-learned directory', async () => {
    vi.resetModules();
    const { prunePluginDuplicateSkills: prune, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });
    createSkillDir(skillsDir, 'omc-learned', 'omc-learned');

    const removed = prune(log);

    expect(removed).not.toContain('omc-learned');
    expect(existsSync(join(skillsDir, 'omc-learned'))).toBe(true);
  });

  it('does not remove skills whose name does not match any plugin skill', async () => {
    vi.resetModules();
    const { prunePluginDuplicateSkills: prune, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });
    createSkillDir(skillsDir, 'my-private-skill', 'my-private-skill');

    const removed = prune(log);

    expect(removed).not.toContain('my-private-skill');
    expect(existsSync(join(skillsDir, 'my-private-skill'))).toBe(true);
  });

  it('returns empty when skills directory does not exist', () => {
    const removed = prunePluginDuplicateSkills(log);
    expect(removed).toEqual([]);
  });

  it('is idempotent — second run is a no-op', async () => {
    vi.resetModules();
    const { prunePluginDuplicateSkills: prune, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });
    createSkillDir(skillsDir, 'ralph', 'ralph');

    const first = prune(log);
    expect(first).toContain('ralph');

    const second = prune(log);
    expect(second).toEqual([]);
  });
});

// ── Plugin Duplicate Agent Pruning (#2252) ──────────────────────────────────

describe('prunePluginDuplicateAgents', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;
  const log = vi.fn();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-prune-agent-dupes-'));
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

  it('removes standalone agents that match plugin-provided agents', async () => {
    vi.resetModules();
    const { prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    createAgentFile(agentsDir, 'architect.md', 'architect');

    const removed = prune(log);

    expect(removed).toContain('architect.md');
    expect(existsSync(join(agentsDir, 'architect.md'))).toBe(false);
  });

  it('preserves user-created agents without OMC frontmatter', async () => {
    vi.resetModules();
    const { prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    createUserFile(agentsDir, 'architect.md');

    const removed = prune(log);

    expect(removed).not.toContain('architect.md');
    expect(existsSync(join(agentsDir, 'architect.md'))).toBe(true);
  });

  it('does not remove agents not in the current package', async () => {
    vi.resetModules();
    const { prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    createAgentFile(agentsDir, 'my-custom-agent.md', 'my-custom-agent');

    const removed = prune(log);

    expect(removed).not.toContain('my-custom-agent.md');
    expect(existsSync(join(agentsDir, 'my-custom-agent.md'))).toBe(true);
  });

  it('preserves user-created agents with frontmatter but no source: omc even if name matches plugin', async () => {
    vi.resetModules();
    const { prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });

    // User-created agent whose name matches a plugin agent but lacks source: omc
    writeFileSync(join(agentsDir, 'architect.md'), `---\nname: architect\ndescription: My custom architect\nmodel: claude-opus-4-6\n---\n\nCustom content.\n`);

    const removed = prune(log);

    expect(removed).not.toContain('architect.md');
    expect(existsSync(join(agentsDir, 'architect.md'))).toBe(true);
  });

  it('preserves AGENTS.md documentation file', async () => {
    vi.resetModules();
    const { prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'AGENTS.md'), '# Agent Catalog\nDocumentation.\n');

    const removed = prune(log);

    expect(removed).not.toContain('AGENTS.md');
    expect(existsSync(join(agentsDir, 'AGENTS.md'))).toBe(true);
  });

  it('returns empty when agents directory does not exist', () => {
    const removed = prunePluginDuplicateAgents(log);
    expect(removed).toEqual([]);
  });
});

// ── source: omc Stamping ────────────────────────────────────────────────────

describe('source: omc stamping', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;
  const log = vi.fn();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-stamp-'));
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

  it('install() stamps agents with source: omc when installing legacy agents', async () => {
    vi.resetModules();
    const { install, AGENTS_DIR: agentsDir } = await import('../index.js');

    // Run install with force to ensure agents are written
    install({ force: true, verbose: false, skipClaudeCheck: true, noPlugin: true });

    // Check that at least one installed agent has source: omc
    if (existsSync(agentsDir)) {
      const agents = readdirSync(agentsDir).filter(f => f.endsWith('.md') && f !== 'AGENTS.md');
      if (agents.length > 0) {
        const content = readFileSync(join(agentsDir, agents[0]), 'utf-8');
        expect(content).toContain('source: omc');
      }
    }
  });

  it('install() stamps skills with source: omc when syncing bundled skills', async () => {
    vi.resetModules();
    const { install, SKILLS_DIR: skillsDir } = await import('../index.js');

    // Run install with noPlugin to force bundled skill sync
    install({ force: true, verbose: false, skipClaudeCheck: true, noPlugin: true });

    // Check that at least one installed skill has source: omc
    if (existsSync(skillsDir)) {
      const skills = readdirSync(skillsDir).filter(d => {
        const skillMd = join(skillsDir, d, 'SKILL.md');
        return existsSync(skillMd);
      });
      if (skills.length > 0) {
        const content = readFileSync(join(skillsDir, skills[0], 'SKILL.md'), 'utf-8');
        expect(content).toContain('source: omc');
      }
    }
  });

  it('stamped skills are correctly removed by cleanupStaleSkills when no longer in package', async () => {
    vi.resetModules();
    const { cleanupStaleSkills: cleanup, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    // Create a skill with source: omc marker (simulating a previously installed OMC skill)
    const skillDir = join(skillsDir, 'old-omc-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nsource: omc\nname: old-omc-skill\ndescription: Was in previous OMC version\n---\n\nOld content.\n`);

    const removed = cleanup(log);

    expect(removed).toContain('old-omc-skill');
    expect(existsSync(skillDir)).toBe(false);
  });

  it('non-stamped skills survive cleanup even with identical structure', async () => {
    vi.resetModules();
    const { cleanupStaleSkills: cleanup, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    // Create a skill that looks like OMC but has no source: omc marker
    const skillDir = join(skillsDir, 'third-party-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: third-party-skill\ndescription: Installed by gstack or user\nlevel: 2\n---\n\nContent.\n`);

    const removed = cleanup(log);

    expect(removed).not.toContain('third-party-skill');
    expect(existsSync(skillDir)).toBe(true);
  });
});
