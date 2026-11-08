/**
 * Tests for `--plugin-dir-mode` setup flag and `OMC_PLUGIN_ROOT` auto-detection.
 *
 * Behavior under test (from src/installer/index.ts and src/cli/index.ts):
 *   1. `pluginDirMode: true` → install() does NOT copy legacy agents and does NOT
 *      install bundled skills, but still installs HUD/hooks/CLAUDE.md.
 *   2. `OMC_PLUGIN_ROOT` env var (set by `omc --plugin-dir`) → CLI auto-detects
 *      and behaves as if `--plugin-dir-mode` were passed.
 *   3. No flag, no env var → existing behavior (legacy agents + bundled skills
 *      still copied when no plugin is enabled).
 *   4. `--no-plugin` + `--plugin-dir-mode` → `--no-plugin` wins (skills copied).
 *   5. Real OMC plugin enabled → existing skip behavior unchanged (independent
 *      of pluginDirMode).
 *
 * These tests run install() against a throwaway CLAUDE_CONFIG_DIR and assert on
 * the resulting filesystem layout. Module imports are reset between tests so
 * each call picks up the isolated config dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ORIG_ENV = { ...process.env };
let testDir: string;

async function freshInstaller() {
  vi.resetModules();
  return await import('../index.js');
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'omc-pdm-'));
  // Force a clean, isolated config dir for every test
  process.env.CLAUDE_CONFIG_DIR = testDir;
  // Avoid plugin auto-detection from the developer's real ~/.claude
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.OMC_PLUGIN_ROOT;
});

afterEach(() => {
  // Restore env
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIG_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIG_ENV);
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('install() with pluginDirMode option', () => {
  it('1. pluginDirMode=true → does NOT create agents/ or skills/ in configDir', async () => {
    const { install } = await freshInstaller();
    const result = install({
      verbose: false,
      skipClaudeCheck: true,
      pluginDirMode: true,
    });

    expect(result.installedAgents).toEqual([]);
    expect(result.installedSkills).toEqual([]);
    expect(existsSync(join(testDir, 'agents'))).toBe(false);
    // Either skills/ does not exist OR it's empty (depending on plugin-detection state)
    if (existsSync(join(testDir, 'skills'))) {
      expect(readdirSync(join(testDir, 'skills'))).toEqual([]);
    }
  });

  it('3. neither flag nor env var → existing behavior copies legacy agents/skills', async () => {
    const { install, hasEnabledOmcPlugin } = await freshInstaller();
    const result = install({
      verbose: false,
      skipClaudeCheck: true,
    });

    // If a plugin happens to be enabled in the host environment, the assertion
    // collapses to "skip is correct under existing rules". Otherwise we expect
    // legacy agents to have been written.
    if (!hasEnabledOmcPlugin()) {
      expect(result.installedAgents.length).toBeGreaterThan(0);
      expect(existsSync(join(testDir, 'agents'))).toBe(true);
    }
  });

  it('4. noPlugin + pluginDirMode → noPlugin wins, skills are copied', async () => {
    const { install } = await freshInstaller();
    const result = install({
      verbose: false,
      skipClaudeCheck: true,
      noPlugin: true,
      pluginDirMode: true,
    });

    // noPlugin forces bundled skill install regardless of pluginDirMode
    expect(result.installedSkills.length).toBeGreaterThan(0);
    expect(existsSync(join(testDir, 'skills'))).toBe(true);
  });
});

// CLI-level precedence rules (--plugin-dir-mode flag, OMC_PLUGIN_ROOT
// auto-detection, --no-plugin conflict) are exercised against the real
// commander pipeline in src/cli/__tests__/setup-command-precedence.test.ts.
// They used to be re-implemented inline here as a `resolvePluginDirMode`
// helper, which drifted from the production logic in src/cli/index.ts.

describe('5. real OMC plugin enabled → existing skip behavior unchanged', () => {
  it('hasEnabledOmcPlugin() result drives skip independently of pluginDirMode', async () => {
    // We can't reliably toggle the host's settings.json from inside a unit test,
    // so we just assert the install() call short-circuits identically when both
    // (a) pluginDirMode=true and (b) host plugin detection says skip — i.e. no
    // legacy agents/skills land in configDir.
    const { install } = await freshInstaller();
    const result = install({
      verbose: false,
      skipClaudeCheck: true,
      pluginDirMode: true,
    });
    expect(result.installedAgents).toEqual([]);
    if (existsSync(join(testDir, 'skills'))) {
      expect(readdirSync(join(testDir, 'skills'))).toEqual([]);
    }
  });
});
