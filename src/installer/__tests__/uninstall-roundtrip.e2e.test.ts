/**
 * End-to-end round-trip tests for the OMC uninstaller.
 *
 * Tests the full lifecycle: setup → idempotent-setup → uninstall →
 * idempotent-uninstall → re-install, all inside a throwaway tmpdir.
 *
 * Uses a real `install()` invocation (not mocked) against a custom
 * CLAUDE_CONFIG_DIR so the real user's ~/.claude is never touched.
 *
 * No HTTP calls: the installer reads CLAUDE.md from the local package's
 * docs/ directory (resolveActivePluginRoot falls back to the repo root).
 *
 * Skipped on Windows (rmSync recursion quirks with locked files in CI).
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OMC_PLUGIN_ROOT_ENV } from '../../lib/env-vars.js';

// ---------------------------------------------------------------------------
// Env-snapshot keys to isolate every test from host state
// ---------------------------------------------------------------------------

const SAVED_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  OMC_PLUGIN_ROOT_ENV,
  'CLAUDE_PLUGIN_ROOT',
  'OMC_DEV',
] as const;
type EnvSnapshot = Partial<Record<(typeof SAVED_ENV_KEYS)[number], string | undefined>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpConfigDir: string;
let savedEnv: EnvSnapshot;

/** Dynamically import a fresh copy of the installer (module-level consts re-evaluated). */
async function freshInstaller() {
  vi.resetModules();
  return await import('../index.js');
}

/** Dynamically import a fresh copy of the uninstaller. */
async function freshUninstaller() {
  vi.resetModules();
  return await import('../uninstall.js');
}

/** Install into tmpConfigDir and return the result. */
async function doInstall() {
  const { install } = await freshInstaller();
  return install({ verbose: false, skipClaudeCheck: true, force: true });
}

/** Uninstall from tmpConfigDir and return the result. */
async function doUninstall(opts: { dryRun?: boolean; preserveUserContent?: boolean } = {}) {
  const { uninstall } = await freshUninstaller();
  return uninstall({
    configDir: tmpConfigDir,
    dryRun: opts.dryRun,
    preserveUserContent: opts.preserveUserContent,
    logger: () => { /* silent in tests */ },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'omc-uninstall-e2e-'));
  savedEnv = {};
  for (const key of SAVED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Point the installer at the throwaway dir
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
});

afterEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
  rmSync(tmpConfigDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('uninstall round-trip e2e', () => {
  // ── Test 1: install() populates the config dir ────────────────────────────
  it('Test 1: install() creates agents, CLAUDE.md, and state files in configDir', async () => {
    const result = await doInstall();
    expect(result.success, `install failed: ${result.message} / ${result.errors.join(', ')}`).toBe(true);

    // Agents directory must exist with at least one .md file
    const agentsDir = join(tmpConfigDir, 'agents');
    expect(existsSync(agentsDir), 'agents/ should exist').toBe(true);
    const agentFiles = readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    expect(agentFiles.length, 'agents/ should contain at least one .md file').toBeGreaterThan(0);

    // CLAUDE.md with OMC markers
    const claudeMdPath = join(tmpConfigDir, 'CLAUDE.md');
    expect(existsSync(claudeMdPath), 'CLAUDE.md should exist').toBe(true);
    const claudeContent = readFileSync(claudeMdPath, 'utf8');
    expect(claudeContent).toContain('<!-- OMC:START -->');
    expect(claudeContent).toContain('<!-- OMC:END -->');

    // Version state file
    expect(existsSync(join(tmpConfigDir, '.omc-version.json')), '.omc-version.json should exist').toBe(true);
  });

  // ── Test 2: idempotent setup ──────────────────────────────────────────────
  it('Test 2: running install() twice is idempotent — OMC markers still present', async () => {
    await doInstall();

    // Run a second time
    const result2 = await doInstall();
    expect(result2.success, `second install failed: ${result2.message}`).toBe(true);

    // Core artifacts still present after second run
    expect(existsSync(join(tmpConfigDir, '.omc-version.json'))).toBe(true);
    const claudeContent = readFileSync(join(tmpConfigDir, 'CLAUDE.md'), 'utf8');
    expect(claudeContent).toContain('<!-- OMC:START -->');
    expect(claudeContent).toContain('<!-- OMC:END -->');
  });

  // ── Test 3: uninstall removes everything ─────────────────────────────────
  it('Test 3: uninstall removes agents, skills, hud, state files, and CLAUDE.md (pure-OMC)', async () => {
    await doInstall();

    const result = await doUninstall();
    expect(result.removed.length, 'should have removed something').toBeGreaterThan(0);

    // agents/ may still exist but should have no OMC .md files
    const agentsDir = join(tmpConfigDir, 'agents');
    if (existsSync(agentsDir)) {
      const remaining = readdirSync(agentsDir).filter(f => f.endsWith('.md'));
      expect(remaining, 'no OMC agent .md files should remain').toHaveLength(0);
    }

    // State files gone
    expect(existsSync(join(tmpConfigDir, '.omc-version.json')), '.omc-version.json should be gone').toBe(false);
    expect(existsSync(join(tmpConfigDir, '.omc-config.json')), '.omc-config.json should be gone').toBe(false);
    expect(existsSync(join(tmpConfigDir, 'CLAUDE-omc.md')), 'CLAUDE-omc.md should be gone').toBe(false);

    // CLAUDE.md should be gone (install wrote pure-OMC content, no user customizations)
    expect(existsSync(join(tmpConfigDir, 'CLAUDE.md')), 'CLAUDE.md should be removed (pure OMC content)').toBe(false);

    // HUD should be gone
    const hudPath = join(tmpConfigDir, 'hud', 'omc-hud.mjs');
    expect(existsSync(hudPath), 'omc-hud.mjs should be removed').toBe(false);
  });

  // ── Test 4: idempotent uninstall ──────────────────────────────────────────
  it('Test 4: second uninstall call returns removed:[] and skipped:>0 with no warnings', async () => {
    await doInstall();
    await doUninstall();

    // Second call on an already-clean directory
    const result2 = await doUninstall();
    expect(result2.removed, 'second uninstall should remove nothing').toHaveLength(0);
    expect(result2.skipped.length, 'second uninstall should have skipped items').toBeGreaterThan(0);
    expect(result2.warnings, 'second uninstall should emit no warnings').toHaveLength(0);
  });

  // ── Test 5: preserves user CLAUDE.md customizations ───────────────────────
  it('Test 5: uninstall preserves user content outside OMC markers', async () => {
    await doInstall();

    // Manually append user content after the OMC:END marker
    const claudeMdPath = join(tmpConfigDir, 'CLAUDE.md');
    const existing = readFileSync(claudeMdPath, 'utf8');
    const withUserContent = existing + '\n\n<!-- User customizations -->\nMy custom notes\n';
    writeFileSync(claudeMdPath, withUserContent, 'utf8');

    const result = await doUninstall({ preserveUserContent: true });

    // CLAUDE.md must still exist with user content
    expect(existsSync(claudeMdPath), 'CLAUDE.md should still exist').toBe(true);
    const after = readFileSync(claudeMdPath, 'utf8');
    expect(after, 'user content should be preserved').toContain('My custom notes');
    expect(after, 'OMC:START marker should be stripped').not.toContain('<!-- OMC:START -->');

    // result.preserved must contain the CLAUDE.md path
    expect(result.preserved, 'preserved should include CLAUDE.md').toContain(claudeMdPath);
  });

  // ── Test 6: re-install after uninstall works ───────────────────────────────
  it('Test 6: install after uninstall succeeds and recreates all artifacts', async () => {
    await doInstall();
    await doUninstall();

    // Second install
    const result3 = await doInstall();
    expect(result3.success, `re-install failed: ${result3.message}`).toBe(true);

    // Everything should be back
    const agentsDir = join(tmpConfigDir, 'agents');
    expect(existsSync(agentsDir)).toBe(true);
    expect(readdirSync(agentsDir).filter(f => f.endsWith('.md')).length).toBeGreaterThan(0);

    expect(existsSync(join(tmpConfigDir, '.omc-version.json'))).toBe(true);

    const claudeContent = readFileSync(join(tmpConfigDir, 'CLAUDE.md'), 'utf8');
    expect(claudeContent).toContain('<!-- OMC:START -->');
    expect(claudeContent).toContain('<!-- OMC:END -->');
  });

  // ── Test 7: CLAUDE_CONFIG_DIR isolation ───────────────────────────────────
  it('Test 7: all operations stay within tmpConfigDir (real user config untouched)', async () => {
    // Capture the real config dir BEFORE the test manipulates anything
    const { getClaudeConfigDir } = await import('../../utils/config-dir.js');

    // With CLAUDE_CONFIG_DIR set to tmpConfigDir, getClaudeConfigDir() should return tmpConfigDir
    const resolvedDir = getClaudeConfigDir();
    expect(resolvedDir, 'getClaudeConfigDir() should resolve to tmpConfigDir').toBe(tmpConfigDir);

    // Install and uninstall
    await doInstall();
    await doUninstall();

    // Verify the resolved dir is still the tmp one, not a real user dir
    const resolvedDirAfter = getClaudeConfigDir();
    expect(resolvedDirAfter).toBe(tmpConfigDir);
  });

  // ── Test 8: dryRun does not modify the filesystem ─────────────────────────
  it('Test 8 (dryRun): uninstall --dry-run lists removals but leaves files intact', async () => {
    await doInstall();

    const result = await doUninstall({ dryRun: true });

    // dryRun result should list items to remove
    expect(result.removed.length, 'dry-run should report items to remove').toBeGreaterThan(0);

    // But the actual files must still be on disk
    expect(existsSync(join(tmpConfigDir, '.omc-version.json')), 'state file still exists in dry-run').toBe(true);
    expect(existsSync(join(tmpConfigDir, 'CLAUDE.md')), 'CLAUDE.md still exists in dry-run').toBe(true);

    const agentsDir = join(tmpConfigDir, 'agents');
    if (existsSync(agentsDir)) {
      const agentFiles = readdirSync(agentsDir).filter(f => f.endsWith('.md'));
      expect(agentFiles.length, 'agents still exist in dry-run').toBeGreaterThan(0);
    }
  });
});
