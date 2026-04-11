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
      configDir: '/Users/alice/.claude',
      cwd: '/repo',
      envVarValue: undefined,
    });

    expect(ctx.configDir).toBe('/Users/alice/.claude');
    expect(ctx.isDefault).toBe(true);
    expect(ctx.envVarSet).toBe(false);
    expect(ctx.envVarValue).toBeUndefined();
    expect(ctx.projectDir).toBe('/repo');
  });

  it('custom profile: CLAUDE_CONFIG_DIR set → isDefault=false, envVarSet=true', () => {
    const ctx = resolveConfigContext({
      configDir: '/Users/alice/.claude-work',
      cwd: '/repo',
      envVarValue: '/Users/alice/.claude-work',
    });

    expect(ctx.configDir).toBe('/Users/alice/.claude-work');
    expect(ctx.isDefault).toBe(false);
    expect(ctx.envVarSet).toBe(true);
    expect(ctx.envVarValue).toBe('/Users/alice/.claude-work');
  });

  it('localFiles contains .claude/CLAUDE.md, git exclude, omc-reference skill under cwd', () => {
    const ctx = resolveConfigContext({
      configDir: '/Users/alice/.claude',
      cwd: '/home/alice/repo',
      envVarValue: undefined,
    });

    expect(ctx.localFiles).toContain('/home/alice/repo/.claude/CLAUDE.md');
    expect(ctx.localFiles).toContain('/home/alice/repo/.git/info/exclude');
    expect(ctx.localFiles).toContain(
      '/home/alice/repo/.claude/skills/omc-reference/SKILL.md',
    );
  });

  it('globalFiles contains CLAUDE.md, .omc-config.json, settings.json under configDir', () => {
    const ctx = resolveConfigContext({
      configDir: '/Users/alice/.claude-work',
      cwd: '/repo',
      envVarValue: '/Users/alice/.claude-work',
    });

    expect(ctx.globalFiles).toContain('/Users/alice/.claude-work/CLAUDE.md');
    expect(ctx.globalFiles).toContain('/Users/alice/.claude-work/.omc-config.json');
    expect(ctx.globalFiles).toContain('/Users/alice/.claude-work/settings.json');

    // Companion file only appears in globalFilesPreserve, not globalFiles.
    expect(ctx.globalFiles).not.toContain(
      '/Users/alice/.claude-work/CLAUDE-omc.md',
    );
    expect(ctx.globalFilesPreserve).toContain(
      '/Users/alice/.claude-work/CLAUDE-omc.md',
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
    configDir: '/Users/alice/.claude',
    cwd: '/repo',
    envVarValue: undefined,
  });

  const withEnvVar = resolveConfigContext({
    configDir: '/Users/peter/.claude-personal',
    cwd: '/Users/peter/code/myapp',
    envVarValue: '/Users/peter/.claude-personal',
  });

  it('default profile banner announces the default + shows files', () => {
    const banner = formatConfigBanner(withDefaults);

    expect(banner).toContain('omc setup');
    expect(banner).toContain('/Users/alice/.claude');
    expect(banner).toContain('default');
    expect(banner).toContain('CLAUDE_CONFIG_DIR not set');
    expect(banner).toContain('/repo/.claude/CLAUDE.md');
    expect(banner).toContain('/Users/alice/.claude/CLAUDE.md');
    expect(banner).toContain('Ctrl-C to abort');
  });

  it('custom profile banner flags CLAUDE_CONFIG_DIR', () => {
    const banner = formatConfigBanner(withEnvVar);

    expect(banner).toContain('/Users/peter/.claude-personal');
    expect(banner).toContain('from CLAUDE_CONFIG_DIR');
    expect(banner).toContain('/Users/peter/code/myapp');
    expect(banner).toContain('/Users/peter/code/myapp/.claude/CLAUDE.md');
    expect(banner).toContain('/Users/peter/.claude-personal/CLAUDE.md');
    expect(banner).toContain('/Users/peter/.claude-personal/.omc-config.json');
    expect(banner).toContain('/Users/peter/.claude-personal/settings.json');
  });

  it('banner mentions the --preserve companion path under a parenthetical', () => {
    const banner = formatConfigBanner(withEnvVar);

    // Preserve-mode only writes CLAUDE-omc.md; banner should flag it.
    expect(banner).toContain('CLAUDE-omc.md');
    expect(banner).toContain('--preserve');
  });
});

describe('describeTargetOption', () => {
  const defaultCtx = resolveConfigContext({
    configDir: '/Users/alice/.claude',
    cwd: '/repo',
    envVarValue: undefined,
  });

  const customCtx = resolveConfigContext({
    configDir: '/Users/peter/.claude-personal',
    cwd: '/repo',
    envVarValue: '/Users/peter/.claude-personal',
  });

  it('local option: shows the repo-scoped path, labels it project-scoped', () => {
    const desc = describeTargetOption(defaultCtx, 'local');
    expect(desc).toContain('/repo/.claude/CLAUDE.md');
    expect(desc).toContain('project-scoped');
  });

  it('global option (default profile): shows configDir, no env var hint', () => {
    const desc = describeTargetOption(defaultCtx, 'global');
    expect(desc).toContain('/Users/alice/.claude/CLAUDE.md');
    expect(desc).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('global option (custom profile): shows env var hint in parenthesis', () => {
    const desc = describeTargetOption(customCtx, 'global');
    expect(desc).toContain('/Users/peter/.claude-personal/CLAUDE.md');
    expect(desc).toContain('CLAUDE_CONFIG_DIR profile');
    expect(desc).toContain('/Users/peter/.claude-personal');
  });
});
