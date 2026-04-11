/**
 * Tests for `config-context.ts` — CLAUDE_CONFIG_DIR awareness for the
 * interactive setup wizard.
 *
 * Contract under test:
 *   - resolveConfigContext() honours CLAUDE_CONFIG_DIR when set, falls
 *     back to ~/.claude otherwise, and flags `envVarSet` accordingly.
 *   - resolveConfigContext() computes the concrete file lists that each
 *     target choice would touch.
 *   - formatConfigBanner() emits a banner containing the configDir, the
 *     env var status, and the per-target file lists.
 *   - describeTargetOption() emits the right per-target description with
 *     the resolved absolute path and (for global + env var set) the
 *     CLAUDE_CONFIG_DIR profile hint.
 *
 * Strategy: call the pure helpers directly with injected overrides so we
 * never mutate process.env. Each test is hermetic.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  describeInstallStyleOption,
  describeTargetOption,
  formatConfigBanner,
  resolveConfigContext,
} from '../config-context.js';

describe('resolveConfigContext', () => {
  const originalEnv = process.env.CLAUDE_CONFIG_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalEnv;
    }
  });

  it('default profile: no CLAUDE_CONFIG_DIR → isDefault=true, envVarSet=false', () => {
    const ctx = resolveConfigContext({
      configDir: '/fixture/home/.claude-default',
      cwd: '/repo',
      envVarValue: undefined,
    });

    expect(ctx.configDir).toBe('/fixture/home/.claude-default');
    expect(ctx.isDefault).toBe(true);
    expect(ctx.envVarSet).toBe(false);
    expect(ctx.envVarValue).toBeUndefined();
    expect(ctx.projectDir).toBe('/repo');
  });

  it('custom profile: CLAUDE_CONFIG_DIR set → isDefault=false, envVarSet=true', () => {
    const ctx = resolveConfigContext({
      configDir: '/fixture/home/.claude-work',
      cwd: '/repo',
      envVarValue: '/fixture/home/.claude-work',
    });

    expect(ctx.configDir).toBe('/fixture/home/.claude-work');
    expect(ctx.isDefault).toBe(false);
    expect(ctx.envVarSet).toBe(true);
    expect(ctx.envVarValue).toBe('/fixture/home/.claude-work');
  });

  it('localFiles contains .claude/CLAUDE.md, git exclude, omc-reference skill under cwd', () => {
    const ctx = resolveConfigContext({
      configDir: '/fixture/home/.claude-default',
      cwd: '/fixture/project/repo',
      envVarValue: undefined,
    });

    expect(ctx.localFiles).toContain('/fixture/project/repo/.claude/CLAUDE.md');
    expect(ctx.localFiles).toContain('/fixture/project/repo/.git/info/exclude');
    expect(ctx.localFiles).toContain(
      '/fixture/project/repo/.claude/skills/omc-reference/SKILL.md',
    );
  });

  it('globalFiles contains CLAUDE.md, .omc-config.json, settings.json under configDir', () => {
    const ctx = resolveConfigContext({
      configDir: '/fixture/home/.claude-work',
      cwd: '/repo',
      envVarValue: '/fixture/home/.claude-work',
    });

    expect(ctx.globalFiles).toContain('/fixture/home/.claude-work/CLAUDE.md');
    expect(ctx.globalFiles).toContain('/fixture/home/.claude-work/.omc-config.json');
    expect(ctx.globalFiles).toContain('/fixture/home/.claude-work/settings.json');

    // Companion file only appears in globalFilesPreserve, not globalFiles.
    expect(ctx.globalFiles).not.toContain(
      '/fixture/home/.claude-work/CLAUDE-omc.md',
    );
    expect(ctx.globalFilesPreserve).toContain(
      '/fixture/home/.claude-work/CLAUDE-omc.md',
    );
  });

  it('reads CLAUDE_CONFIG_DIR from process.env when envVarValue not passed', () => {
    process.env.CLAUDE_CONFIG_DIR = '/from/env';
    const ctx = resolveConfigContext({
      configDir: '/from/env',
      cwd: '/repo',
      // envVarValue omitted → falls back to process.env
    });
    expect(ctx.envVarSet).toBe(true);
    expect(ctx.envVarValue).toBe('/from/env');
  });

  it('envVarValue override wins over process.env (test hygiene)', () => {
    process.env.CLAUDE_CONFIG_DIR = '/from/env';
    const ctx = resolveConfigContext({
      configDir: '/injected',
      cwd: '/repo',
      envVarValue: undefined, // explicitly signal "no env var"
    });
    expect(ctx.envVarSet).toBe(false);
    expect(ctx.envVarValue).toBeUndefined();
  });
});

describe('formatConfigBanner', () => {
  const withDefaults = resolveConfigContext({
    configDir: '/fixture/home/.claude-default',
    cwd: '/repo',
    envVarValue: undefined,
  });

  const withEnvVar = resolveConfigContext({
    configDir: '/fixture/home/.claude-alt',
    cwd: '/fixture/project/myapp',
    envVarValue: '/fixture/home/.claude-alt',
  });

  it('default profile banner announces the default + shows files', () => {
    const banner = formatConfigBanner(withDefaults, { colorEnabled: false });

    expect(banner).toContain('omc setup');
    expect(banner).toContain('/fixture/home/.claude-default');
    expect(banner).toContain('default');
    expect(banner).toContain('CLAUDE_CONFIG_DIR not set');
    expect(banner).toContain('/repo/.claude/CLAUDE.md');
    expect(banner).toContain('/fixture/home/.claude-default/CLAUDE.md');
    expect(banner).toContain('Ctrl-C to abort');
  });

  it('custom profile banner flags CLAUDE_CONFIG_DIR', () => {
    const banner = formatConfigBanner(withEnvVar, { colorEnabled: false });

    expect(banner).toContain('/fixture/home/.claude-alt');
    expect(banner).toContain('from CLAUDE_CONFIG_DIR');
    expect(banner).toContain('/fixture/project/myapp');
    expect(banner).toContain('/fixture/project/myapp/.claude/CLAUDE.md');
    expect(banner).toContain('/fixture/home/.claude-alt/CLAUDE.md');
    expect(banner).toContain('/fixture/home/.claude-alt/.omc-config.json');
    expect(banner).toContain('/fixture/home/.claude-alt/settings.json');
  });

  it('banner mentions the --preserve companion path under a parenthetical', () => {
    const banner = formatConfigBanner(withEnvVar, { colorEnabled: false });

    // Preserve-mode only writes CLAUDE-omc.md; banner should flag it.
    expect(banner).toContain('CLAUDE-omc.md');
    expect(banner).toContain('--preserve');
  });

  // --- ANSI color -----------------------------------------------------------

  it('colorEnabled=true wraps the profile line in ANSI red escape sequences', () => {
    const banner = formatConfigBanner(withEnvVar, { colorEnabled: true });

    // Red ANSI sequence (`\x1b[31m`) must bracket the profile path.
    expect(banner).toContain('\x1b[31m');
    expect(banner).toContain('\x1b[0m');

    // The profile path is inside the red span.
    const profileIndex = banner.indexOf('/fixture/home/.claude-alt');
    const openIndex = banner.indexOf('\x1b[31m');
    const closeIndex = banner.indexOf('\x1b[0m');
    expect(openIndex).toBeLessThan(profileIndex);
    expect(closeIndex).toBeGreaterThan(profileIndex);
  });

  it('colorEnabled=false emits plain text (no ANSI codes)', () => {
    const banner = formatConfigBanner(withEnvVar, { colorEnabled: false });

    expect(banner).not.toContain('\x1b[');
  });

  it('only the profile line is colored — other lines stay plain', () => {
    const banner = formatConfigBanner(withEnvVar, { colorEnabled: true });

    // "Project dir:" line must NOT be wrapped in red.
    const projectLine = banner
      .split('\n')
      .find((l) => l.startsWith('Project dir:'));
    expect(projectLine).toBeDefined();
    expect(projectLine).not.toContain('\x1b[31m');
  });
});

// ---------------------------------------------------------------------------
// describeInstallStyleOption — Q2 path-aware descriptions
// ---------------------------------------------------------------------------

describe('describeInstallStyleOption', () => {
  const ctx = resolveConfigContext({
    configDir: '/fixture/home/.claude-alt',
    cwd: '/fixture/project/myapp',
    envVarValue: '/fixture/home/.claude-alt',
  });

  it('overwrite mode names the base CLAUDE.md path explicitly', () => {
    const desc = describeInstallStyleOption(ctx, 'overwrite');

    expect(desc).toContain('/fixture/home/.claude-alt/CLAUDE.md');
    expect(desc).toContain('Overwrites');
  });

  it('preserve mode names both base CLAUDE.md and companion CLAUDE-omc.md paths', () => {
    const desc = describeInstallStyleOption(ctx, 'preserve');

    expect(desc).toContain('/fixture/home/.claude-alt/CLAUDE.md');
    expect(desc).toContain('/fixture/home/.claude-alt/CLAUDE-omc.md');
    expect(desc).toContain('preserves');
    expect(desc).toContain('companion');
  });

  it('default profile: paths come from ~/.claude without env hint', () => {
    const defaultCtx = resolveConfigContext({
      configDir: '/fixture/home/.claude-default',
      cwd: '/repo',
      envVarValue: undefined,
    });

    const overwrite = describeInstallStyleOption(defaultCtx, 'overwrite');
    expect(overwrite).toContain('/fixture/home/.claude-default/CLAUDE.md');

    const preserve = describeInstallStyleOption(defaultCtx, 'preserve');
    expect(preserve).toContain('/fixture/home/.claude-default/CLAUDE.md');
    expect(preserve).toContain('/fixture/home/.claude-default/CLAUDE-omc.md');
  });
});

describe('describeTargetOption', () => {
  const defaultCtx = resolveConfigContext({
    configDir: '/fixture/home/.claude-default',
    cwd: '/repo',
    envVarValue: undefined,
  });

  const customCtx = resolveConfigContext({
    configDir: '/fixture/home/.claude-alt',
    cwd: '/repo',
    envVarValue: '/fixture/home/.claude-alt',
  });

  it('local option: shows the repo-scoped path, labels it project-scoped', () => {
    const desc = describeTargetOption(defaultCtx, 'local');
    expect(desc).toContain('/repo/.claude/CLAUDE.md');
    expect(desc).toContain('project-scoped');
  });

  it('global option (default profile): shows configDir, no env var hint', () => {
    const desc = describeTargetOption(defaultCtx, 'global');
    expect(desc).toContain('/fixture/home/.claude-default/CLAUDE.md');
    expect(desc).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('global option (custom profile): shows env var hint in parenthesis', () => {
    const desc = describeTargetOption(customCtx, 'global');
    expect(desc).toContain('/fixture/home/.claude-alt/CLAUDE.md');
    expect(desc).toContain('CLAUDE_CONFIG_DIR profile');
    expect(desc).toContain('/fixture/home/.claude-alt');
  });
});
