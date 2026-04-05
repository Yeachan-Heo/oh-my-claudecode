import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const { join: pathJoin } = await import('path');
  const repoRoot = process.cwd();
  const sourceAgentsDir = pathJoin(repoRoot, 'src', 'agents');
  const sourceClaudeMdPath = pathJoin(repoRoot, 'src', 'docs', 'CLAUDE.md');
  const realAgentsDir = pathJoin(repoRoot, 'agents');
  const realClaudeMdPath = pathJoin(repoRoot, 'docs', 'CLAUDE.md');

  const withRedirect = (pathLike: unknown): string => {
    const normalized = String(pathLike).replace(/\\/g, '/');
    const normalizedSourceAgentsDir = sourceAgentsDir.replace(/\\/g, '/');
    const normalizedRealAgentsDir = realAgentsDir.replace(/\\/g, '/');

    if (normalized === normalizedSourceAgentsDir) {
      return realAgentsDir;
    }
    if (normalized.startsWith(`${normalizedSourceAgentsDir}/`)) {
      return normalized.replace(normalizedSourceAgentsDir, normalizedRealAgentsDir);
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

describe('installer legacy agent sync gating (issue #1502)', () => {
  let tempRoot: string;
  let homeDir: string;
  let claudeConfigDir: string;
  let originalClaudeConfigDir: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'omc-installer-plugin-agents-'));
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

  it('skips recreating ~/.claude/agents when installed plugin agent files already exist', async () => {
    const pluginInstallPath = join(
      claudeConfigDir,
      'plugins',
      'cache',
      'omc',
      'oh-my-claudecode',
      '9.9.9'
    );
    const pluginAgentsDir = join(pluginInstallPath, 'agents');
    mkdirSync(pluginAgentsDir, { recursive: true });
    writeFileSync(join(pluginAgentsDir, 'executor.md'), '---\nname: executor\ndescription: test\n---\n');

    const installedPluginsPath = join(claudeConfigDir, 'plugins', 'installed_plugins.json');
    mkdirSync(join(claudeConfigDir, 'plugins'), { recursive: true });
    writeFileSync(installedPluginsPath, JSON.stringify({
      plugins: {
        'oh-my-claudecode@omc': [
          { installPath: pluginInstallPath }
        ]
      }
    }, null, 2));

    const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
    const result = installer.install({
      skipClaudeCheck: true,
      skipHud: true,
    });

    expect(result.success).toBe(true);
    expect(result.installedAgents).toEqual([]);
    expect(installer.hasPluginProvidedAgentFiles()).toBe(true);
    expect(existsSync(join(claudeConfigDir, 'agents'))).toBe(false);
    expect(installer.isInstalled()).toBe(true);
  });

  it('still installs legacy agent files when no plugin-provided agent files are available', async () => {
    const installer = await loadInstallerWithEnv(claudeConfigDir, homeDir);
    const result = installer.install({
      skipClaudeCheck: true,
      skipHud: true,
    });

    expect(result.success).toBe(true);
    expect(result.installedAgents.length).toBeGreaterThan(0);
    expect(existsSync(join(claudeConfigDir, 'agents'))).toBe(true);
    expect(readdirSync(join(claudeConfigDir, 'agents')).some(file => file.endsWith('.md'))).toBe(true);
    expect(existsSync(join(claudeConfigDir, 'hooks', 'lib', 'stdin.mjs'))).toBe(true);
    expect(existsSync(join(claudeConfigDir, 'hooks', 'lib', 'atomic-write.mjs'))).toBe(true);
    expect(installer.hasPluginProvidedAgentFiles()).toBe(false);
    expect(installer.isInstalled()).toBe(true);
  });
});
