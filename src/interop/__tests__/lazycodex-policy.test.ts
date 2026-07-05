import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyLazyCodexPolicy,
  createLazyCodexPolicy,
  type LazyCodexPolicyEffectName,
} from '../lazycodex-policy.js';

const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'omc-lazycodex-policy-'));
  tempHomes.push(home);
  return home;
}

afterEach(() => {
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe('LazyCodex policy gates', () => {
  it('disables LazyCodex-derived telemetry, auto-update, and global Claude mutation by default', () => {
    // Given
    const home = makeTempHome();
    const calls: LazyCodexPolicyEffectName[] = [];
    const policy = createLazyCodexPolicy({
      env: { HOME: home },
      config: undefined,
    });

    // When
    const report = applyLazyCodexPolicy(policy, {
      startAutoUpdate: () => calls.push('autoUpdate'),
      migrateGlobalClaudeConfig: () => calls.push('globalClaudeMutation'),
      sendTelemetry: () => calls.push('telemetry'),
    });

    // Then
    expect(policy.autoUpdate).toBe(false);
    expect(policy.globalClaudeMutation).toBe(false);
    expect(policy.telemetry).toBe(false);
    expect(policy.decisions.autoUpdate.source).toBe('default');
    expect(policy.decisions.globalClaudeMutation.source).toBe('default');
    expect(policy.decisions.telemetry.source).toBe('default');
    expect(policy.optInTrail).toEqual([]);
    expect(report.effects).toEqual({
      autoUpdate: false,
      globalClaudeMutation: false,
      telemetry: false,
    });
    expect(calls).toEqual([]);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('requires explicit config opt-in before enabling any LazyCodex-derived side effect', () => {
    // Given
    const home = makeTempHome();
    const calls: LazyCodexPolicyEffectName[] = [];
    const policy = createLazyCodexPolicy({
      env: { HOME: home },
      config: {
        lazycodex: {
          autoUpdate: true,
          globalClaudeMutation: true,
          telemetry: true,
        },
      },
    });

    // When
    const report = applyLazyCodexPolicy(policy, {
      startAutoUpdate: () => calls.push('autoUpdate'),
      migrateGlobalClaudeConfig: () => calls.push('globalClaudeMutation'),
      sendTelemetry: () => calls.push('telemetry'),
    });

    // Then
    expect(policy.autoUpdate).toBe(true);
    expect(policy.globalClaudeMutation).toBe(true);
    expect(policy.telemetry).toBe(true);
    expect(policy.optInTrail).toEqual([
      { feature: 'autoUpdate', source: 'config', key: 'lazycodex.autoUpdate' },
      {
        feature: 'globalClaudeMutation',
        source: 'config',
        key: 'lazycodex.globalClaudeMutation',
      },
      { feature: 'telemetry', source: 'config', key: 'lazycodex.telemetry' },
    ]);
    expect(report.effects).toEqual({
      autoUpdate: true,
      globalClaudeMutation: true,
      telemetry: true,
    });
    expect(calls).toEqual([
      'autoUpdate',
      'globalClaudeMutation',
      'telemetry',
    ]);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('accepts only explicit env opt-in values and treats malformed values as disabled data', () => {
    // Given
    const home = makeTempHome();
    const injectedPath = join(home, 'prompt-injection-ran');

    // When
    const policy = createLazyCodexPolicy({
      env: {
        HOME: home,
        OMC_LAZYCODEX_AUTO_UPDATE: '1',
        OMC_LAZYCODEX_GLOBAL_CLAUDE_MUTATION: 'true',
        OMC_LAZYCODEX_TELEMETRY: `yes; touch ${injectedPath}`,
      },
      config: undefined,
    });

    // Then
    expect(policy.autoUpdate).toBe(true);
    expect(policy.globalClaudeMutation).toBe(true);
    expect(policy.telemetry).toBe(false);
    expect(policy.decisions.telemetry.source).toBe('invalid-env');
    expect(policy.warnings).toContain(
      'OMC_LAZYCODEX_TELEMETRY must be one of: 1, true, yes, on, 0, false, no, off',
    );
    expect(policy.optInTrail).toEqual([
      { feature: 'autoUpdate', source: 'env', key: 'OMC_LAZYCODEX_AUTO_UPDATE' },
      {
        feature: 'globalClaudeMutation',
        source: 'env',
        key: 'OMC_LAZYCODEX_GLOBAL_CLAUDE_MUTATION',
      },
    ]);
    expect(existsSync(injectedPath)).toBe(false);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('keeps malformed config disabled instead of coercing strings or objects', () => {
    // Given
    const home = makeTempHome();

    // When
    const policy = createLazyCodexPolicy({
      env: { HOME: home },
      config: {
        lazycodex: {
          autoUpdate: 'true',
          globalClaudeMutation: { enabled: true },
          telemetry: '1',
        },
      },
    });

    // Then
    expect(policy.autoUpdate).toBe(false);
    expect(policy.globalClaudeMutation).toBe(false);
    expect(policy.telemetry).toBe(false);
    expect(policy.decisions.autoUpdate.source).toBe('invalid-config');
    expect(policy.decisions.globalClaudeMutation.source).toBe('invalid-config');
    expect(policy.decisions.telemetry.source).toBe('invalid-config');
    expect(policy.optInTrail).toEqual([]);
    expect(policy.warnings).toEqual([
      'lazycodex.autoUpdate must be a boolean when present',
      'lazycodex.globalClaudeMutation must be a boolean when present',
      'lazycodex.telemetry must be a boolean when present',
    ]);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('does not treat stale or unrelated .claude state as opt-in', () => {
    // Given
    const home = makeTempHome();
    const claudeDir = join(home, '.claude');
    const unrelatedFile = join(claudeDir, 'unrelated.json');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(unrelatedFile, '{"owner":"claude"}\n');

    // When
    const policy = createLazyCodexPolicy({
      env: { HOME: home },
      config: undefined,
    });

    // Then
    expect(policy.autoUpdate).toBe(false);
    expect(policy.globalClaudeMutation).toBe(false);
    expect(policy.telemetry).toBe(false);
    expect(policy.optInTrail).toEqual([]);
    expect(existsSync(unrelatedFile)).toBe(true);
  });

});
