/**
 * Real commander-pipeline tests for a root-level `--plugin-dir <path>` placed
 * *before* the subcommand, which is the ordering CONTRIBUTING and the READMEs
 * document:
 *
 *   omc --plugin-dir "$PWD" setup --plugin-dir-mode
 *
 * The installer and the launch path are both mocked, so nothing touches the
 * filesystem and no Claude process is spawned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'path';
import { OMC_PLUGIN_ROOT_ENV } from '../../lib/env-vars.js';

// Tell src/cli/index.ts not to auto-parse process.argv on import.
process.env.OMC_CLI_SKIP_PARSE = '1';

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

vi.mock('../../features/auto-update.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/auto-update.js')>(
    '../../features/auto-update.js'
  );
  return {
    ...actual,
    getInstalledVersion: () => ({ version: 'test', installPath: '/tmp' }),
  };
});

// Bare `omc ...` falls through to launchCommand; keep it from spawning Claude.
const launchMock = vi.fn(async () => {});
vi.mock('../launch.js', async () => {
  const actual = await vi.importActual<typeof import('../launch.js')>('../launch.js');
  return { ...actual, launchCommand: launchMock };
});

const PLUGIN_DIR = '/tmp/omc-root-plugin-dir-routing';
const ORIG_OMC_PLUGIN_ROOT = process.env[OMC_PLUGIN_ROOT_ENV];

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  installMock.mockClear();
  launchMock.mockClear();
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

async function run(argv: string[]): Promise<void> {
  // Fresh commander program per case: commander keeps option values on the
  // Command instance and does not reset them between parseAsync calls.
  vi.resetModules();
  const { buildProgram } = await import('../index.js');
  await buildProgram().parseAsync(argv, { from: 'user' });
}

function lastInstallOptions(): Record<string, unknown> {
  expect(installMock).toHaveBeenCalled();
  const calls = installMock.mock.calls;
  return (calls[calls.length - 1] as unknown as [Record<string, unknown>])[0];
}

describe('root --plugin-dir before a subcommand', () => {
  it('dispatches to setup instead of falling through to a Claude launch', async () => {
    await run(['--plugin-dir', PLUGIN_DIR, 'setup']);

    expect(launchMock).not.toHaveBeenCalled();
    expect(installMock).toHaveBeenCalled();
  });

  it('exports the plugin root so setup auto-detects plugin-dir mode', async () => {
    await run(['--plugin-dir', PLUGIN_DIR, 'setup']);

    expect(process.env[OMC_PLUGIN_ROOT_ENV]).toBe(PLUGIN_DIR);
    expect(lastInstallOptions().pluginDirMode).toBe(true);
  });

  it('runs the documented command', async () => {
    await run(['--plugin-dir', PLUGIN_DIR, 'setup', '--plugin-dir-mode']);

    expect(launchMock).not.toHaveBeenCalled();
    expect(lastInstallOptions().pluginDirMode).toBe(true);
  });

  it('resolves a relative path before exporting it', async () => {
    await run(['--plugin-dir', './rel-plugin-dir', 'setup']);

    expect(process.env[OMC_PLUGIN_ROOT_ENV]).toBe(resolve('./rel-plugin-dir'));
  });

  it('still reaches launch when there is no subcommand', async () => {
    await run(['--plugin-dir', PLUGIN_DIR]);

    expect(launchMock).toHaveBeenCalled();
    expect(installMock).not.toHaveBeenCalled();
  });

  it('leaves a plain setup alone', async () => {
    await run(['setup']);

    expect(process.env[OMC_PLUGIN_ROOT_ENV]).toBeUndefined();
    expect(lastInstallOptions().pluginDirMode).toBe(false);
  });
});
