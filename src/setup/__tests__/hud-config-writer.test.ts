/**
 * Tests for src/setup/hud-config-writer.ts
 *
 * Verifies `writeHudConfig`:
 *   - Creates .omc-config.json when missing.
 *   - Preserves unknown top-level keys (setupVersion, etc.) via shallow merge.
 *   - Preserves unrelated `hud.*` sub-keys when patching only `hud.elements`.
 *   - Merges `hud.elements` shallowly (existing keys survive unless overridden).
 *   - No-op for empty patch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeHudConfig } from '../hud-config-writer.js';

describe('writeHudConfig', () => {
  let configDir: string;
  let path: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'hud-config-'));
    path = join(configDir, '.omc-config.json');
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('creates .omc-config.json when missing', () => {
    expect(existsSync(path)).toBe(false);
    writeHudConfig({ cwd: true, gitBranch: true }, { configDir });
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      hud?: { elements?: Record<string, unknown> };
    };
    expect(parsed.hud?.elements).toEqual({ cwd: true, gitBranch: true });
  });

  it('preserves unknown top-level keys (setupVersion, setupCompleted, etc.)', () => {
    writeFileSync(
      path,
      JSON.stringify({
        setupVersion: '4.11.4',
        setupCompleted: '2026-04-11T00:00:00Z',
        executionMode: 'ultrawork',
        unknownFutureKey: { nested: true },
      }),
      'utf8',
    );

    writeHudConfig({ cwd: true }, { configDir });

    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(parsed.setupVersion).toBe('4.11.4');
    expect(parsed.setupCompleted).toBe('2026-04-11T00:00:00Z');
    expect(parsed.executionMode).toBe('ultrawork');
    expect(parsed.unknownFutureKey).toEqual({ nested: true });
    expect((parsed.hud as { elements: Record<string, unknown> }).elements.cwd).toBe(true);
  });

  it('merges hud.elements shallowly (existing keys survive unless overridden)', () => {
    writeFileSync(
      path,
      JSON.stringify({
        hud: {
          elements: {
            cwd: false,
            ralph: true,
            autopilot: true,
          },
        },
      }),
      'utf8',
    );

    writeHudConfig({ cwd: true, gitBranch: true }, { configDir });

    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      hud: { elements: Record<string, unknown> };
    };
    expect(parsed.hud.elements).toEqual({
      cwd: true,          // overridden
      gitBranch: true,    // added
      ralph: true,        // preserved
      autopilot: true,    // preserved
    });
  });

  it('preserves unrelated hud.* sub-keys (preset, thresholds, etc.)', () => {
    writeFileSync(
      path,
      JSON.stringify({
        hud: {
          preset: 'focused',
          thresholds: { contextWarning: 70 },
          elements: { cwd: false },
        },
      }),
      'utf8',
    );

    writeHudConfig({ cwd: true, gitStatus: true }, { configDir });

    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      hud: {
        preset?: string;
        thresholds?: Record<string, unknown>;
        elements: Record<string, unknown>;
      };
    };
    expect(parsed.hud.preset).toBe('focused');
    expect(parsed.hud.thresholds).toEqual({ contextWarning: 70 });
    expect(parsed.hud.elements).toEqual({ cwd: true, gitStatus: true });
  });

  it('works with SAFE_DEFAULTS.hud.elements patch', () => {
    writeFileSync(
      path,
      JSON.stringify({ setupVersion: '4.11.4' }),
      'utf8',
    );

    writeHudConfig(
      {
        cwd: true,
        gitBranch: true,
        gitStatus: true,
        sessionHealth: true,
        useBars: false,
        contextBar: false,
      },
      { configDir },
    );

    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      setupVersion: string;
      hud: { elements: Record<string, unknown> };
    };
    expect(parsed.setupVersion).toBe('4.11.4');
    expect(parsed.hud.elements).toEqual({
      cwd: true,
      gitBranch: true,
      gitStatus: true,
      sessionHealth: true,
      useBars: false,
      contextBar: false,
    });
  });

  it('handles empty patch gracefully (keeps existing elements)', () => {
    writeFileSync(
      path,
      JSON.stringify({ hud: { elements: { cwd: true } } }),
      'utf8',
    );
    writeHudConfig({}, { configDir });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      hud: { elements: Record<string, unknown> };
    };
    expect(parsed.hud.elements).toEqual({ cwd: true });
  });

  it('recovers from a corrupted .omc-config.json by treating it as {}', () => {
    writeFileSync(path, '{ not valid json', 'utf8');
    writeHudConfig({ cwd: true }, { configDir });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      hud: { elements: Record<string, unknown> };
    };
    expect(parsed.hud.elements).toEqual({ cwd: true });
  });
});
