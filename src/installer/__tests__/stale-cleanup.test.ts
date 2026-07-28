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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test the exported cleanup functions directly
import { cleanupStaleAgents, cleanupStaleSkills, prunePluginDuplicateSkills, prunePluginDuplicateAgents } from '../index.js';

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

function createManagedSkillMarker(dir: string, skillName: string): void {
  writeFileSync(join(dir, skillName, '.omc-managed'), 'omc-managed\n');
}

function historicalAgent(filename: string, fixturePath = filename): Buffer {
  return readFileSync(join(process.cwd(), 'src', 'installer', '__tests__', 'fixtures', 'historical-agents', fixturePath));
}

function sameLengthByteDivergence(content: Buffer): Buffer {
  const changed = Buffer.from(content);
  const bodyStart = content.indexOf(Buffer.from('\n\n'));
  const offset = bodyStart >= 0 && bodyStart + 2 < changed.length ? bodyStart + 2 : 0;
  changed[offset] ^= 1;
  return changed;
}

function createPluginRoot(dir: string, agentContents: Record<string, Buffer>): void {
  for (const relativePath of [
    'package.json',
    'dist/hooks/skill-bridge.cjs',
    'bridge/claude-md-coordinator.cjs',
    'bridge/cli.cjs',
    'hooks/hooks.json',
    'commands/omc-setup.md',
    'commands/test.md',
    'skills/test/SKILL.md',
  ]) {
    const filepath = join(dir, relativePath);
    mkdirSync(join(filepath, '..'), { recursive: true });
    writeFileSync(filepath, 'fixture\n');
  }
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'oh-my-claudecode',
    commands: 'commands',
    skills: ['skills/test'],
  }));
  mkdirSync(join(dir, 'agents'), { recursive: true });
  for (const [filename, content] of Object.entries(agentContents)) {
    writeFileSync(join(dir, 'agents', filename), content);
  }
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

  it.each(['build-fixer.md', 'deep-executor.md', 'quality-reviewer.md'])('removes exact release-authenticated stale agent bytes for %s', async filename => {
    vi.resetModules();
    const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, filename), historicalAgent(filename));

    expect(cleanup(log)).toEqual([filename]);
    expect(existsSync(join(agentsDir, filename))).toBe(false);
    expect(cleanup(log)).toEqual([]);
  });

  it('removes the v4.1.0 build-fixer bytes as stale history', async () => {
    vi.resetModules();
    const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'build-fixer.md'), historicalAgent('build-fixer.md', 'v4.1.0/build-fixer.md'));

    expect(cleanup(log)).toEqual(['build-fixer.md']);
    expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(false);
  });

  it('preserves an exact duplicate-only ledger row during stale cleanup', async () => {
    vi.resetModules();
    const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'architect.md'), historicalAgent('architect.md'));

    expect(cleanup(log)).toEqual([]);
    expect(existsSync(join(agentsDir, 'architect.md'))).toBe(true);
  });

  it('fails closed when the plugin registry is malformed or the explicit plugin root is missing', async () => {
    const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      vi.resetModules();
      const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'build-fixer.md'), historicalAgent('build-fixer.md'));

      process.env.CLAUDE_PLUGIN_ROOT = join(tempDir, 'missing-plugin-root');
      expect(cleanup(log)).toEqual([]);
      expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(true);

      delete process.env.CLAUDE_PLUGIN_ROOT;
      mkdirSync(join(tempDir, 'plugins'), { recursive: true });
      writeFileSync(join(tempDir, 'plugins', 'installed_plugins.json'), '{not json');
      expect(cleanup(log)).toEqual([]);
      expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(true);
    } finally {
      if (originalPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    }
  });

  it('uses a valid explicit OMC plugin root to preserve active historical basenames', async () => {
    const originalOmcRoot = process.env.OMC_PLUGIN_ROOT;
    const originalClaudeRoot = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const pluginRoot = join(tempDir, 'active-plugin-root');
      createPluginRoot(pluginRoot, { 'build-fixer.md': historicalAgent('build-fixer.md') });
      process.env.OMC_PLUGIN_ROOT = pluginRoot;
      delete process.env.CLAUDE_PLUGIN_ROOT;

      vi.resetModules();
      const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'build-fixer.md'), historicalAgent('build-fixer.md'));

      expect(cleanup(log)).toEqual([]);
      expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(true);
    } finally {
      if (originalOmcRoot === undefined) delete process.env.OMC_PLUGIN_ROOT;
      else process.env.OMC_PLUGIN_ROOT = originalOmcRoot;
      if (originalClaudeRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = originalClaudeRoot;
    }
  });

  it('preserves a current-package basename when the explicit plugin witness omits it', async () => {
    const originalOmcRoot = process.env.OMC_PLUGIN_ROOT;
    const originalClaudeRoot = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const pluginRoot = join(tempDir, 'partial-active-plugin-root');
      createPluginRoot(pluginRoot, { 'executor.md': Buffer.from('active executor\n') });
      process.env.OMC_PLUGIN_ROOT = pluginRoot;
      delete process.env.CLAUDE_PLUGIN_ROOT;

      vi.resetModules();
      const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'architect.md'), historicalAgent('architect.md', 'v4.5.0/architect.md'));

      expect(cleanup(log)).toEqual([]);
      expect(existsSync(join(agentsDir, 'architect.md'))).toBe(true);
    } finally {
      if (originalOmcRoot === undefined) delete process.env.OMC_PLUGIN_ROOT;
      else process.env.OMC_PLUGIN_ROOT = originalOmcRoot;
      if (originalClaudeRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = originalClaudeRoot;
    }
  });

  it('preserves both destructive-pass candidates when explicit OMC_PLUGIN_ROOT is missing', async () => {
    const originalOmcRoot = process.env.OMC_PLUGIN_ROOT;
    const originalClaudeRoot = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      process.env.OMC_PLUGIN_ROOT = join(tempDir, 'missing-plugin-root');
      delete process.env.CLAUDE_PLUGIN_ROOT;

      vi.resetModules();
      const { cleanupStaleAgents: cleanup, prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'build-fixer.md'), historicalAgent('build-fixer.md'));
      writeFileSync(join(agentsDir, 'architect.md'), historicalAgent('architect.md'));

      expect(cleanup(log)).toEqual([]);
      expect(prune(log)).toEqual([]);
      expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(true);
      expect(existsSync(join(agentsDir, 'architect.md'))).toBe(true);
    } finally {
      if (originalOmcRoot === undefined) delete process.env.OMC_PLUGIN_ROOT;
      else process.env.OMC_PLUGIN_ROOT = originalOmcRoot;
      if (originalClaudeRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = originalClaudeRoot;
    }
  });

  it('preserves when a structurally complete explicit root has a lookalike manifest name', async () => {
    const originalOmcRoot = process.env.OMC_PLUGIN_ROOT;
    const originalClaudeRoot = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const pluginRoot = join(tempDir, 'lookalike-plugin-root');
      createPluginRoot(pluginRoot, { 'architect.md': historicalAgent('architect.md') });
      writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
        name: 'oh-my-claudecode-lookalike', commands: 'commands', skills: ['skills/test'],
      }));
      process.env.OMC_PLUGIN_ROOT = pluginRoot;
      delete process.env.CLAUDE_PLUGIN_ROOT;

      vi.resetModules();
      const { prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'architect.md'), historicalAgent('architect.md'));

      expect(prune(log)).toEqual([]);
      expect(existsSync(join(agentsDir, 'architect.md'))).toBe(true);
    } finally {
      if (originalOmcRoot === undefined) delete process.env.OMC_PLUGIN_ROOT;
      else process.env.OMC_PLUGIN_ROOT = originalOmcRoot;
      if (originalClaudeRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = originalClaudeRoot;
    }
  });

  it('preserves when the installed registry has a structurally complete lookalike ID', async () => {
    const originalOmcRoot = process.env.OMC_PLUGIN_ROOT;
    const originalClaudeRoot = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const pluginRoot = join(tempDir, 'registry-lookalike-root');
      createPluginRoot(pluginRoot, { 'build-fixer.md': historicalAgent('build-fixer.md') });
      mkdirSync(join(tempDir, 'plugins'), { recursive: true });
      writeFileSync(join(tempDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
        plugins: { 'oh-my-claudecode-lookalike@omc': [{ installPath: pluginRoot }] },
      }));
      delete process.env.OMC_PLUGIN_ROOT;
      delete process.env.CLAUDE_PLUGIN_ROOT;

      vi.resetModules();
      const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'build-fixer.md'), historicalAgent('build-fixer.md'));

      expect(cleanup(log)).toEqual([]);
      expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(true);
    } finally {
      if (originalOmcRoot === undefined) delete process.env.OMC_PLUGIN_ROOT;
      else process.env.OMC_PLUGIN_ROOT = originalOmcRoot;
      if (originalClaudeRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = originalClaudeRoot;
    }
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

  it('preserves custom frontmatter and byte-divergent historical content', async () => {
    vi.resetModules();
    const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    createAgentFile(agentsDir, 'third-party.md', 'third-party');
    createAgentFile(agentsDir, 'build-fixer.md', 'build-fixer');
    writeFileSync(join(agentsDir, 'malformed.md'), Buffer.from([0xff, 0xfe, 0x00]));

    expect(cleanup(log)).toEqual([]);
    expect(existsSync(join(agentsDir, 'third-party.md'))).toBe(true);
    expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(true);
    expect(existsSync(join(agentsDir, 'malformed.md'))).toBe(true);

    writeFileSync(join(agentsDir, 'build-fixer.md'), sameLengthByteDivergence(historicalAgent('build-fixer.md')));
    expect(cleanup(log)).toEqual([]);
    expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(true);

    writeFileSync(join(agentsDir, 'build-fixer.md'), Buffer.concat([historicalAgent('build-fixer.md'), Buffer.from('\n')]));
    expect(cleanup(log)).toEqual([]);
    expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(true);
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

  it('preserves symlinks and non-regular entries with authenticated filenames', async () => {
    vi.resetModules();
    const { cleanupStaleAgents: cleanup, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    const target = join(tempDir, 'build-fixer.md');
    writeFileSync(target, historicalAgent('build-fixer.md'));
    symlinkSync(target, join(agentsDir, 'build-fixer.md'));
    mkdirSync(join(agentsDir, 'deep-executor.md'));

    expect(cleanup(log)).toEqual([]);
    expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(true);
    expect(existsSync(join(agentsDir, 'deep-executor.md'))).toBe(true);
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

  it('removes stale skills only when OMC ownership is explicitly marked', async () => {
    vi.resetModules();
    const { cleanupStaleSkills: cleanup, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    createSkillDir(skillsDir, 'removed-skill', 'removed-skill');
    createManagedSkillMarker(skillsDir, 'removed-skill');

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

  it('preserves third-party skills with standard frontmatter when no OMC marker is present', async () => {
    vi.resetModules();
    const { cleanupStaleSkills: cleanup, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });
    createSkillDir(skillsDir, 'gstack', 'gstack');

    const removed = cleanup(log);

    expect(removed).not.toContain('gstack');
    expect(existsSync(join(skillsDir, 'gstack'))).toBe(true);
  });

  it('preserves symlinked skill directories without an OMC marker', async () => {
    vi.resetModules();
    const { cleanupStaleSkills: cleanup, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    const externalRoot = mkdtempSync(join(tmpdir(), 'omc-third-party-skill-'));
    const externalSkillDir = join(externalRoot, 'linked-skill');
    mkdirSync(externalSkillDir, { recursive: true });
    writeFileSync(join(externalSkillDir, 'SKILL.md'), '---\nname: linked-skill\ndescription: external\n---\n\n# linked-skill\n');
    symlinkSync(externalSkillDir, join(skillsDir, 'linked-skill'), 'dir');

    try {
      const removed = cleanup(log);
      expect(removed).not.toContain('linked-skill');
      expect(existsSync(join(skillsDir, 'linked-skill'))).toBe(true);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
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

  it('removes standalone skills that match plugin-provided skills when marked as OMC-owned', async () => {
    vi.resetModules();
    const { prunePluginDuplicateSkills: prune, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    // Create a standalone copy of 'ralph' (which the plugin also provides)
    // and mark it as OMC-owned — this is what a prior `omc setup` would have done
    createSkillDir(skillsDir, 'ralph', 'ralph');
    createManagedSkillMarker(skillsDir, 'ralph');

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

  it('preserves user skills with standard frontmatter that have different content from plugin version (issue #2573)', async () => {
    // Regression: the old `isOmcCreated` heuristic treated any skill with
    // `---\nname:` frontmatter as OMC-owned and deleted it during update,
    // even when the content differed from the plugin's copy.
    vi.resetModules();
    const { prunePluginDuplicateSkills: prune, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    // User's custom version of 'ralph' — standard frontmatter, but unique body
    const customSkillDir = join(skillsDir, 'ralph');
    mkdirSync(customSkillDir, { recursive: true });
    writeFileSync(
      join(customSkillDir, 'SKILL.md'),
      '---\nname: ralph\ndescription: My custom ralph workflow\n---\n\n# My Custom Ralph\nThis is my personalized version.\n',
    );
    // No .omc-managed marker — this is user-owned

    const removed = prune(log);

    expect(removed).not.toContain('ralph');
    expect(existsSync(join(skillsDir, 'ralph'))).toBe(true);
  });

  it('removes exact-match standalone alias duplicates like omc-plan while preserving alias lookup behavior', async () => {
    vi.resetModules();
    const { prunePluginDuplicateSkills: prune, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    const packagePlanSkill = readFileSync(join(process.cwd(), 'skills', 'plan', 'SKILL.md'), 'utf-8');
    const aliasSkillDir = join(skillsDir, 'omc-plan');
    mkdirSync(aliasSkillDir, { recursive: true });
    writeFileSync(join(aliasSkillDir, 'SKILL.md'), packagePlanSkill);

    const removed = prune(log);

    expect(removed).toContain('omc-plan');
    expect(existsSync(aliasSkillDir)).toBe(false);
  });

  it('preserves user-authored standalone alias skills like omc-plan when content differs from plugin copy', async () => {
    vi.resetModules();
    const { prunePluginDuplicateSkills: prune, SKILLS_DIR: skillsDir } = await import('../index.js');

    mkdirSync(skillsDir, { recursive: true });

    const aliasSkillDir = join(skillsDir, 'omc-plan');
    mkdirSync(aliasSkillDir, { recursive: true });
    writeFileSync(
      join(aliasSkillDir, 'SKILL.md'),
      '---\nname: plan\ndescription: My custom alias skill\n---\n\n# Custom omc-plan\nUser-authored content.\n',
    );

    const removed = prune(log);

    expect(removed).not.toContain('omc-plan');
    expect(existsSync(aliasSkillDir)).toBe(true);
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
    createManagedSkillMarker(skillsDir, 'ralph');

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

  it('removes an exact release-authenticated standalone copy that duplicates an active agent', async () => {
    vi.resetModules();
    const { prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'architect.md'), historicalAgent('architect.md'));

    expect(prune(log)).toEqual(['architect.md']);
    expect(existsSync(join(agentsDir, 'architect.md'))).toBe(false);
    expect(prune(log)).toEqual([]);
  });

  it.each([
    ['analyst.md', 'v4.4.0/analyst.md'],
    ['architect.md', 'v4.5.0/architect.md'],
  ])('prunes current-name bytes from released history for %s', async (filename, fixturePath) => {
    vi.resetModules();
    const { prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, filename), historicalAgent(filename, fixturePath));

    expect(prune(log)).toEqual([filename]);
    expect(existsSync(join(agentsDir, filename))).toBe(false);
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


  it('fails closed when installed plugin agent witnesses disagree', async () => {
    const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const firstRoot = join(tempDir, 'plugin-one');
      const secondRoot = join(tempDir, 'plugin-two');
      createPluginRoot(firstRoot, { 'architect.md': Buffer.from('first active architect\n') });
      createPluginRoot(secondRoot, { 'architect.md': Buffer.from('second active architect\n') });
      mkdirSync(join(tempDir, 'plugins'), { recursive: true });
      writeFileSync(join(tempDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
        plugins: {
          'oh-my-claudecode': [{ installPath: firstRoot }, { installPath: secondRoot }],
        },
      }));

      vi.resetModules();
      const { prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'architect.md'), historicalAgent('architect.md'));

      delete process.env.CLAUDE_PLUGIN_ROOT;
      expect(prune(log)).toEqual([]);
      expect(existsSync(join(agentsDir, 'architect.md'))).toBe(true);
    } finally {
      if (originalPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    }
  });
  it('preserves current-name custom frontmatter and byte-divergent historical content', async () => {
    vi.resetModules();
    const { prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    createAgentFile(agentsDir, 'architect.md', 'architect');
    expect(prune(log)).toEqual([]);
    expect(existsSync(join(agentsDir, 'architect.md'))).toBe(true);

    writeFileSync(join(agentsDir, 'architect.md'), sameLengthByteDivergence(historicalAgent('architect.md')));
    expect(prune(log)).toEqual([]);
    expect(existsSync(join(agentsDir, 'architect.md'))).toBe(true);

    writeFileSync(join(agentsDir, 'architect.md'), Buffer.concat([historicalAgent('architect.md'), Buffer.from('\n')]));
    expect(prune(log)).toEqual([]);
    expect(existsSync(join(agentsDir, 'architect.md'))).toBe(true);
  });

  it('preserves exact stale-only ledger bytes during duplicate pruning', async () => {
    vi.resetModules();
    const { prunePluginDuplicateAgents: prune, AGENTS_DIR: agentsDir } = await import('../index.js');

    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'build-fixer.md'), historicalAgent('build-fixer.md'));

    expect(prune(log)).toEqual([]);
    expect(existsSync(join(agentsDir, 'build-fixer.md'))).toBe(true);
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
