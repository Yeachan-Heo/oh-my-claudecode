import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const ORIG_ENV = { ...process.env };

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writePayloadTree(root: string, version = '9.9.9-test'): void {
  mkdirSync(root, { recursive: true });
  writeFile(join(root, 'dist', 'lib', 'worktree-paths.js'), 'export const test = true;\n');
  writeFile(join(root, 'bridge', 'cli.cjs'), 'console.log("bridge");\n');
  writeFile(join(root, 'hooks', 'hooks.json'), '{}\n');
  writeFile(join(root, 'scripts', 'run.cjs'), 'console.log("run");\n');
  writeFile(join(root, 'skills', 'plan', 'SKILL.md'), '# plan\n');
  writeFile(join(root, 'agents', 'executor.md'), '# executor\n');
  writeFile(join(root, 'commands', 'omc-setup.md'), 'Read skills/omc-setup/SKILL.md and pass $ARGUMENTS.\n');
  writeFile(join(root, 'templates', 'deliverables.json'), '{}\n');
  writeFile(join(root, 'docs', 'CLAUDE.md'), '# docs\n');
  writeFile(join(root, '.claude-plugin', 'plugin.json'), '{"name":"oh-my-claudecode"}\n');
  writeFile(join(root, '.mcp.json'), '{}\n');
  writeFile(join(root, 'README.md'), '# readme\n');
  writeFile(join(root, 'LICENSE'), 'MIT\n');
  writeFile(join(root, 'package.json'), JSON.stringify({ name: 'oh-my-claude-sisyphus', version }, null, 2));
}

async function freshInstaller() {
  vi.resetModules();
  return await import('../index.js');
}

describe('syncInstalledPluginPayload', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'omc-plugin-cache-sync-'));
    process.env.CLAUDE_CONFIG_DIR = join(tempRoot, '.claude');
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.OMC_PLUGIN_ROOT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIG_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIG_ENV);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('repairs incomplete cache installs from the known marketplace source instead of reusing the installed root', async () => {
    const configDir = process.env.CLAUDE_CONFIG_DIR as string;
    const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.12.0');
    const sourceRoot = join(tempRoot, 'marketplace-source');

    writePayloadTree(sourceRoot);
    mkdirSync(join(cacheRoot, 'agents'), { recursive: true });
    writeFileSync(join(cacheRoot, 'agents', 'executor.md'), '# stale executor\n');
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'oh-my-claudecode@omc': [{ installPath: cacheRoot, version: '4.12.0' }],
        },
      }, null, 2),
    );
    writeFileSync(
      join(configDir, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        omc: {
          installLocation: sourceRoot,
          source: { source: 'directory', path: sourceRoot },
        },
      }, null, 2),
    );

    const installer = await freshInstaller();
    const result = installer.syncInstalledPluginPayload();

    expect(result.synced).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.sourceRoot).toBe(sourceRoot);
    expect(result.targetRoots).toEqual([cacheRoot]);
    expect(existsSync(join(cacheRoot, 'package.json'))).toBe(true);
    expect(existsSync(join(cacheRoot, 'skills', 'plan', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(cacheRoot, 'hooks', 'hooks.json'))).toBe(true);
    expect(existsSync(join(cacheRoot, 'scripts', 'run.cjs'))).toBe(true);
    expect(existsSync(join(cacheRoot, 'commands', 'omc-setup.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(cacheRoot, 'package.json'), 'utf-8')).version).toBe('9.9.9-test');
  });

  it('repairs incomplete cache installs during setup before plugin-provided file detection runs', async () => {
    const configDir = process.env.CLAUDE_CONFIG_DIR as string;
    const cacheRoot = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.12.0');
    const sourceRoot = join(tempRoot, 'marketplace-source-install');

    writePayloadTree(sourceRoot, '4.12.0');
    mkdirSync(join(cacheRoot, 'agents'), { recursive: true });
    writeFileSync(join(cacheRoot, 'agents', 'executor.md'), '# stale executor\n');
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'oh-my-claudecode@omc': [{ installPath: cacheRoot, version: '4.12.0' }],
        },
      }, null, 2),
    );
    writeFileSync(
      join(configDir, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        omc: {
          installLocation: sourceRoot,
          source: { source: 'directory', path: sourceRoot },
        },
      }, null, 2),
    );
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: ['oh-my-claudecode@omc'] }, null, 2),
    );

    const installer = await freshInstaller();
    const result = installer.install({
      skipClaudeCheck: true,
      skipHud: true,
    });

    expect(result.success).toBe(true);
    expect(result.installedAgents).toEqual([]);
    expect(result.installedSkills).toEqual([]);
    expect(installer.hasPluginProvidedAgentFiles()).toBe(true);
    expect(installer.hasPluginProvidedSkillFiles()).toBe(true);
    expect(installer.hasPluginProvidedHookFiles()).toBe(true);
    expect(existsSync(join(cacheRoot, 'package.json'))).toBe(true);
    expect(existsSync(join(cacheRoot, 'skills', 'plan', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(cacheRoot, 'hooks', 'hooks.json'))).toBe(true);
    expect(existsSync(join(cacheRoot, 'scripts', 'run.cjs'))).toBe(true);
    expect(existsSync(join(cacheRoot, 'commands', 'omc-setup.md'))).toBe(true);
  });

  it('rejects cache install roots that escape the cache directory via .. segments', async () => {
    const configDir = process.env.CLAUDE_CONFIG_DIR as string;
    const cacheBase = join(configDir, 'plugins', 'cache');
    const escapedInstallPath = `${cacheBase}/../../../escaped-target`;
    const escapedResolvedRoot = join(tempRoot, 'escaped-target');
    const sourceRoot = join(tempRoot, 'marketplace-source-escape');

    writePayloadTree(sourceRoot);
    mkdirSync(cacheBase, { recursive: true });
    mkdirSync(escapedResolvedRoot, { recursive: true });
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'oh-my-claudecode@omc': [{ installPath: escapedInstallPath, version: '4.12.0' }],
        },
      }, null, 2),
    );
    writeFileSync(
      join(configDir, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        omc: {
          installLocation: sourceRoot,
          source: { source: 'directory', path: sourceRoot },
        },
      }, null, 2),
    );

    const installer = await freshInstaller();
    const result = installer.syncInstalledPluginPayload();

    expect(result.synced).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.sourceRoot).toBeNull();
    expect(result.targetRoots).toEqual([]);
    expect(existsSync(join(escapedResolvedRoot, 'package.json'))).toBe(false);
    expect(existsSync(join(escapedResolvedRoot, 'skills', 'plan', 'SKILL.md'))).toBe(false);
  });
});
