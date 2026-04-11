import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveActivePluginRoot } from '../plugin-root.js';

describe('resolveActivePluginRoot', () => {
  let workDir: string;
  let configDir: string;
  let cacheBase: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'omc-plugin-root-'));
    configDir = join(workDir, 'config');
    cacheBase = join(workDir, 'cache');
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    mkdirSync(cacheBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const createValidPluginRoot = (version: string): string => {
    const path = join(cacheBase, version);
    mkdirSync(join(path, 'docs'), { recursive: true });
    writeFileSync(
      join(path, 'docs', 'CLAUDE.md'),
      `<!-- OMC:VERSION:${version} -->\n# OMC ${version}\n`,
    );
    return path;
  };

  const writeInstalledPlugins = (content: string): void => {
    writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), content);
  };

  it('prefers a newer cache version over a stale installed_plugins.json entry (4.8.2 → 4.9.0 upgrade guard)', () => {
    const oldPath = createValidPluginRoot('4.8.2');
    const newPath = createValidPluginRoot('4.9.0');
    writeInstalledPlugins(
      JSON.stringify({
        'oh-my-claudecode@omc': [{ installPath: oldPath, version: '4.8.2' }],
      }),
    );

    const result = resolveActivePluginRoot({ configDir, scriptDir: oldPath });

    expect(result).toBe(newPath);
  });

  it('falls back to a cache scan when installed_plugins.json is missing', () => {
    const oldPath = createValidPluginRoot('4.8.2');
    const newPath = createValidPluginRoot('4.9.0');

    const result = resolveActivePluginRoot({ configDir, scriptDir: oldPath });

    expect(result).toBe(newPath);
  });

  it('falls back to a cache scan when installed_plugins.json is malformed JSON', () => {
    const oldPath = createValidPluginRoot('4.8.2');
    const newPath = createValidPluginRoot('4.9.0');
    writeInstalledPlugins('{ not valid json');

    const result = resolveActivePluginRoot({ configDir, scriptDir: oldPath });

    expect(result).toBe(newPath);
  });

  it('returns the last-resort scriptDir when neither installed_plugins.json nor any cache versions are available', () => {
    // Point scriptDir at a standalone directory whose parent contains no
    // valid semver version directories — the final branch must return it.
    const scriptDir = join(workDir, 'standalone-plugin-root');
    mkdirSync(scriptDir, { recursive: true });

    const result = resolveActivePluginRoot({ configDir, scriptDir });

    expect(result).toBe(scriptDir);
  });
});
