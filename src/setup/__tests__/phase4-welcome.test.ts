/**
 * Tests for src/setup/phases/phase4-welcome.ts
 *
 * Phase 4 logs one of two welcome templates (new vs 2.x upgrade),
 * optionally stars the repo via `gh`, then calls `completeSetup()`.
 * Tests stub completeSetup and execFileSync via DI and use a tmpdir
 * for `detectIsUpgrade` fixture state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectIsUpgrade, runPhase4 } from '../phases/phase4-welcome.js';
import { makeOptions } from './test-helpers.js';

describe('detectIsUpgrade', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'phase4-detect-'));
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('returns false when .omc-config.json is missing', () => {
    expect(detectIsUpgrade(configDir)).toBe(false);
  });

  it('returns true when setupVersion starts with "2."', () => {
    writeFileSync(
      join(configDir, '.omc-config.json'),
      JSON.stringify({ setupVersion: '2.9.3' }),
      'utf8',
    );
    expect(detectIsUpgrade(configDir)).toBe(true);
  });

  it('returns false when setupVersion starts with "3." or later', () => {
    writeFileSync(
      join(configDir, '.omc-config.json'),
      JSON.stringify({ setupVersion: '4.12.0' }),
      'utf8',
    );
    expect(detectIsUpgrade(configDir)).toBe(false);
  });

  it('returns false when the file is not valid JSON', () => {
    writeFileSync(join(configDir, '.omc-config.json'), '{ not valid', 'utf8');
    expect(detectIsUpgrade(configDir)).toBe(false);
  });

  it('returns false when setupVersion key is missing', () => {
    writeFileSync(join(configDir, '.omc-config.json'), '{}', 'utf8');
    expect(detectIsUpgrade(configDir)).toBe(false);
  });
});

describe('runPhase4', () => {
  let configDir: string;
  let cwd: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'phase4-run-config-'));
    cwd = mkdtempSync(join(tmpdir(), 'phase4-run-cwd-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('logs the new-user welcome message when context.isUpgrade=false', async () => {
    const lines: string[] = [];
    const complete = vi.fn();
    const exec = vi.fn();

    await runPhase4(
      makeOptions(),
      (line) => lines.push(line),
      { isUpgrade: false },
      { completeSetup: complete, execFileSync: exec, configDir, cwd, version: '4.12.0' },
    );

    expect(lines.some((l) => l === 'OMC Setup Complete!')).toBe(true);
    expect(lines.some((l) => l.includes('MAGIC KEYWORDS'))).toBe(true);
    // Upgrade-only strings must NOT appear.
    expect(lines.some((l) => l.includes('Upgraded from 2.x'))).toBe(false);
    expect(lines.some((l) => l.includes('Your existing commands still work'))).toBe(false);

    expect(complete).toHaveBeenCalledWith('4.12.0', { cwd, configDir });
  });

  it('logs the upgrade welcome message when context.isUpgrade=true', async () => {
    const lines: string[] = [];
    const complete = vi.fn();

    await runPhase4(
      makeOptions(),
      (line) => lines.push(line),
      { isUpgrade: true },
      { completeSetup: complete, execFileSync: vi.fn(), configDir, cwd, version: '4.12.0' },
    );

    expect(lines.some((l) => l === 'OMC Setup Complete! (Upgraded from 2.x)')).toBe(true);
    expect(lines.some((l) => l.includes('Your existing commands still work'))).toBe(true);
    // New-user-only intro must NOT appear.
    expect(lines.some((l) => l === 'OMC Setup Complete!')).toBe(false);
  });

  it('auto-detects upgrade state from configDir when context.isUpgrade is undefined', async () => {
    writeFileSync(
      join(configDir, '.omc-config.json'),
      JSON.stringify({ setupVersion: '2.9.3' }),
      'utf8',
    );

    const lines: string[] = [];
    await runPhase4(
      makeOptions(),
      (line) => lines.push(line),
      {}, // no isUpgrade
      { completeSetup: vi.fn(), execFileSync: vi.fn(), configDir, cwd, version: '4.12.0' },
    );

    expect(lines.some((l) => l.includes('Upgraded from 2.x'))).toBe(true);
  });

  it('calls `gh repo star` when starRepo=true and swallows gh failures', async () => {
    const exec = vi.fn(() => {
      throw new Error('gh: command not found');
    });

    const lines: string[] = [];
    await expect(
      runPhase4(
        makeOptions({ starRepo: true }),
        (line) => lines.push(line),
        { isUpgrade: false },
        { completeSetup: vi.fn(), execFileSync: exec, configDir, cwd, version: '4.12.0' },
      ),
    ).resolves.toBeUndefined();

    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['repo', 'star', 'Yeachan-Heo/oh-my-claudecode'],
      { stdio: 'pipe' },
    );
    // No thank-you line because gh threw.
    expect(lines.some((l) => l.includes('Starred'))).toBe(false);
  });

  it('logs a thank-you line when gh repo star succeeds', async () => {
    const exec = vi.fn(() => Buffer.from(''));

    const lines: string[] = [];
    await runPhase4(
      makeOptions({ starRepo: true }),
      (line) => lines.push(line),
      { isUpgrade: false },
      { completeSetup: vi.fn(), execFileSync: exec, configDir, cwd, version: '4.12.0' },
    );

    expect(lines.some((l) => l.includes('Starred Yeachan-Heo/oh-my-claudecode'))).toBe(true);
  });

  it('does not call gh when starRepo=false', async () => {
    const exec = vi.fn();
    await runPhase4(
      makeOptions({ starRepo: false }),
      () => { /* silent */ },
      { isUpgrade: false },
      { completeSetup: vi.fn(), execFileSync: exec, configDir, cwd, version: '4.12.0' },
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it('passes the injected version to completeSetup', async () => {
    const complete = vi.fn();
    await runPhase4(
      makeOptions(),
      () => { /* silent */ },
      { isUpgrade: false },
      { completeSetup: complete, execFileSync: vi.fn(), configDir, cwd, version: '9.9.9-test' },
    );
    expect(complete).toHaveBeenCalledWith('9.9.9-test', { cwd, configDir });
  });
});
