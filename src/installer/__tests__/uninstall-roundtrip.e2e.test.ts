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
  mkdirSync,
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

  // ── Test 9: preserve-mode uninstall (CLAUDE-omc.md + OMC:IMPORT block) ────
  it('Test 9: uninstall reverses preserve-mode state — removes companion + strips IMPORT block + preserves user base', async () => {
    await doInstall();

    // Simulate preserve-mode filesystem state AFTER a `--preserve` install:
    //   - base CLAUDE.md: user content only, followed by an OMC:IMPORT block
    //     pointing at the companion.
    //   - CLAUDE-omc.md: the full OMC block wrapped in OMC:START/END markers.
    //
    // The uninstaller does not care HOW this state got there — it only
    // cares that the on-disk shape matches preserve-mode invariants.
    const claudeMdPath = join(tmpConfigDir, 'CLAUDE.md');
    const companionPath = join(tmpConfigDir, 'CLAUDE-omc.md');

    // Move the installed OMC block into the companion file.
    const installedOmcContent = readFileSync(claudeMdPath, 'utf8');
    writeFileSync(companionPath, installedOmcContent, 'utf8');

    // Rewrite base CLAUDE.md as user content + OMC:IMPORT block
    const userBase =
      '# My personal Claude.md\n\nUser customizations here.\n\n'
      + '<!-- OMC:IMPORT:START -->\n'
      + '@CLAUDE-omc.md\n'
      + '<!-- OMC:IMPORT:END -->\n';
    writeFileSync(claudeMdPath, userBase, 'utf8');

    // Sanity: both files exist before uninstall
    expect(existsSync(companionPath)).toBe(true);
    expect(readFileSync(claudeMdPath, 'utf8')).toContain('<!-- OMC:IMPORT:START -->');

    const result = await doUninstall({ preserveUserContent: true });

    // Companion file removed
    expect(existsSync(companionPath), 'CLAUDE-omc.md should be removed').toBe(false);

    // Base CLAUDE.md still exists with user content
    expect(existsSync(claudeMdPath), 'base CLAUDE.md should survive').toBe(true);
    const after = readFileSync(claudeMdPath, 'utf8');

    // User content preserved
    expect(after).toContain('# My personal Claude.md');
    expect(after).toContain('User customizations here.');

    // OMC:IMPORT block stripped
    expect(after, 'OMC:IMPORT:START should be stripped').not.toContain('<!-- OMC:IMPORT:START -->');
    expect(after, 'OMC:IMPORT:END should be stripped').not.toContain('<!-- OMC:IMPORT:END -->');
    expect(after, '@CLAUDE-omc.md reference should be stripped').not.toContain('@CLAUDE-omc.md');

    // preserved includes the base path
    expect(result.preserved).toContain(claudeMdPath);
  });

  // ── Test 10: --no-preserve deletes CLAUDE.md even with user content ───────
  it('Test 10: preserveUserContent=false deletes CLAUDE.md even when user content is present', async () => {
    await doInstall();

    // Append user content that would normally be preserved
    const claudeMdPath = join(tmpConfigDir, 'CLAUDE.md');
    const existing = readFileSync(claudeMdPath, 'utf8');
    writeFileSync(claudeMdPath, existing + '\n\n# User notes\nImportant stuff\n', 'utf8');

    // Explicit opt-out of preservation
    const result = await doUninstall({ preserveUserContent: false });

    // CLAUDE.md fully deleted regardless of user content
    expect(existsSync(claudeMdPath), 'CLAUDE.md should be deleted with --no-preserve').toBe(false);

    // `preserved` must NOT list it
    expect(result.preserved, 'preserved should not list CLAUDE.md when --no-preserve').not.toContain(claudeMdPath);
  });

  // ── Test 11: user's own agents/my-custom.md survives uninstall ────────────
  it('Test 11: user agent file outside plugin list is preserved', async () => {
    await doInstall();

    // Drop a user-authored agent file next to the OMC ones.
    // Name chosen to NOT collide with any OMC agent basename.
    const agentsDir = join(tmpConfigDir, 'agents');
    const userAgentPath = join(agentsDir, 'my-custom-user-agent.md');
    const userAgentContent =
      '---\n'
      + 'name: my-custom-user-agent\n'
      + 'description: A user-authored agent, not shipped by OMC\n'
      + '---\n\n'
      + '# My custom agent\n\nUser content.\n';
    writeFileSync(userAgentPath, userAgentContent, 'utf8');
    expect(existsSync(userAgentPath)).toBe(true);

    await doUninstall();

    // User agent file still exists, content intact
    expect(existsSync(userAgentPath), 'user agent file should survive uninstall').toBe(true);
    expect(readFileSync(userAgentPath, 'utf8')).toBe(userAgentContent);

    // And the parent dir must still exist (not rm -rf'd)
    expect(existsSync(agentsDir), 'agents/ dir should not be wiped').toBe(true);
  });

  // ── Test 12: user's own skills/my-skill/ survives uninstall ───────────────
  it('Test 12: user skill dir without OMC sentinel is preserved', async () => {
    await doInstall();

    // Create a user skill dir with a SKILL.md that lacks the OMC frontmatter
    // sentinel (no `---\n` prefix). This is an unusual but valid shape.
    // The test documents: if a user skill has NO frontmatter, it survives.
    // If it has the standard Claude Code frontmatter, the current sentinel
    // check is weak and may false-positive match — tracked in follow-up.
    const skillsDir = join(tmpConfigDir, 'skills');
    const userSkillDir = join(skillsDir, 'my-private-skill');
    const userSkillMd = join(userSkillDir, 'SKILL.md');
    mkdirSync(userSkillDir, { recursive: true });
    const userSkillContent =
      '# My private skill\n\n'
      + 'No frontmatter — not an OMC skill, not a standard Claude Code skill either.\n'
      + 'Uninstall must leave this alone.\n';
    writeFileSync(userSkillMd, userSkillContent, 'utf8');
    expect(existsSync(userSkillMd)).toBe(true);

    await doUninstall();

    // User skill dir + file intact
    expect(existsSync(userSkillDir), 'user skill dir should survive').toBe(true);
    expect(existsSync(userSkillMd), 'user SKILL.md should survive').toBe(true);
    expect(readFileSync(userSkillMd, 'utf8')).toBe(userSkillContent);
  });

  // ── Test 13: user hook entry in settings.json survives uninstall ──────────
  it('Test 13: user hook in settings.json is preserved while OMC hooks are removed', async () => {
    await doInstall();

    const settingsPath = join(tmpConfigDir, 'settings.json');
    expect(existsSync(settingsPath), 'install should have written settings.json').toBe(true);

    // Read installed settings.json + append a user-authored hook entry
    // that does NOT reference any OMC paths.
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
    };

    // Ensure hooks section exists and add a user hook group
    settings.hooks = settings.hooks ?? {};
    settings.hooks.PreToolUse = settings.hooks.PreToolUse ?? [];
    const userHookCommand = '/usr/local/bin/my-personal-audit-logger.sh';
    settings.hooks.PreToolUse.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: userHookCommand }],
    });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    await doUninstall();

    // settings.json must still exist (user has non-OMC content in it)
    expect(existsSync(settingsPath), 'settings.json should survive').toBe(true);

    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    // User hook still present by command substring match
    const allCommands: string[] = [];
    for (const group of Object.values(after.hooks ?? {})) {
      for (const entry of group) {
        for (const h of entry.hooks ?? []) {
          allCommands.push(h.command);
        }
      }
    }
    expect(
      allCommands.some((c) => c.includes('my-personal-audit-logger')),
      'user hook should survive',
    ).toBe(true);

    // And no OMC hooks remain
    const omcHookRemains = allCommands.some(
      (c) => c.includes('omc') || c.includes('keyword-detector') || c.includes('stop-continuation'),
    );
    expect(omcHookRemains, 'no OMC hooks should remain after uninstall').toBe(false);
  });
});
