/**
 * Parity test: pinned legacy bash vs new TypeScript CLAUDE.md installer.
 *
 * Runs `tests/fixtures/legacy/setup-claude-md.sh.pre-refactor` and the new
 * `installClaudeMd()` against identical pre-state fixtures in paired tmpdirs,
 * then byte-compares the resulting CLAUDE.md content and filesystem side effects.
 *
 * Stdout byte-comparison is intentionally skipped: the TS implementation emits
 * extra lines (`reportPluginStatus`, `warnLegacyHooksInSettings`) not present in
 * the bash script.  What matters for parity is the on-disk result, not log lines.
 *
 * Skipped on Windows (bash unavailable).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installClaudeMd } from '../claude-md.js';

if (process.platform === 'win32') {
  describe.skip('setup-parity (Windows — bash unavailable)', () => {
    it('TODO', () => {});
  });
} else {
  // ─────────────────────────── shared fixtures ───────────────────────────

  const BASH_SCRIPT = resolve(
    __dirname,
    '../../../tests/fixtures/legacy/setup-claude-md.sh.pre-refactor',
  );

  /** Synthetic OMC content (with markers) used as the "canonical" CLAUDE.md. */
  const OMC_CONTENT_WRAPPED = [
    '<!-- OMC:START -->',
    '<!-- OMC:VERSION:4.99.0 -->',
    '# oh-my-claudecode',
    '',
    'Test OMC content for parity test.',
    '<!-- OMC:END -->',
    '',
  ].join('\n');

  const SKILL_CONTENT = '# omc-reference skill\nParity test skill content.\n';

  /** Create a minimal fake plugin-root that both bash and TS can consume. */
  function makePluginRoot(baseDir: string): string {
    const pluginRoot = join(baseDir, 'plugin-root');
    mkdirSync(join(pluginRoot, 'docs'), { recursive: true });
    mkdirSync(join(pluginRoot, 'skills', 'omc-reference'), { recursive: true });
    writeFileSync(join(pluginRoot, 'docs', 'CLAUDE.md'), OMC_CONTENT_WRAPPED, 'utf8');
    writeFileSync(
      join(pluginRoot, 'skills', 'omc-reference', 'SKILL.md'),
      SKILL_CONTENT,
      'utf8',
    );
    return pluginRoot;
  }

  /** Minimal env for the bash script (no real omc on PATH, controlled HOME). */
  function bashEnv(homeDir: string, pluginRoot: string): NodeJS.ProcessEnv {
    return {
      HOME: homeDir,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      TERM: 'dumb',
      LANG: 'C',
      LC_ALL: 'C',
    };
  }

  /** Run the pinned bash script; captures stdout + stderr; does NOT throw on failure. */
  function runBash(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync('bash', [BASH_SCRIPT, ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.status ?? 1,
    };
  }

  /** Run the TS installer with the same logical options; returns captured log lines. */
  async function runTs(
    opts: Parameters<typeof installClaudeMd>[0],
  ): Promise<{ stdout: string; exitCode: number; error?: string }> {
    const lines: string[] = [];
    try {
      await installClaudeMd({ ...opts, logger: (line) => lines.push(line) });
      return { stdout: lines.join('\n') + '\n', exitCode: 0 };
    } catch (err: unknown) {
      return {
        stdout: lines.join('\n') + '\n',
        exitCode: 1,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ──────────────────────── comparison helpers ───────────────────────────

  function readOrNull(p: string): string | null {
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  /**
   * List backup filenames in a directory (files matching `*.backup.*`).
   * Returns count only — timestamps make exact names non-comparable.
   */
  function countBackups(dir: string, basename: string): number {
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter(
      (f) => f.startsWith(basename) && f.includes('.backup.'),
    ).length;
  }

  /**
   * Normalize file content for comparison.
   * - Trims trailing whitespace: bash uses `printf '%s\n'` which appends a
   *   trailing newline after user content; TS trims via trimClaudeUserContent().
   */
  function norm(s: string | null): string | null {
    return s === null ? null : s.trimEnd();
  }

  function assertParity(
    scenario: string,
    bashDir: string,
    tsDir: string,
    paths: { claudeMd: string; skill: string; companion?: string; gitExclude?: string },
  ): void {
    const bashClaudeMd = norm(readOrNull(join(bashDir, paths.claudeMd)));
    const tsClaudeMd = norm(readOrNull(join(tsDir, paths.claudeMd)));
    expect(tsClaudeMd, `[${scenario}] CLAUDE.md content`).toBe(bashClaudeMd);

    const bashSkill = norm(readOrNull(join(bashDir, paths.skill)));
    const tsSkill = norm(readOrNull(join(tsDir, paths.skill)));
    expect(tsSkill, `[${scenario}] SKILL.md content`).toBe(bashSkill);

    if (paths.companion) {
      const bashCompanion = norm(readOrNull(join(bashDir, paths.companion)));
      const tsCompanion = norm(readOrNull(join(tsDir, paths.companion)));
      expect(tsCompanion, `[${scenario}] companion content`).toBe(bashCompanion);
    }

    if (paths.gitExclude) {
      const bashExclude = norm(readOrNull(join(bashDir, paths.gitExclude)));
      const tsExclude = norm(readOrNull(join(tsDir, paths.gitExclude)));
      expect(tsExclude, `[${scenario}] .git/info/exclude content`).toBe(bashExclude);
    }

    // Backup count must match (both create one or neither creates one).
    const claudeMdBase = paths.claudeMd.split('/').pop()!;
    const claudeMdParent = paths.claudeMd.includes('/')
      ? join(paths.claudeMd.split('/').slice(0, -1).join('/'))
      : '.';
    const bashBackups = countBackups(join(bashDir, claudeMdParent), claudeMdBase);
    const tsBackups = countBackups(join(tsDir, claudeMdParent), claudeMdBase);
    expect(tsBackups, `[${scenario}] backup count`).toBe(bashBackups);
  }

  // ──────────────────────────── test suite ──────────────────────────────

  let tmpBase: string;
  let pluginRoot: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'omc-parity-'));
    pluginRoot = makePluginRoot(tmpBase);
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('setup-parity: bash vs TypeScript CLAUDE.md installer', () => {
    // ── Scenario 1: fresh local install ─────────────────────────────────
    it('fresh local — creates .claude/CLAUDE.md with markers', async () => {
      const bashHome = join(tmpBase, 'bash-home');
      const tsHome = join(tmpBase, 'ts-home');
      mkdirSync(join(bashHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      mkdirSync(join(tsHome, '.claude', 'skills', 'omc-reference'), { recursive: true });

      const bashCwd = join(tmpBase, 'bash-project');
      const tsCwd = join(tmpBase, 'ts-project');
      mkdirSync(bashCwd, { recursive: true });
      mkdirSync(tsCwd, { recursive: true });

      const bashResult = runBash(['local'], bashCwd, bashEnv(bashHome, pluginRoot));
      expect(bashResult.exitCode, `bash stderr: ${bashResult.stderr}`).toBe(0);

      const tsResult = await runTs({
        mode: 'local',
        cwd: tsCwd,
        configDir: join(tsHome, '.claude'),
        pluginRoot,
        skipGitExclude: true,
      });
      expect(tsResult.exitCode, `ts error: ${tsResult.error}`).toBe(0);

      assertParity('fresh local', bashCwd, tsCwd, {
        claudeMd: '.claude/CLAUDE.md',
        skill: '.claude/skills/omc-reference/SKILL.md',
      });
    });

    // ── Scenario 2: fresh global overwrite ──────────────────────────────
    it('fresh global overwrite — creates ~/.claude/CLAUDE.md with markers', async () => {
      const bashHome = join(tmpBase, 'bash-home');
      const tsHome = join(tmpBase, 'ts-home');
      mkdirSync(join(bashHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      mkdirSync(join(tsHome, '.claude', 'skills', 'omc-reference'), { recursive: true });

      const bashResult = runBash(['global', 'overwrite'], bashHome, bashEnv(bashHome, pluginRoot));
      expect(bashResult.exitCode, `bash stderr: ${bashResult.stderr}`).toBe(0);

      const tsResult = await runTs({
        mode: 'global',
        installStyle: 'overwrite',
        configDir: join(tsHome, '.claude'),
        pluginRoot,
      });
      expect(tsResult.exitCode, `ts error: ${tsResult.error}`).toBe(0);

      assertParity('fresh global overwrite', bashHome, tsHome, {
        claudeMd: '.claude/CLAUDE.md',
        skill: '.claude/skills/omc-reference/SKILL.md',
      });
    });

    // ── Scenario 3: fresh global preserve ───────────────────────────────
    it('fresh global preserve — fresh target, behaves like overwrite (no existing file)', async () => {
      const bashHome = join(tmpBase, 'bash-home');
      const tsHome = join(tmpBase, 'ts-home');
      mkdirSync(join(bashHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      mkdirSync(join(tsHome, '.claude', 'skills', 'omc-reference'), { recursive: true });

      const bashResult = runBash(['global', 'preserve'], bashHome, bashEnv(bashHome, pluginRoot));
      expect(bashResult.exitCode, `bash stderr: ${bashResult.stderr}`).toBe(0);

      const tsResult = await runTs({
        mode: 'global',
        installStyle: 'preserve',
        configDir: join(tsHome, '.claude'),
        pluginRoot,
      });
      expect(tsResult.exitCode, `ts error: ${tsResult.error}`).toBe(0);

      assertParity('fresh global preserve', bashHome, tsHome, {
        claudeMd: '.claude/CLAUDE.md',
        skill: '.claude/skills/omc-reference/SKILL.md',
      });
    });

    // ── Scenario 4: existing same-version ───────────────────────────────
    it('existing same-version — CLAUDE.md updated in-place (idempotent merge)', async () => {
      const existing = [
        '<!-- OMC:START -->',
        '<!-- OMC:VERSION:4.99.0 -->',
        '# oh-my-claudecode',
        '',
        'Old OMC content.',
        '<!-- OMC:END -->',
        '',
        '<!-- User customizations -->',
        'My custom note.',
        '',
      ].join('\n');

      const bashHome = join(tmpBase, 'bash-home');
      const tsHome = join(tmpBase, 'ts-home');
      mkdirSync(join(bashHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      mkdirSync(join(tsHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      writeFileSync(join(bashHome, '.claude', 'CLAUDE.md'), existing, 'utf8');
      writeFileSync(join(tsHome, '.claude', 'CLAUDE.md'), existing, 'utf8');

      const bashResult = runBash(['global', 'overwrite'], bashHome, bashEnv(bashHome, pluginRoot));
      expect(bashResult.exitCode, `bash stderr: ${bashResult.stderr}`).toBe(0);

      const tsResult = await runTs({
        mode: 'global',
        installStyle: 'overwrite',
        configDir: join(tsHome, '.claude'),
        pluginRoot,
      });
      expect(tsResult.exitCode, `ts error: ${tsResult.error}`).toBe(0);

      assertParity('existing same-version', bashHome, tsHome, {
        claudeMd: '.claude/CLAUDE.md',
        skill: '.claude/skills/omc-reference/SKILL.md',
      });
    });

    // ── Scenario 5: existing old-version ────────────────────────────────
    it('existing old-version — OMC section updated, user content preserved', async () => {
      const existing = [
        '<!-- OMC:START -->',
        '<!-- OMC:VERSION:1.0.0 -->',
        '# oh-my-claudecode',
        '',
        'Very old OMC content.',
        '<!-- OMC:END -->',
        '',
        '<!-- User customizations -->',
        'Keep this user note.',
        '',
      ].join('\n');

      const bashHome = join(tmpBase, 'bash-home');
      const tsHome = join(tmpBase, 'ts-home');
      mkdirSync(join(bashHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      mkdirSync(join(tsHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      writeFileSync(join(bashHome, '.claude', 'CLAUDE.md'), existing, 'utf8');
      writeFileSync(join(tsHome, '.claude', 'CLAUDE.md'), existing, 'utf8');

      const bashResult = runBash(['global', 'overwrite'], bashHome, bashEnv(bashHome, pluginRoot));
      expect(bashResult.exitCode, `bash stderr: ${bashResult.stderr}`).toBe(0);

      const tsResult = await runTs({
        mode: 'global',
        installStyle: 'overwrite',
        configDir: join(tsHome, '.claude'),
        pluginRoot,
      });
      expect(tsResult.exitCode, `ts error: ${tsResult.error}`).toBe(0);

      assertParity('existing old-version', bashHome, tsHome, {
        claudeMd: '.claude/CLAUDE.md',
        skill: '.claude/skills/omc-reference/SKILL.md',
      });
    });

    // ── Scenario 6: no-markers migration ────────────────────────────────
    it('no-markers migration — wraps existing content in OMC markers', async () => {
      const existing = '# My existing CLAUDE.md\n\nSome custom config here.\n';

      const bashHome = join(tmpBase, 'bash-home');
      const tsHome = join(tmpBase, 'ts-home');
      mkdirSync(join(bashHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      mkdirSync(join(tsHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      writeFileSync(join(bashHome, '.claude', 'CLAUDE.md'), existing, 'utf8');
      writeFileSync(join(tsHome, '.claude', 'CLAUDE.md'), existing, 'utf8');

      const bashResult = runBash(['global', 'overwrite'], bashHome, bashEnv(bashHome, pluginRoot));
      expect(bashResult.exitCode, `bash stderr: ${bashResult.stderr}`).toBe(0);

      const tsResult = await runTs({
        mode: 'global',
        installStyle: 'overwrite',
        configDir: join(tsHome, '.claude'),
        pluginRoot,
      });
      expect(tsResult.exitCode, `ts error: ${tsResult.error}`).toBe(0);

      assertParity('no-markers migration', bashHome, tsHome, {
        claudeMd: '.claude/CLAUDE.md',
        skill: '.claude/skills/omc-reference/SKILL.md',
      });
    });

    // ── Scenario 7: corrupted markers ───────────────────────────────────
    it('corrupted markers — START without END → recovery with preserved content', async () => {
      const corrupted = [
        '<!-- OMC:START -->',
        'Some user content inside orphaned start.',
        'More content here.',
      ].join('\n');

      const bashHome = join(tmpBase, 'bash-home');
      const tsHome = join(tmpBase, 'ts-home');
      mkdirSync(join(bashHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      mkdirSync(join(tsHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      writeFileSync(join(bashHome, '.claude', 'CLAUDE.md'), corrupted, 'utf8');
      writeFileSync(join(tsHome, '.claude', 'CLAUDE.md'), corrupted, 'utf8');

      const bashResult = runBash(['global', 'overwrite'], bashHome, bashEnv(bashHome, pluginRoot));
      expect(bashResult.exitCode, `bash stderr: ${bashResult.stderr}`).toBe(0);

      const tsResult = await runTs({
        mode: 'global',
        installStyle: 'overwrite',
        configDir: join(tsHome, '.claude'),
        pluginRoot,
      });
      expect(tsResult.exitCode, `ts error: ${tsResult.error}`).toBe(0);

      // Known divergence: bash preserves the orphaned `<!-- OMC:START -->` in
      // the recovery section (uses raw OLD_CONTENT); TS strips it via
      // createLineAnchoredMarkerRegex() to prevent growth on repeated calls.
      // Assert invariants only: new OMC block is correct, recovery header present.
      const tsClaudeMd = readOrNull(join(tsHome, '.claude', 'CLAUDE.md'))!;
      const bashClaudeMd = readOrNull(join(bashHome, '.claude', 'CLAUDE.md'))!;
      expect(tsClaudeMd).toContain('<!-- OMC:START -->');
      expect(tsClaudeMd).toContain('<!-- OMC:END -->');
      expect(tsClaudeMd).toContain('Test OMC content for parity test.');
      expect(tsClaudeMd).toContain('<!-- User customizations (recovered from corrupted markers) -->');
      expect(tsClaudeMd).toContain('Some user content inside orphaned start.');
      // Both must have produced a valid result
      expect(bashClaudeMd).toContain('<!-- User customizations (recovered from corrupted markers) -->');

      // SKILL.md must match
      const tsSkill = norm(readOrNull(join(tsHome, '.claude', 'skills', 'omc-reference', 'SKILL.md')));
      const bashSkill = norm(readOrNull(join(bashHome, '.claude', 'skills', 'omc-reference', 'SKILL.md')));
      expect(tsSkill, '[corrupted markers] SKILL.md content').toBe(bashSkill);
    });

    // ── Scenario 8: symlink refusal ─────────────────────────────────────
    // bash only refuses symlinks in --preserve mode (calls ensure_not_symlink_path
    // only in that branch). TS refuses for ALL branches when the file exists.
    // Test the common case: global+preserve with a symlinked target.
    it('symlink refusal — global preserve refuses symlinked CLAUDE.md', async () => {
      const bashHome = join(tmpBase, 'bash-home');
      const tsHome = join(tmpBase, 'ts-home');
      mkdirSync(join(bashHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      mkdirSync(join(tsHome, '.claude', 'skills', 'omc-reference'), { recursive: true });

      // Create a no-markers file and symlink CLAUDE.md to it (preserve mode
      // enters the companion branch and calls ensure_not_symlink_path on TARGET)
      writeFileSync(join(bashHome, '.claude', 'real.md'), '# Existing content\n', 'utf8');
      writeFileSync(join(tsHome, '.claude', 'real.md'), '# Existing content\n', 'utf8');
      symlinkSync(
        join(bashHome, '.claude', 'real.md'),
        join(bashHome, '.claude', 'CLAUDE.md'),
      );
      symlinkSync(
        join(tsHome, '.claude', 'real.md'),
        join(tsHome, '.claude', 'CLAUDE.md'),
      );

      // Both bash (preserve branch) and TS must exit/throw non-zero
      const bashResult = runBash(['global', 'preserve'], bashHome, bashEnv(bashHome, pluginRoot));
      expect(bashResult.exitCode, `bash should exit non-zero on symlink; stderr: ${bashResult.stderr}`).not.toBe(0);

      const tsResult = await runTs({
        mode: 'global',
        installStyle: 'preserve',
        configDir: join(tsHome, '.claude'),
        pluginRoot,
      });
      expect(tsResult.exitCode, `ts should fail on symlink but got: ${tsResult.error}`).toBe(1);

      // Both should include "symlink" in their error output
      expect(bashResult.stderr.toLowerCase()).toContain('symlink');
      expect(tsResult.error?.toLowerCase()).toContain('symlink');
    });

    // ── Scenario 9: companion cleanup ───────────────────────────────────
    it('companion cleanup — global overwrite removes orphaned companion from prior preserve-mode install', async () => {
      const existing = [
        '<!-- OMC:START -->',
        '<!-- OMC:VERSION:4.98.0 -->',
        '# oh-my-claudecode',
        '',
        'Old content.',
        '<!-- OMC:END -->',
        '',
      ].join('\n');
      const orphanCompanion = '<!-- OMC:START -->\nOrphan content.\n<!-- OMC:END -->\n';

      const bashHome = join(tmpBase, 'bash-home');
      const tsHome = join(tmpBase, 'ts-home');
      mkdirSync(join(bashHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      mkdirSync(join(tsHome, '.claude', 'skills', 'omc-reference'), { recursive: true });
      writeFileSync(join(bashHome, '.claude', 'CLAUDE.md'), existing, 'utf8');
      writeFileSync(join(tsHome, '.claude', 'CLAUDE.md'), existing, 'utf8');
      writeFileSync(join(bashHome, '.claude', 'CLAUDE-omc.md'), orphanCompanion, 'utf8');
      writeFileSync(join(tsHome, '.claude', 'CLAUDE-omc.md'), orphanCompanion, 'utf8');

      const bashResult = runBash(['global', 'overwrite'], bashHome, bashEnv(bashHome, pluginRoot));
      expect(bashResult.exitCode, `bash stderr: ${bashResult.stderr}`).toBe(0);

      const tsResult = await runTs({
        mode: 'global',
        installStyle: 'overwrite',
        configDir: join(tsHome, '.claude'),
        pluginRoot,
      });
      expect(tsResult.exitCode, `ts error: ${tsResult.error}`).toBe(0);

      assertParity('companion cleanup', bashHome, tsHome, {
        claudeMd: '.claude/CLAUDE.md',
        skill: '.claude/skills/omc-reference/SKILL.md',
        companion: '.claude/CLAUDE-omc.md',
      });

      // Both should have removed the orphaned companion
      expect(
        existsSync(join(bashHome, '.claude', 'CLAUDE-omc.md')),
        'bash: orphaned companion should be removed',
      ).toBe(false);
      expect(
        existsSync(join(tsHome, '.claude', 'CLAUDE-omc.md')),
        'ts: orphaned companion should be removed',
      ).toBe(false);
    });
  });
}
