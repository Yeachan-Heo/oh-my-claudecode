import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SETUP_SCRIPT = join(REPO_ROOT, 'scripts', 'setup-claude-md.sh');
const CONFIG_DIR_HELPER = join(REPO_ROOT, 'scripts', 'lib', 'config-dir.sh');

const tempRoots: string[] = [];

function createPluginFixture(claudeMdContent: string) {
  const root = mkdtempSync(join(tmpdir(), 'omc-setup-claude-md-'));
  tempRoots.push(root);

  const pluginRoot = join(root, 'plugin');
  const projectRoot = join(root, 'project');
  const homeRoot = join(root, 'home');

  mkdirSync(join(pluginRoot, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(pluginRoot, 'docs'), { recursive: true });
  mkdirSync(join(pluginRoot, 'skills', 'omc-reference'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeRoot, { recursive: true });

  copyFileSync(SETUP_SCRIPT, join(pluginRoot, 'scripts', 'setup-claude-md.sh'));
  copyFileSync(CONFIG_DIR_HELPER, join(pluginRoot, 'scripts', 'lib', 'config-dir.sh'));
  writeFileSync(join(pluginRoot, 'docs', 'CLAUDE.md'), claudeMdContent);
  writeFileSync(join(pluginRoot, 'skills', 'omc-reference', 'SKILL.md'), `---
name: omc-reference
description: Test fixture reference skill
user-invocable: false
---

# Test OMC Reference
`);

  return {
    pluginRoot,
    projectRoot,
    homeRoot,
    scriptPath: join(pluginRoot, 'scripts', 'setup-claude-md.sh'),
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('setup-claude-md.sh (issue #1572)', () => {
  it('installs the canonical docs/CLAUDE.md content with OMC markers', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const installedPath = join(fixture.projectRoot, '.claude', 'CLAUDE.md');
    expect(existsSync(installedPath)).toBe(true);

    const installed = readFileSync(installedPath, 'utf-8');
    expect(installed).toContain('<!-- OMC:START -->');
    expect(installed).toContain('<!-- OMC:END -->');
    expect(installed).toContain('<!-- OMC:VERSION:9.9.9 -->');
    expect(installed).toContain('# Canonical CLAUDE');

    const installedSkillPath = join(fixture.projectRoot, '.claude', 'skills', 'omc-reference', 'SKILL.md');
    expect(existsSync(installedSkillPath)).toBe(true);
    expect(readFileSync(installedSkillPath, 'utf-8')).toContain('# Test OMC Reference');
  });

  it('refuses to install a canonical source that lacks OMC markers', () => {
    const fixture = createPluginFixture(`# oh-my-claudecode (OMC) v9.9.9 Summary

This is a summarized CLAUDE.md without markers.
`);

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('missing required OMC markers');
    expect(existsSync(join(fixture.projectRoot, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('adds a local git exclude block for .omc artifacts while preserving .omc/skills', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const gitInit = spawnSync('git', ['init'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(gitInit.status).toBe(0);

    const result = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const excludePath = join(fixture.projectRoot, '.git', 'info', 'exclude');
    expect(existsSync(excludePath)).toBe(true);

    const excludeContents = readFileSync(excludePath, 'utf-8');
    expect(excludeContents).toContain('# BEGIN OMC local artifacts');
    expect(excludeContents).toContain('.omc/*');
    expect(excludeContents).toContain('!.omc/skills/');
    expect(excludeContents).toContain('!.omc/skills/**');
    expect(excludeContents).toContain('# END OMC local artifacts');
  });

  it('does not duplicate the local git exclude block on repeated local setup runs', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const gitInit = spawnSync('git', ['init'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(gitInit.status).toBe(0);

    const firstRun = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(firstRun.status).toBe(0);

    const secondRun = spawnSync('bash', [fixture.scriptPath, 'local'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
      },
      encoding: 'utf-8',
    });
    expect(secondRun.status).toBe(0);

    const excludeContents = readFileSync(join(fixture.projectRoot, '.git', 'info', 'exclude'), 'utf-8');
    expect(excludeContents.match(/# BEGIN OMC local artifacts/g)).toHaveLength(1);
  });

  it('uses CLAUDE_CONFIG_DIR for global setup targets and plugin verification', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(join(configDir, 'hooks'), { recursive: true });
    writeFileSync(join(configDir, 'hooks', 'keyword-detector.sh'), 'legacy');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const result = spawnSync('bash', [fixture.scriptPath, 'global'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(configDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(configDir, 'skills', 'omc-reference', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(configDir, 'hooks', 'keyword-detector.sh'))).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Plugin verified');
  });

  it('overwrites an existing global CLAUDE.md by default when preserve mode is not requested', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User CLAUDE\nKeep my base config.\n');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const result = spawnSync('bash', [fixture.scriptPath, 'global'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const baseClaude = readFileSync(join(configDir, 'CLAUDE.md'), 'utf-8');
    expect(baseClaude).toContain('<!-- OMC:START -->');
    expect(baseClaude).toContain('<!-- OMC:END -->');
    expect(baseClaude).toContain('<!-- User customizations (migrated from previous CLAUDE.md) -->');
    expect(baseClaude).toContain('# User CLAUDE');
    expect(existsSync(join(configDir, 'CLAUDE-omc.md'))).toBe(false);
  });

  it('preserves an existing global CLAUDE.md when preserve mode is explicitly requested', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User CLAUDE\nKeep my base config.\n');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const result = spawnSync('bash', [fixture.scriptPath, 'global', 'preserve'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const baseClaude = readFileSync(join(configDir, 'CLAUDE.md'), 'utf-8');
    const companionClaude = readFileSync(join(configDir, 'CLAUDE-omc.md'), 'utf-8');

    expect(baseClaude).toContain('# User CLAUDE');
    expect(baseClaude).toContain('Keep my base config.');
    expect(baseClaude).toContain('<!-- OMC:IMPORT:START -->');
    expect(baseClaude).toContain('@CLAUDE-omc.md');
    expect(baseClaude).toContain('<!-- OMC:IMPORT:END -->');
    expect(baseClaude).not.toContain('<!-- OMC:START -->');

    expect(companionClaude).toContain('<!-- OMC:START -->');
    expect(companionClaude).toContain('<!-- OMC:END -->');
    expect(companionClaude).toContain('<!-- OMC:VERSION:9.9.9 -->');
    expect(companionClaude).toContain('# Canonical CLAUDE');
  });

  it('updates the preserved companion file idempotently without duplicating the managed import block', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User CLAUDE\nKeep my base config.\n');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const env = {
      ...process.env,
      HOME: fixture.homeRoot,
      CLAUDE_CONFIG_DIR: configDir,
    };

    const first = spawnSync('bash', [fixture.scriptPath, 'global', 'preserve'], {
      cwd: fixture.projectRoot,
      env,
      encoding: 'utf-8',
    });
    expect(first.status).toBe(0);

    const second = spawnSync('bash', [fixture.scriptPath, 'global', 'preserve'], {
      cwd: fixture.projectRoot,
      env,
      encoding: 'utf-8',
    });
    expect(second.status).toBe(0);

    const baseClaude = readFileSync(join(configDir, 'CLAUDE.md'), 'utf-8');
    expect(baseClaude.match(/<!-- OMC:IMPORT:START -->/g)).toHaveLength(1);
    expect(baseClaude.match(/@CLAUDE-omc\.md/g)).toHaveLength(1);
    expect(readFileSync(join(configDir, 'CLAUDE-omc.md'), 'utf-8')).toContain('<!-- OMC:VERSION:9.9.9 -->');
  });

  it('cleans up orphaned companion file when switching from preserve to overwrite mode', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User CLAUDE\nKeep my base config.\n');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const env = {
      ...process.env,
      HOME: fixture.homeRoot,
      CLAUDE_CONFIG_DIR: configDir,
    };

    // Run 1: preserve mode — creates companion + import block
    const first = spawnSync('bash', [fixture.scriptPath, 'global', 'preserve'], {
      cwd: fixture.projectRoot,
      env,
      encoding: 'utf-8',
    });
    expect(first.status).toBe(0);
    expect(existsSync(join(configDir, 'CLAUDE-omc.md'))).toBe(true);
    expect(readFileSync(join(configDir, 'CLAUDE.md'), 'utf-8')).toContain('<!-- OMC:IMPORT:START -->');

    // Run 2: overwrite mode (default) — must clean up companion and import block
    const second = spawnSync('bash', [fixture.scriptPath, 'global', 'overwrite'], {
      cwd: fixture.projectRoot,
      env,
      encoding: 'utf-8',
    });
    expect(second.status).toBe(0);

    // Companion file must be removed
    expect(existsSync(join(configDir, 'CLAUDE-omc.md'))).toBe(false);

    // CLAUDE.md must have OMC markers inline, not an import block
    const baseClaude = readFileSync(join(configDir, 'CLAUDE.md'), 'utf-8');
    expect(baseClaude).toContain('<!-- OMC:START -->');
    expect(baseClaude).toContain('<!-- OMC:END -->');
    expect(baseClaude).not.toContain('<!-- OMC:IMPORT:START -->');
    expect(baseClaude).not.toContain('@CLAUDE-omc.md');

    // User content should be preserved
    expect(baseClaude).toContain('# User CLAUDE');
  });

  it('refuses preserve mode when the companion path is a symlink', () => {
    const fixture = createPluginFixture(`<!-- OMC:START -->
<!-- OMC:VERSION:9.9.9 -->

# Canonical CLAUDE
Use the real docs file.
<!-- OMC:END -->
`);

    const configDir = join(fixture.homeRoot, 'custom-profile');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User CLAUDE\nKeep my base config.\n');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ plugins: ['oh-my-claudecode'] }));

    const realTarget = join(fixture.homeRoot, 'outside-target.md');
    writeFileSync(realTarget, 'outside target');
    symlinkSync(realTarget, join(configDir, 'CLAUDE-omc.md'));

    const result = spawnSync('bash', [fixture.scriptPath, 'global', 'preserve'], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Refusing to write OMC companion CLAUDE.md');
    expect(readFileSync(realTarget, 'utf-8')).toBe('outside target');
  });
});

describe('setup-claude-md.sh stale CLAUDE_PLUGIN_ROOT resolution', () => {
  it('uses docs/CLAUDE.md from the active version in installed_plugins.json, not the stale script location', () => {
    // Simulate: script lives at old version (4.8.2), but installed_plugins.json points to new version (4.9.0)
    const root = mkdtempSync(join(tmpdir(), 'omc-stale-root-'));
    tempRoots.push(root);

    const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const oldVersion = join(cacheBase, '4.8.2');
    const newVersion = join(cacheBase, '4.9.0');
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');

    // Create old version (where the script will be copied)
    mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
    mkdirSync(join(oldVersion, 'docs'), { recursive: true });
    copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
    mkdirSync(join(oldVersion, 'scripts', 'lib'), { recursive: true });
    copyFileSync(CONFIG_DIR_HELPER, join(oldVersion, 'scripts', 'lib', 'config-dir.sh'));
    writeFileSync(
      join(oldVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n\n# Old Version\n<!-- OMC:END -->\n`,
    );

    // Create new version (the active one)
    mkdirSync(join(newVersion, 'docs'), { recursive: true });
    writeFileSync(
      join(newVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.9.0 -->\n\n# New Version\n<!-- OMC:END -->\n`,
    );

    // Create installed_plugins.json pointing to the new version
    mkdirSync(join(homeRoot, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        'oh-my-claudecode@omc': [
          {
            installPath: newVersion,
            version: '4.9.0',
          },
        ],
      }),
    );

    // Create project dir and settings.json (needed for plugin verification)
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(homeRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'settings.json'),
      JSON.stringify({ plugins: ['oh-my-claudecode'] }),
    );

    // Run the OLD version's script — it should resolve to the NEW version's docs/CLAUDE.md
    const result = spawnSync(
      'bash',
      [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: homeRoot,
          CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
        },
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
    // Should contain the NEW version, not the old one
    expect(installed).toContain('<!-- OMC:VERSION:4.9.0 -->');
    expect(installed).toContain('# New Version');
    expect(installed).not.toContain('<!-- OMC:VERSION:4.8.2 -->');
  });

  it('uses docs/CLAUDE.md from the active version when installed_plugins.json wraps plugins under a plugins key', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-stale-wrapped-root-'));
    tempRoots.push(root);

    const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const oldVersion = join(cacheBase, '4.8.2');
    const newVersion = join(cacheBase, '4.9.0');
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');

    mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
    mkdirSync(join(oldVersion, 'docs'), { recursive: true });
    copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
    mkdirSync(join(oldVersion, 'scripts', 'lib'), { recursive: true });
    copyFileSync(CONFIG_DIR_HELPER, join(oldVersion, 'scripts', 'lib', 'config-dir.sh'));
    writeFileSync(
      join(oldVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n\n# Old Version\n<!-- OMC:END -->\n`,
    );

    mkdirSync(join(newVersion, 'docs'), { recursive: true });
    writeFileSync(
      join(newVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.9.0 -->\n\n# New Version\n<!-- OMC:END -->\n`,
    );

    mkdirSync(join(homeRoot, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'oh-my-claudecode@omc': [
            {
              installPath: newVersion,
              version: '4.9.0',
            },
          ],
        },
      }),
    );

    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(homeRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'settings.json'),
      JSON.stringify({ plugins: ['oh-my-claudecode'] }),
    );

    const result = spawnSync(
      'bash',
      [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: homeRoot,
          CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
        },
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(installed).toContain('<!-- OMC:VERSION:4.9.0 -->');
    expect(installed).toContain('# New Version');
    expect(installed).not.toContain('<!-- OMC:VERSION:4.8.2 -->');
  });

  it('falls back to scanning cache for latest version when installed_plugins.json is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-stale-fallback-'));
    tempRoots.push(root);

    const cacheBase = join(root, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const oldVersion = join(cacheBase, '4.8.2');
    const newVersion = join(cacheBase, '4.9.0');
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');

    // Create old version (where the script lives)
    mkdirSync(join(oldVersion, 'scripts'), { recursive: true });
    mkdirSync(join(oldVersion, 'docs'), { recursive: true });
    copyFileSync(SETUP_SCRIPT, join(oldVersion, 'scripts', 'setup-claude-md.sh'));
    mkdirSync(join(oldVersion, 'scripts', 'lib'), { recursive: true });
    copyFileSync(CONFIG_DIR_HELPER, join(oldVersion, 'scripts', 'lib', 'config-dir.sh'));
    writeFileSync(
      join(oldVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.8.2 -->\n\n# Old\n<!-- OMC:END -->\n`,
    );

    // Create new version (no installed_plugins.json, relies on cache scan)
    mkdirSync(join(newVersion, 'docs'), { recursive: true });
    writeFileSync(
      join(newVersion, 'docs', 'CLAUDE.md'),
      `<!-- OMC:START -->\n<!-- OMC:VERSION:4.9.0 -->\n\n# New\n<!-- OMC:END -->\n`,
    );

    // No installed_plugins.json — fallback to cache scan
    mkdirSync(join(homeRoot, '.claude'), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(homeRoot, '.claude', 'settings.json'),
      JSON.stringify({ plugins: ['oh-my-claudecode'] }),
    );

    const result = spawnSync(
      'bash',
      [join(oldVersion, 'scripts', 'setup-claude-md.sh'), 'local'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: homeRoot,
          CLAUDE_CONFIG_DIR: join(homeRoot, '.claude'),
        },
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);

    const installed = readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(installed).toContain('<!-- OMC:VERSION:4.9.0 -->');
    expect(installed).not.toContain('<!-- OMC:VERSION:4.8.2 -->');
  });
});
