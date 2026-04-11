/**
 * Tests for src/setup/phases/phase1-claude-md.ts
 *
 * Phase 1 is a thin glue module around `installClaudeMd()`. Tests use
 * dependency injection (`Phase1Deps.installClaudeMd`) to stub out the
 * underlying installer — the full behavior of `installClaudeMd()` is
 * already covered by src/setup/__tests__/claude-md.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import type { InstallClaudeMdOptions, InstallClaudeMdResult } from '../claude-md.js';
import { runPhase1 } from '../phases/phase1-claude-md.js';
import { makeOptions } from './test-helpers.js';

function fakeResult(overrides: Partial<InstallClaudeMdResult> = {}): InstallClaudeMdResult {
  return {
    mode: 'local',
    installStyle: 'overwrite',
    targetPath: '/tmp/.claude/CLAUDE.md',
    skillTargetPath: '/tmp/.claude/skills/omc-reference/SKILL.md',
    companionPath: '/tmp/.claude/CLAUDE-omc.md',
    validationPath: '/tmp/.claude/CLAUDE.md',
    oldVersion: 'none',
    newVersion: '4.12.0',
    backupPath: null,
    backupDate: '',
    sourceLabel: '/plugin/docs/CLAUDE.md',
    pluginRoot: '/plugin',
    ...overrides,
  };
}

describe('runPhase1', () => {
  it('forwards target=local and installStyle=overwrite to installClaudeMd', async () => {
    const stub = vi.fn<(opts: InstallClaudeMdOptions) => Promise<InstallClaudeMdResult>>();
    stub.mockResolvedValue(fakeResult({ mode: 'local', installStyle: 'overwrite' }));

    const lines: string[] = [];
    const result = await runPhase1(
      makeOptions({ target: 'local', installStyle: 'overwrite' }),
      (line) => lines.push(line),
      { installClaudeMd: stub },
    );

    expect(stub).toHaveBeenCalledOnce();
    const call = stub.mock.calls[0][0];
    expect(call.mode).toBe('local');
    expect(call.installStyle).toBe('overwrite');
    expect(typeof call.logger).toBe('function');

    expect(result.mode).toBe('local');
    expect(result.installStyle).toBe('overwrite');
    expect(result.newVersion).toBe('4.12.0');
  });

  it('forwards target=global and installStyle=preserve to installClaudeMd', async () => {
    const stub = vi.fn<(opts: InstallClaudeMdOptions) => Promise<InstallClaudeMdResult>>();
    stub.mockResolvedValue(
      fakeResult({
        mode: 'global',
        installStyle: 'preserve',
        targetPath: '/home/me/.claude/CLAUDE.md',
        backupPath: '/home/me/.claude/CLAUDE.md.backup.2026-04-11_120000',
        oldVersion: '4.11.0',
        newVersion: '4.12.0',
      }),
    );

    const result = await runPhase1(
      makeOptions({ target: 'global', installStyle: 'preserve' }),
      () => { /* silent */ },
      { installClaudeMd: stub },
    );

    const call = stub.mock.calls[0][0];
    expect(call.mode).toBe('global');
    expect(call.installStyle).toBe('preserve');

    expect(result.backupPath).toBe('/home/me/.claude/CLAUDE.md.backup.2026-04-11_120000');
    expect(result.oldVersion).toBe('4.11.0');
    expect(result.newVersion).toBe('4.12.0');
  });

  it('passes the logger through to installClaudeMd so phase 1 output is captured', async () => {
    const stub = vi.fn<(opts: InstallClaudeMdOptions) => Promise<InstallClaudeMdResult>>(
      async (opts) => {
        opts.logger?.('Installed CLAUDE.md (fresh)');
        opts.logger?.('Plugin verified');
        return fakeResult();
      },
    );

    const lines: string[] = [];
    await runPhase1(makeOptions(), (line) => lines.push(line), { installClaudeMd: stub });

    expect(lines).toContain('Installed CLAUDE.md (fresh)');
    expect(lines).toContain('Plugin verified');
  });

  it('returns the minimal Phase1Result shape (no extra fields leaked)', async () => {
    const stub = vi.fn<(opts: InstallClaudeMdOptions) => Promise<InstallClaudeMdResult>>();
    stub.mockResolvedValue(
      fakeResult({
        mode: 'local',
        installStyle: 'overwrite',
        targetPath: '/tmp/.claude/CLAUDE.md',
        backupPath: null,
        oldVersion: 'none',
        newVersion: '4.12.0',
      }),
    );

    const result = await runPhase1(makeOptions(), () => { /* silent */ }, {
      installClaudeMd: stub,
    });

    expect(Object.keys(result).sort()).toEqual(
      ['backupPath', 'installStyle', 'mode', 'newVersion', 'oldVersion', 'targetPath'].sort(),
    );
  });

  it('propagates errors from installClaudeMd to the caller', async () => {
    const stub = vi.fn<(opts: InstallClaudeMdOptions) => Promise<InstallClaudeMdResult>>();
    stub.mockRejectedValue(new Error('Refusing to write CLAUDE.md because the destination is a symlink'));

    await expect(runPhase1(makeOptions(), () => { /* silent */ }, { installClaudeMd: stub }))
      .rejects.toThrow('Refusing to write CLAUDE.md');
  });

  it('forwards test-only overrides (configDir, cwd, pluginRoot, fetchImpl) to installClaudeMd', async () => {
    const stub = vi.fn<(opts: InstallClaudeMdOptions) => Promise<InstallClaudeMdResult>>();
    stub.mockResolvedValue(fakeResult());
    const fakeFetch = vi.fn<typeof fetch>();

    await runPhase1(makeOptions(), () => { /* silent */ }, {
      installClaudeMd: stub,
      configDir: '/tmp/cfg',
      cwd: '/tmp/wd',
      pluginRoot: '/tmp/plugin',
      fetchImpl: fakeFetch,
    });

    const call = stub.mock.calls[0][0];
    expect(call.configDir).toBe('/tmp/cfg');
    expect(call.cwd).toBe('/tmp/wd');
    expect(call.pluginRoot).toBe('/tmp/plugin');
    expect(call.fetchImpl).toBe(fakeFetch);
  });
});
