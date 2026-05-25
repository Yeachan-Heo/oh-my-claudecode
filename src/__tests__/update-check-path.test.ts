import { describe, expect, it, afterEach } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import { getUpdateCheckCachePath } from '../utils/config-dir.js';

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
});

describe('update-check cache path', () => {
  it('uses the active Claude config dir as the canonical OMC cache root', () => {
    process.env.CLAUDE_CONFIG_DIR = join('/tmp', 'omc-custom-claude');

    expect(getUpdateCheckCachePath()).toBe(
      join('/tmp', 'omc-custom-claude', '.omc', 'update-check.json'),
    );
  });

  it('keeps the hook updater writer and HUD reader on the shared helper path', () => {
    const hudSource = readFileSync('src/hud/index.ts', 'utf-8');
    const hookSource = readFileSync('scripts/session-start.mjs', 'utf-8');
    const templateSource = readFileSync('templates/hooks/session-start.mjs', 'utf-8');
    const templateHelperSource = readFileSync('templates/hooks/lib/config-dir.mjs', 'utf-8');

    expect(hudSource).toContain('getUpdateCheckCachePath()');
    expect(hookSource).toContain('getUpdateCheckCachePath()');
    expect(templateSource).toContain('getUpdateCheckCachePath()');
    expect(templateHelperSource).toContain('function getUpdateCheckCachePath()');

    for (const source of [hudSource, hookSource, templateSource]) {
      expect(source).not.toMatch(/join\(homedir\(\),\s*['"]\.omc['"],\s*['"]update-check\.json['"]\)/);
    }
  });
});
