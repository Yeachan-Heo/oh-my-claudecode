/**
 * Tests for the plugin-presence check that gates the bare `omc setup`
 * safe-defaults path and the explicit `--wizard` path.
 *
 * The check fails with a clear error when neither CLAUDE_PLUGIN_ROOT nor
 * an installed OMC plugin root nor `--no-plugin` nor `--infra-only` is
 * present. It must NEVER fire for `--infra-only`, `--state-*`,
 * `--check-state`, `--claude-md-only`, or `--no-plugin`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Don't auto-parse process.argv when the CLI module is imported.
process.env.OMC_CLI_SKIP_PARSE = '1';

const hoisted = vi.hoisted(() => {
  const runSetupMock = vi.fn();
  const installMock = vi.fn();
  const isRunningAsPluginMock = vi.fn<() => boolean>(() => false);
  const getInstalledOmcPluginRootsMock = vi.fn<() => string[]>(() => []);
  return {
    runSetupMock,
    installMock,
    isRunningAsPluginMock,
    getInstalledOmcPluginRootsMock,
  };
});

vi.mock('../index.js', async () => {
  const actual = await vi.importActual<typeof import('../index.js')>(
    '../index.js',
  );
  return {
    ...actual,
    runSetup: hoisted.runSetupMock,
  };
});

vi.mock('../../installer/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../installer/index.js')>(
    '../../installer/index.js',
  );
  return {
    ...actual,
    install: hoisted.installMock,
    isInstalled: () => true,
    getInstallInfo: () => ({ installed: true, version: 'test' }),
    isRunningAsPlugin: hoisted.isRunningAsPluginMock,
    getInstalledOmcPluginRoots: hoisted.getInstalledOmcPluginRootsMock,
  };
});

vi.mock('../../features/auto-update.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/auto-update.js')>(
    '../../features/auto-update.js',
  );
  return {
    ...actual,
    getInstalledVersion: () => ({ version: 'test', installPath: '/tmp' }),
  };
});

const ORIG_CLAUDE_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
const ORIG_OMC_PLUGIN_ROOT = process.env.OMC_PLUGIN_ROOT;
const ORIG_ISTTY = process.stdin.isTTY;

class CaptureStderr {
  public output = '';
  write(chunk: string | Uint8Array): boolean {
    this.output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }
}

beforeEach(() => {
  hoisted.runSetupMock.mockReset();
  hoisted.runSetupMock.mockResolvedValue({
    success: true,
    phasesRun: ['infra'],
    phaseResults: {},
    warnings: [],
    errors: [],
    exitCode: 0,
  });
  hoisted.installMock.mockReset();
  hoisted.installMock.mockReturnValue({
    success: true,
    message: 'ok',
    installedAgents: [],
    installedCommands: [],
    installedSkills: [],
    hooksConfigured: true,
    hookConflicts: [],
    errors: [],
  });
  hoisted.isRunningAsPluginMock.mockReset();
  hoisted.isRunningAsPluginMock.mockReturnValue(false);
  hoisted.getInstalledOmcPluginRootsMock.mockReset();
  hoisted.getInstalledOmcPluginRootsMock.mockReturnValue([]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.OMC_PLUGIN_ROOT;
  // Non-TTY so --interactive/--wizard paths don't fail on X3/X4.
  (process.stdin as unknown as { isTTY?: boolean }).isTTY = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIG_CLAUDE_PLUGIN_ROOT === undefined) {
    delete process.env.CLAUDE_PLUGIN_ROOT;
  } else {
    process.env.CLAUDE_PLUGIN_ROOT = ORIG_CLAUDE_PLUGIN_ROOT;
  }
  if (ORIG_OMC_PLUGIN_ROOT === undefined) {
    delete process.env.OMC_PLUGIN_ROOT;
  } else {
    process.env.OMC_PLUGIN_ROOT = ORIG_OMC_PLUGIN_ROOT;
  }
  (process.stdin as unknown as { isTTY?: boolean }).isTTY = ORIG_ISTTY;
});

async function callRunSetupCommand(
  opts: Record<string, unknown>,
  stderr?: CaptureStderr,
): Promise<number> {
  vi.resetModules();
  const mod = await import('../../cli/index.js');
  // CaptureStderr is a minimal {write} shim — cast to the writable-stream shape
  // the CLI handler expects. Full NodeJS.WritableStream conformance isn't needed
  // because the handler only ever calls `.write()`.
  return mod.runSetupCommand(opts, stderr as unknown as NodeJS.WritableStream);
}

function baseOpts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plugin: true,
    mcp: true,
    teams: true,
    installCli: true,
    starRepo: true,
    ...overrides,
  };
}

describe('plugin-check on bare `omc setup` (safe-defaults path)', () => {
  it('fails with clear error + exit 1 when no plugin detected', async () => {
    hoisted.isRunningAsPluginMock.mockReturnValue(false);
    hoisted.getInstalledOmcPluginRootsMock.mockReturnValue([]);
    const stderr = new CaptureStderr();

    const exit = await callRunSetupCommand(baseOpts({ force: true }), stderr);

    expect(exit).toBe(1);
    expect(stderr.output).toContain('oh-my-claudecode plugin installation not detected');
    expect(stderr.output).toContain('--infra-only');
    expect(stderr.output).toContain('--no-plugin');
    expect(stderr.output).toContain('--plugin-dir-mode');
    // runSetup must NOT have been called — the check fired before dispatch.
    expect(hoisted.runSetupMock).not.toHaveBeenCalled();
  });

  it('passes when isRunningAsPlugin() returns true', async () => {
    hoisted.isRunningAsPluginMock.mockReturnValue(true);
    const stderr = new CaptureStderr();
    const exit = await callRunSetupCommand(baseOpts({ force: true }), stderr);
    expect(exit).toBe(0);
    expect(stderr.output).not.toContain('plugin installation not detected');
    expect(hoisted.runSetupMock).toHaveBeenCalled();
  });

  it('passes when getInstalledOmcPluginRoots() returns a non-empty list', async () => {
    hoisted.getInstalledOmcPluginRootsMock.mockReturnValue(['/path/to/plugin']);
    const exit = await callRunSetupCommand(baseOpts({ force: true }));
    expect(exit).toBe(0);
    expect(hoisted.runSetupMock).toHaveBeenCalled();
  });

  it('passes when CLAUDE_PLUGIN_ROOT env var is set', async () => {
    process.env.CLAUDE_PLUGIN_ROOT = '/tmp/plugin-root';
    const exit = await callRunSetupCommand(baseOpts({ force: true }));
    expect(exit).toBe(0);
    expect(hoisted.runSetupMock).toHaveBeenCalled();
  });
});

describe('plugin-check does NOT fire for escape hatches', () => {
  it('does NOT fire for --infra-only', async () => {
    hoisted.isRunningAsPluginMock.mockReturnValue(false);
    hoisted.getInstalledOmcPluginRootsMock.mockReturnValue([]);
    const exit = await callRunSetupCommand(baseOpts({ force: true, infraOnly: true }));
    expect(exit).toBe(0);
    expect(hoisted.runSetupMock).toHaveBeenCalled();
  });

  it('does NOT fire for --no-plugin', async () => {
    hoisted.isRunningAsPluginMock.mockReturnValue(false);
    hoisted.getInstalledOmcPluginRootsMock.mockReturnValue([]);
    // Commander normalizes --no-plugin to { plugin: false }.
    const exit = await callRunSetupCommand(baseOpts({ plugin: false }));
    expect(exit).toBe(0);
    expect(hoisted.runSetupMock).toHaveBeenCalled();
  });

  it('does NOT fire for --claude-md-only', async () => {
    hoisted.isRunningAsPluginMock.mockReturnValue(false);
    hoisted.getInstalledOmcPluginRootsMock.mockReturnValue([]);
    const exit = await callRunSetupCommand(
      baseOpts({ claudeMdOnly: true, global: true, force: true }),
    );
    expect(exit).toBe(0);
    expect(hoisted.runSetupMock).toHaveBeenCalled();
  });

  it('does NOT fire for --check-state', async () => {
    hoisted.isRunningAsPluginMock.mockReturnValue(false);
    hoisted.getInstalledOmcPluginRootsMock.mockReturnValue([]);
    const exit = await callRunSetupCommand(baseOpts({ checkState: true }));
    expect(exit).toBe(0);
    expect(hoisted.runSetupMock).toHaveBeenCalled();
  });

  it('does NOT fire for --state-clear', async () => {
    hoisted.isRunningAsPluginMock.mockReturnValue(false);
    hoisted.getInstalledOmcPluginRootsMock.mockReturnValue([]);
    const exit = await callRunSetupCommand(baseOpts({ stateClear: true }));
    expect(exit).toBe(0);
    expect(hoisted.runSetupMock).toHaveBeenCalled();
  });
});

describe('--dump-safe-defaults flag', () => {
  it('prints JSON and returns 0 without calling runSetup or plugin check', async () => {
    hoisted.isRunningAsPluginMock.mockReturnValue(false);
    hoisted.getInstalledOmcPluginRootsMock.mockReturnValue([]);

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown): boolean => {
      if (typeof chunk === 'string') chunks.push(chunk);
      else chunks.push(Buffer.from(chunk as Uint8Array).toString('utf-8'));
      return true;
    }) as typeof process.stdout.write;

    try {
      const exit = await callRunSetupCommand(baseOpts({ dumpSafeDefaults: true }));
      expect(exit).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = chunks.join('');
    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output) as { phases: unknown };
    expect(Array.isArray(parsed.phases)).toBe(true);
    // Did not spawn setup
    expect(hoisted.runSetupMock).not.toHaveBeenCalled();
  });
});
