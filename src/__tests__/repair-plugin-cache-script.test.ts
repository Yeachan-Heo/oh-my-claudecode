import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'repair-plugin-cache.mjs');
const tempRoots: string[] = [];

function writePluginRoot(root: string, version: string): void {
  mkdirSync(join(root, 'hooks'), { recursive: true });
  mkdirSync(join(root, 'skills', 'omc-setup'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'hooks.json'), '{}\n');
  writeFileSync(join(root, 'skills', 'omc-setup', 'SKILL.md'), '# setup\n');
  writeFileSync(join(root, 'docs', 'CLAUDE.md'), `<!-- OMC:VERSION:${version} -->\n`);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('repair-plugin-cache.mjs', () => {
  it('rewrites stale installed_plugins.json and keeps old cache path as a symlink fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-repair-plugin-cache-'));
    tempRoots.push(root);

    const configDir = join(root, '.claude');
    const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const oldRoot = join(cacheBase, '4.11.6');
    const newRoot = join(cacheBase, '4.14.1');
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    writePluginRoot(oldRoot, '4.11.6');
    writePluginRoot(newRoot, '4.14.1');
    writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'oh-my-claudecode@omc': [{ installPath: oldRoot, version: '4.11.6', enabled: true }],
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Repaired plugin cache references');

    const registry = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf-8'));
    expect(registry.plugins['oh-my-claudecode@omc'][0]).toMatchObject({
      installPath: newRoot,
      version: '4.14.1',
      enabled: true,
    });
    expect(existsSync(oldRoot)).toBe(true);
    expect(lstatSync(oldRoot).isSymbolicLink()).toBe(true);
    expect(readlinkSync(oldRoot)).toBe('4.14.1');
    expect(existsSync(join(oldRoot, 'hooks', 'hooks.json'))).toBe(true);
  });

  it('repairs a registry entry whose old cache path was already deleted', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-repair-missing-cache-'));
    tempRoots.push(root);

    const configDir = join(root, '.claude');
    const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    const oldRoot = join(cacheBase, '4.11.6');
    const newRoot = join(cacheBase, '4.14.1');
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    writePluginRoot(newRoot, '4.14.1');
    writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
      'oh-my-claudecode@omc': [{ installPath: oldRoot, version: '4.11.6' }],
    }, null, 2));

    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(oldRoot)).toBe(true);
    expect(lstatSync(oldRoot).isSymbolicLink()).toBe(true);
    expect(readlinkSync(oldRoot)).toBe('4.14.1');
    expect(existsSync(join(oldRoot, 'hooks', 'hooks.json'))).toBe(true);
    const registry = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf-8'));
    expect(registry['oh-my-claudecode@omc'][0]).toMatchObject({
      installPath: newRoot,
      version: '4.14.1',
    });
  });

  it('setup instructions repair cache references before prompts and avoid direct cache deletion', () => {
    const setupSkill = readFileSync(join(REPO_ROOT, 'skills', 'omc-setup', 'SKILL.md'), 'utf-8');
    const phase = readFileSync(join(REPO_ROOT, 'skills', 'omc-setup', 'phases', '02-configure.md'), 'utf-8');

    expect(setupSkill).toContain('Active Plugin Root Resolution');
    expect(setupSkill).toContain('repair-plugin-cache.mjs');
    expect(setupSkill.indexOf('repair-plugin-cache.mjs', setupSkill.indexOf('Active Plugin Root Resolution'))).toBeLessThan(setupSkill.indexOf('## Pre-Setup Check'));
    expect(phase).toContain('Repair Stale Plugin Cache References');
    expect(phase).toContain('repair-plugin-cache.mjs');
    expect(phase).not.toContain('rmSync(p.join(b,x)');
  });
});
