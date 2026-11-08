/**
 * Real commander-pipeline tests for `omc setup --plugin-dir-mode` and the
 * OMC_PLUGIN_ROOT auto-detection precedence.
 *
 * These tests drive the *actual* commander program built by `src/cli/index.ts`
 * (via the exported `buildProgram()` helper) and assert on the `InstallOptions`
 * passed into `install()`. The installer module is mocked at module level so
 * nothing touches the filesystem.
 *
 * Cases (mirroring src/installer/__tests__/plugin-dir-mode.test.ts which
 * previously re-implemented this precedence logic in the test file itself):
 *
 *   1. --plugin-dir-mode flag                       → opts.pluginDirMode === true
 *   2. OMC_PLUGIN_ROOT env, no flag                 → opts.pluginDirMode === true + auto-detect log
 *   3. neither                                      → opts.pluginDirMode === false
 *   4. --plugin-dir-mode --no-plugin                → pluginDirMode=false, noPlugin=true, conflict warning
 *   5. OMC_PLUGIN_ROOT + --no-plugin                → pluginDirMode=false, noPlugin=true, conflict warning
 *   6. --plugin-dir-mode --force                    → pluginDirMode=true, force=true
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OMC_PLUGIN_ROOT_ENV } from '../../lib/env-vars.js';

// Tell src/cli/index.ts not to auto-parse process.argv on import.
process.env.OMC_CLI_SKIP_PARSE = '1';

// Capture every install() invocation made by the setup action.
const installMock = vi.fn(() => ({
  success: true,
  message: 'ok',
  installedAgents: [],
  installedCommands: [],
  installedSkills: [],
  hooksConfigured: true,
  hookConflicts: [],
  errors: [],
}));

vi.mock('../../installer/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../installer/index.js')>(
    '../../installer/index.js'
  );
  return {
    ...actual,
    install: installMock,
    isInstalled: () => true,
    getInstallInfo: () => ({ installed: true, version: 'test' }),
  };
});

// Stub auto-update so the setup action doesn't try to read real install state.
vi.mock('../../features/auto-update.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/auto-update.js')>(
    '../../features/auto-update.js'
  );
  return {
    ...actual,
    getInstalledVersion: () => ({ version: 'test', installPath: '/tmp' }),
  };
});

// Snapshot env so individual tests can mutate freely.
const ORIG_OMC_PLUGIN_ROOT = process.env[OMC_PLUGIN_ROOT_ENV];

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  installMock.mockClear();
  delete process.env[OMC_PLUGIN_ROOT_ENV];
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (ORIG_OMC_PLUGIN_ROOT === undefined) {
    delete process.env[OMC_PLUGIN_ROOT_ENV];
  } else {
    process.env[OMC_PLUGIN_ROOT_ENV] = ORIG_OMC_PLUGIN_ROOT;
  }
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

async function runSetup(extraArgs: string[]): Promise<void> {
  // Reset modules so each test gets a fresh commander program (commander
  // stores option values on the Command instance and does not reset them
  // between parseAsync calls, which would leak --plugin-dir-mode/--force
  // across tests).
  vi.resetModules();
  const { buildProgram } = await import('../index.js');
  const program = buildProgram();
  await program.parseAsync(['setup', ...extraArgs], { from: 'user' });
}

function lastInstallOptions(): Record<string, unknown> {
  expect(installMock).toHaveBeenCalled();
  const calls = installMock.mock.calls;
  const last = calls[calls.length - 1] as unknown as [Record<string, unknown>];
  return last[0];
}

function loggedText(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}

describe('omc setup commander pipeline — pluginDirMode precedence', () => {
  it('1. --plugin-dir-mode flag → pluginDirMode=true', async () => {
    await runSetup(['--plugin-dir-mode', '--quiet']);
    expect(lastInstallOptions().pluginDirMode).toBe(true);
    expect(lastInstallOptions().noPlugin).toBe(false);
  });

  it('2. OMC_PLUGIN_ROOT env, no flag → pluginDirMode auto-enabled with detection log', async () => {
    process.env[OMC_PLUGIN_ROOT_ENV] = '/tmp/foo';
    await runSetup([]);
    expect(lastInstallOptions().pluginDirMode).toBe(true);
    expect(loggedText()).toMatch(/Detected OMC_PLUGIN_ROOT/);
  });

  it('3. neither flag nor env → pluginDirMode=false', async () => {
    await runSetup(['--quiet']);
    expect(lastInstallOptions().pluginDirMode).toBe(false);
    expect(lastInstallOptions().noPlugin).toBe(false);
  });

  it('4. --plugin-dir-mode --no-plugin → noPlugin wins, conflict warning logged', async () => {
    await runSetup(['--plugin-dir-mode', '--no-plugin']);
    const opts = lastInstallOptions();
    expect(opts.pluginDirMode).toBe(false);
    expect(opts.noPlugin).toBe(true);
    expect(loggedText()).toMatch(/conflict/i);
  });

  it('5. OMC_PLUGIN_ROOT env + --no-plugin → noPlugin wins, conflict warning logged', async () => {
    process.env[OMC_PLUGIN_ROOT_ENV] = '/tmp/bar';
    await runSetup(['--no-plugin']);
    const opts = lastInstallOptions();
    expect(opts.pluginDirMode).toBe(false);
    expect(opts.noPlugin).toBe(true);
    expect(loggedText()).toMatch(/conflict/i);
  });

  it('6. --plugin-dir-mode --force → pluginDirMode=true, force=true', async () => {
    await runSetup(['--plugin-dir-mode', '--force', '--quiet']);
    const opts = lastInstallOptions();
    expect(opts.pluginDirMode).toBe(true);
    expect(opts.force).toBe(true);
  });
});
