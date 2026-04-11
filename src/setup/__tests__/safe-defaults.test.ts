/**
 * Tests for src/setup/safe-defaults.ts
 *
 * Pins the exact shape of SAFE_DEFAULTS so accidental drift (e.g.
 * "someone flipped starRepo to false") fails loudly. Also verifies
 * `dumpSafeDefaultsAsJson()` produces valid JSON that round-trips
 * through `loadPreset()`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SAFE_DEFAULTS, dumpSafeDefaultsAsJson } from '../safe-defaults.js';
import { loadPreset } from '../options.js';

describe('SAFE_DEFAULTS', () => {
  it('pins phases as {claude-md, infra, integrations, welcome}', () => {
    expect(Array.from(SAFE_DEFAULTS.phases).sort()).toEqual(
      ['claude-md', 'infra', 'integrations', 'welcome'].sort(),
    );
  });

  it('pins interactive=false and force=false and quiet=false', () => {
    expect(SAFE_DEFAULTS.interactive).toBe(false);
    expect(SAFE_DEFAULTS.force).toBe(false);
    expect(SAFE_DEFAULTS.quiet).toBe(false);
  });

  it('pins target=global, installStyle=overwrite, installCli=false', () => {
    expect(SAFE_DEFAULTS.target).toBe('global');
    expect(SAFE_DEFAULTS.installStyle).toBe('overwrite');
    expect(SAFE_DEFAULTS.installCli).toBe(false);
  });

  it('pins executionMode=ultrawork, taskTool=builtin, skipHud=false', () => {
    expect(SAFE_DEFAULTS.executionMode).toBe('ultrawork');
    expect(SAFE_DEFAULTS.taskTool).toBe('builtin');
    expect(SAFE_DEFAULTS.skipHud).toBe(false);
  });

  it('pins MCP curated server list + install-without-auth mode + user scope', () => {
    expect(SAFE_DEFAULTS.mcp.enabled).toBe(true);
    expect(SAFE_DEFAULTS.mcp.servers).toEqual(['context7', 'exa', 'filesystem', 'github']);
    expect(SAFE_DEFAULTS.mcp.credentials).toEqual({});
    expect(SAFE_DEFAULTS.mcp.onMissingCredentials).toBe('install-without-auth');
    expect(SAFE_DEFAULTS.mcp.scope).toBe('user');
  });

  it('pins teams enabled with auto display, 3 executor agents', () => {
    expect(SAFE_DEFAULTS.teams.enabled).toBe(true);
    expect(SAFE_DEFAULTS.teams.displayMode).toBe('auto');
    expect(SAFE_DEFAULTS.teams.agentCount).toBe(3);
    expect(SAFE_DEFAULTS.teams.agentType).toBe('executor');
  });

  it('pins starRepo=true and empty installerOptions', () => {
    expect(SAFE_DEFAULTS.starRepo).toBe(true);
    expect(SAFE_DEFAULTS.installerOptions).toEqual({});
  });

  it('pins HUD element overrides: cwd/git/sessionHealth on, useBars/contextBar off', () => {
    expect(SAFE_DEFAULTS.hud?.elements).toEqual({
      cwd: true,
      gitBranch: true,
      gitStatus: true,
      sessionHealth: true,
      useBars: false,
      contextBar: false,
    });
  });

  it('is frozen at the top level (accidental mutation throws)', () => {
    expect(Object.isFrozen(SAFE_DEFAULTS)).toBe(true);
  });
});

describe('dumpSafeDefaultsAsJson()', () => {
  it('produces valid JSON that parses into an object', () => {
    const raw = dumpSafeDefaultsAsJson();
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
  });

  it('serializes phases as an array (not a Set)', () => {
    const parsed = JSON.parse(dumpSafeDefaultsAsJson()) as { phases: unknown };
    expect(Array.isArray(parsed.phases)).toBe(true);
    expect(parsed.phases).toEqual(['claude-md', 'infra', 'integrations', 'welcome']);
  });

  it('output round-trips through loadPreset()', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'safe-defaults-roundtrip-'));
    try {
      const presetPath = join(tmp, 'safe-defaults.json');
      writeFileSync(presetPath, dumpSafeDefaultsAsJson(), 'utf8');
      const loaded = loadPreset(presetPath);
      // phases is hydrated back into a Set by loadPreset
      expect(loaded.phases).toBeInstanceOf(Set);
      expect(Array.from(loaded.phases!).sort()).toEqual(
        ['claude-md', 'infra', 'integrations', 'welcome'].sort(),
      );
      expect(loaded.target).toBe('global');
      expect(loaded.installStyle).toBe('overwrite');
      expect(loaded.mcp?.onMissingCredentials).toBe('install-without-auth');
      expect(loaded.mcp?.servers).toEqual(['context7', 'exa', 'filesystem', 'github']);
      expect(loaded.teams?.enabled).toBe(true);
      expect(loaded.starRepo).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ends with a trailing newline for shell piping', () => {
    const raw = dumpSafeDefaultsAsJson();
    expect(raw.endsWith('\n')).toBe(true);
  });
});

describe('SAFE_DEFAULTS vs DEFAULTS separation', () => {
  // This test is the canary: DEFAULTS is the minimal fallback; SAFE_DEFAULTS
  // is the opinionated out-of-box experience. They MUST remain separate so
  // programmatic callers relying on DEFAULTS never regress.
  let restore: () => void;

  beforeEach(() => {
    restore = () => {};
  });

  afterEach(() => {
    restore();
  });

  it('DEFAULTS.phases is {infra} — SAFE_DEFAULTS.phases is the full wizard set', async () => {
    const { DEFAULTS } = await import('../options.js');
    expect(Array.from(DEFAULTS.phases)).toEqual(['infra']);
    expect(DEFAULTS.phases.has('claude-md')).toBe(false);
    expect(SAFE_DEFAULTS.phases.has('claude-md')).toBe(true);
  });
});
