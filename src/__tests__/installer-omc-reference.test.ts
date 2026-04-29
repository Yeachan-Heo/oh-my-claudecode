import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const { join: pathJoin } = await import('path');
  const repoRoot = process.cwd();
  const sourceSkillsDir = pathJoin(repoRoot, 'src', 'skills');
  const sourceClaudeMdPath = pathJoin(repoRoot, 'src', 'docs', 'CLAUDE.md');
  const realSkillsDir = pathJoin(repoRoot, 'skills');
  const realClaudeMdPath = pathJoin(repoRoot, 'docs', 'CLAUDE.md');

  const withRedirect = (pathLike: unknown): string => {
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
    existsSync: vi.fn((pathLike: Parameters<typeof actual.existsSync>[0]) =>
      actual.existsSync(withRedirect(pathLike))
    ),
    readFileSync: vi.fn((pathLike: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) =>
      actual.readFileSync(withRedirect(pathLike), options as never)
    ),
    readdirSync: vi.fn((pathLike: Parameters<typeof actual.readdirSync>[0], options?: Parameters<typeof actual.readdirSync>[1]) =>
      actual.readdirSync(withRedirect(pathLike), options as never)
    ),
  };
});

async function loadInstallerWithEnv(claudeConfigDir: string, homeDir: string) {
  vi.resetModules();
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  process.env.HOME = homeDir;
  return import('../installer/index.js');
}

function writeInstalledPluginRegistry(claudeConfigDir: string, pluginRoot: string): void {
  const pluginsDir = join(claudeConfigDir, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      'oh-my-claudecode': [
        { installPath: pluginRoot },
      ],
    }, null, 2)
  );
}

function writeEnabledPluginSettings(claudeConfigDir: string): void {
  writeFileSync(
    join(claudeConfigDir, 'settings.json'),
    JSON.stringify({ plugins: ['oh-my-claudecode'] }, null, 2)
  );
}

function getBundledSkillNames(): string[] {
  const skininthegamebrosOnlySkills = new Set(['remember', 'verify', 'debug']);

  return readdirSync(join(process.cwd(), 'skills'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => existsSync(join(process.cwd(), 'skills', name, 'SKILL.md')))
    .filter(name => !skininthegamebrosOnlySkills.has(name))
    .sort();
}

describe('installer bundled + standalone skill sync', () => {
  let tempRoot: string;
  let homeDir: string;
  let claudeConfigDir: string;
  let originalClaudeConfigDir: string | undefined;
  let originalHome: string | undefined;

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
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    rmSync(tempRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('installs standalone slash skills into ~/.claude/skills during legacy install', async () => {
    const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
    const result = installer.install({
      skipClaudeCheck: true,
      skipHud: true,
    });

    expect(result.success).toBe(true);
    expect(result.installedSkills).toEqual(expect.arrayContaining([
      'autopilot/SKILL.md',
      'ralph/SKILL.md',
      'ralplan/SKILL.md',
      'team/SKILL.md',
      'ultrawork/SKILL.md',
      'omc-reference/SKILL.md',
      'omc-plan/SKILL.md',
    ]));

    for (const skillName of ['autopilot', 'ralph', 'ralplan', 'team', 'ultrawork', 'omc-reference', 'omc-plan']) {
      const installedSkillPath = join(claudeConfigDir, 'skills', skillName, 'SKILL.md');
      expect(existsSync(installedSkillPath)).toBe(true);
      expect(readFileSync(installedSkillPath, 'utf-8')).toContain('name:');
    }

    expect(existsSync(join(claudeConfigDir, 'skills', 'plan', 'SKILL.md'))).toBe(false);
  });

  it('installs bundled skills when no enabled OMC plugin is configured', async () => {
    const pluginRoot = join(tempRoot, 'plugin-cache', 'oh-my-claudecode', '4.10.2');
    mkdirSync(join(pluginRoot, 'skills', 'ralph'), { recursive: true });
    writeFileSync(join(pluginRoot, 'skills', 'ralph', 'SKILL.md'), 'name: ralph\n');
    writeInstalledPluginRegistry(claudeConfigDir, pluginRoot);

    const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
    const result = installer.install({
      skipClaudeCheck: true,
      skipHud: true,
    });

    expect(result.success).toBe(true);
    const bundledSkillNames = getBundledSkillNames();
    expect(result.installedSkills.length).toBeGreaterThanOrEqual(bundledSkillNames.length - 4);
    expect(result.installedSkills).toContain('omc-reference/SKILL.md');
    expect(result.installedSkills).toContain('ralph/SKILL.md');
    expect(result.installedSkills).toContain('omc-plan/SKILL.md');

    for (const skillName of ['omc-reference', 'ralph', 'team']) {
      const installedSkillPath = join(claudeConfigDir, 'skills', skillName, 'SKILL.md');
      expect(existsSync(installedSkillPath)).toBe(true);
      expect(readFileSync(installedSkillPath, 'utf-8')).toContain(`name: ${skillName}`);
    }

    expect(existsSync(join(claudeConfigDir, 'skills', 'omc-setup', 'phases', '04-welcome.md'))).toBe(true);
  });

  it('skips bundled skill sync when an installed plugin already provides skills', async () => {
    const pluginRoot = join(tempRoot, 'plugin-cache', 'oh-my-claudecode', '4.10.2');
    mkdirSync(join(pluginRoot, 'skills', 'ralph'), { recursive: true });
    writeFileSync(join(pluginRoot, 'skills', 'ralph', 'SKILL.md'), 'name: ralph\n');
    writeInstalledPluginRegistry(claudeConfigDir, pluginRoot);
    writeEnabledPluginSettings(claudeConfigDir);

    const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
    const result = installer.install({
      skipClaudeCheck: true,
      skipHud: true,
    });

    expect(result.success).toBe(true);
    expect(result.installedSkills).toEqual([]);
    expect(existsSync(join(claudeConfigDir, 'skills', 'ralph', 'SKILL.md'))).toBe(false);
  });

  it('forces bundled skill sync with noPlugin even when plugin skills exist', async () => {
    const pluginRoot = join(tempRoot, 'plugin-cache', 'oh-my-claudecode', '4.10.2');
    mkdirSync(join(pluginRoot, 'skills', 'ralph'), { recursive: true });
    writeFileSync(join(pluginRoot, 'skills', 'ralph', 'SKILL.md'), 'name: ralph\n');
    writeInstalledPluginRegistry(claudeConfigDir, pluginRoot);
    writeEnabledPluginSettings(claudeConfigDir);

    const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
    const result = installer.install({
      skipClaudeCheck: true,
      skipHud: true,
      noPlugin: true,
    });

    expect(result.success).toBe(true);
    expect(result.installedSkills).toContain('ralph/SKILL.md');
    expect(existsSync(join(claudeConfigDir, 'skills', 'ralph', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(claudeConfigDir, 'skills', 'ralph', 'SKILL.md'), 'utf-8')).toContain('name: ralph');
  });

  it('falls back to bundled skills when plugin is enabled but skill files are unavailable', async () => {
    const pluginRoot = join(tempRoot, 'plugin-cache', 'oh-my-claudecode', '4.10.2');
    mkdirSync(pluginRoot, { recursive: true });
    writeInstalledPluginRegistry(claudeConfigDir, pluginRoot);
    writeEnabledPluginSettings(claudeConfigDir);

    const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
    const result = installer.install({
      skipClaudeCheck: true,
      skipHud: true,
    });

    expect(result.success).toBe(true);
    expect(result.installedSkills).toContain('ralph/SKILL.md');
    expect(existsSync(join(claudeConfigDir, 'skills', 'ralph', 'SKILL.md'))).toBe(true);
  });

  it('re-syncs bundled skills on repeated noPlugin installs so local skill edits can be validated', async () => {
    const installedSkillDir = join(claudeConfigDir, 'skills', 'ralph');
    mkdirSync(installedSkillDir, { recursive: true });
    writeFileSync(join(installedSkillDir, 'SKILL.md'), 'name: ralph\n\nstale content\n');

    const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
    const result = installer.install({
      skipClaudeCheck: true,
      skipHud: true,
      noPlugin: true,
    });

    expect(result.success).toBe(true);
    expect(result.installedSkills).toContain('ralph/SKILL.md');
    expect(readFileSync(join(installedSkillDir, 'SKILL.md'), 'utf-8')).not.toContain('stale content');
    expect(readFileSync(join(installedSkillDir, 'SKILL.md'), 'utf-8')).toContain('name: ralph');
  });
});
