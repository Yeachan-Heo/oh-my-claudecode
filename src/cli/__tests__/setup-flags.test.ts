/**
 * Per-flag unit tests for `omc setup` (PR3 CLI wire-up).
 *
 * Complements:
 *   - `cli-setup-backward-compat.test.ts` (pins bare-infra non-regression #1
 *     at the `runSetup()` level)
 *   - `setup-command-precedence.test.ts` (plugin-dir-mode / env precedence)
 *
 * Coverage here:
 *   1. Per-flag pass-through — each new flag on `omc setup` lands on the
 *      correct `SetupOptions` field when driven through the real commander
 *      pipeline (buildProgram → parseAsync).
 *   2. `--help` sanity — every new flag long-name is registered on the
 *      setup command, and `--build-preset` is marked as internal.
 *   3. Illegal combinations X1–X12 — each surfaces as exit code 2 with the
 *      plan-specified error message.
 *   4. `--skip-hooks` deprecation advisory is emitted to stderr.
 *   5. `--build-preset` round-trips a valid answers file into a preset JSON.
 *   6. `--check-state` forwards through to runSetup.
 *
 * Testing strategy: runSetup is mocked at the module level via `vi.hoisted`
 * + `vi.mock`, so the CLI action can resolve without touching the real
 * filesystem or acquiring the setup lockfile. Tests assert on the exact
 * SetupOptions passed to the runSetup spy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import type { SetupOptions, SetupPhase } from '../../setup/options.js';
import type { RunSetupResult } from '../../setup/index.js';

// Don't auto-parse process.argv when the CLI module is imported.
process.env.OMC_CLI_SKIP_PARSE = '1';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  const runSetupMock = vi.fn();
  const installMock = vi.fn();
  return { runSetupMock, installMock };
});

vi.mock('../../setup/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../setup/index.js')>(
    '../../setup/index.js',
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIG_ISTTY = process.stdin.isTTY;
const ORIG_STDOUT_ISTTY = process.stdout.isTTY;
const ORIG_OMC_TARGET = process.env.OMC_SETUP_TARGET;

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function okResult(): RunSetupResult {
  return {
    success: true,
    phasesRun: ['infra'] as SetupPhase[],
    phaseResults: {},
    warnings: [],
    errors: [],
    exitCode: 0,
    installResult: {
      success: true,
      message: 'ok',
      installedAgents: [],
      installedCommands: [],
      installedSkills: [],
      hooksConfigured: true,
      hookConflicts: [],
      errors: [],
    },
  };
}

beforeEach(() => {
  hoisted.runSetupMock.mockReset();
  hoisted.runSetupMock.mockResolvedValue(okResult());
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
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Pretend we have a TTY so --wizard/--interactive don't trip X3/X4.
  // `resolveOptions` reads `process.stdin.isTTY` while the new bare-path
  // dispatcher in runSetupCommand reads `process.stdout.isTTY` via
  // `isNonInteractive()` — both must be truthy for the "TTY" branch to fire.
  (process.stdin as unknown as { isTTY?: boolean }).isTTY = true;
  (process.stdout as unknown as { isTTY?: boolean }).isTTY = true;
  delete process.env.OMC_SETUP_TARGET;
  // `isNonInteractive()` also returns true when CI/CLAUDE_CODE_RUN are set.
  // Clear them so these tests exercise the "bare on TTY" branch cleanly.
  delete process.env.CI;
  delete process.env.CLAUDE_CODE_RUN;
  delete process.env.CLAUDE_CODE_NON_INTERACTIVE;
  delete process.env.GITHUB_ACTIONS;
});

afterEach(() => {
  (process.stdin as unknown as { isTTY?: boolean }).isTTY = ORIG_ISTTY;
  (process.stdout as unknown as { isTTY?: boolean }).isTTY = ORIG_STDOUT_ISTTY;
  if (ORIG_OMC_TARGET === undefined) {
    delete process.env.OMC_SETUP_TARGET;
  } else {
    process.env.OMC_SETUP_TARGET = ORIG_OMC_TARGET;
  }
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

async function driveParse(args: string[]): Promise<void> {
  // Reset modules so each test gets a fresh commander program (commander
  // stores option values on the Command instance and does not reset them
  // between parseAsync calls).
  vi.resetModules();
  const { buildProgram } = await import('../index.js');
  const program = buildProgram();
  await program.parseAsync(['setup', ...args], { from: 'user' });
}

function lastCallOptions(): SetupOptions {
  expect(hoisted.runSetupMock).toHaveBeenCalled();
  const calls = hoisted.runSetupMock.mock.calls;
  return calls[calls.length - 1][0] as SetupOptions;
}

async function callRunSetupCommand(
  opts: Record<string, unknown>,
  stderr?: NodeJS.WritableStream,
): Promise<number> {
  vi.resetModules();
  const mod = await import('../index.js');
  return mod.runSetupCommand(opts, stderr);
}

/**
 * Commander produces `true` for `--no-<flag>` pairs when the paired flag
 * is not actually passed (commander's default-on behavior for negated
 * options). Mirror that shape so the validators that read `plugin`/`mcp`
 * /`teams`/`installCli`/`starRepo` see a sensible baseline.
 */
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

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `omc-setup-flags-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

class CaptureStderr {
  public output = '';
  write(chunk: string | Uint8Array): boolean {
    this.output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }
}

// ---------------------------------------------------------------------------
// 1. Per-flag pass-through (real commander pipeline)
// ---------------------------------------------------------------------------

describe('omc setup: existing 6 flags pass through', () => {
  it('--force forwards force=true', async () => {
    await driveParse(['--force', '--quiet']);
    const opts = lastCallOptions();
    expect(opts.force).toBe(true);
    expect(opts.installerOptions.force).toBe(true);
  });

  it('--quiet forwards verbose=false', async () => {
    await driveParse(['--quiet']);
    expect(lastCallOptions().installerOptions.verbose).toBe(false);
  });

  it('--plugin-dir-mode forwards pluginDirMode=true', async () => {
    await driveParse(['--plugin-dir-mode', '--quiet']);
    expect(lastCallOptions().installerOptions.pluginDirMode).toBe(true);
  });

  it('--no-plugin forwards noPlugin=true', async () => {
    await driveParse(['--no-plugin', '--quiet']);
    expect(lastCallOptions().installerOptions.noPlugin).toBe(true);
  });

  it('--skip-hooks forwards skipHooks=true', async () => {
    await driveParse(['--skip-hooks', '--quiet']);
    const installerOpts = lastCallOptions().installerOptions as { skipHooks?: boolean };
    expect(installerOpts.skipHooks).toBe(true);
  });

  it('--force-hooks forwards forceHooks=true', async () => {
    await driveParse(['--force-hooks', '--quiet']);
    expect(lastCallOptions().installerOptions.forceHooks).toBe(true);
  });
});

describe('omc setup: mode-control flags', () => {
  it('--wizard expands to all four phases (with TTY)', async () => {
    await driveParse(['--wizard']);
    const phases = Array.from(lastCallOptions().phases).sort();
    expect(phases).toEqual(['claude-md', 'infra', 'integrations', 'welcome']);
  });

  it('--interactive sets interactive=true', async () => {
    await driveParse(['--interactive', '--global', '--claude-md-only']);
    expect(lastCallOptions().interactive).toBe(true);
  });

  it('--non-interactive sets interactive=false', async () => {
    await driveParse(['--non-interactive', '--quiet']);
    expect(lastCallOptions().interactive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bare-path dispatch (wizard vs. safe-defaults vs. errors)
// ---------------------------------------------------------------------------

describe('omc setup: bare-path dispatch (wizard/safe-defaults branching)', () => {
  it('bare + non-TTY → safe-defaults (no wizard, runSetup called with SAFE_DEFAULTS preset)', async () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = false;
    (process.stdin as unknown as { isTTY?: boolean }).isTTY = false;
    await driveParse([]);

    // runSetup called; phases match SAFE_DEFAULTS.
    const opts = lastCallOptions();
    const phases = Array.from(opts.phases).sort();
    expect(phases).toEqual(['claude-md', 'infra', 'integrations', 'welcome'].sort());
    expect(opts.mcp.enabled).toBe(true);
    expect(opts.teams.enabled).toBe(true);
  });

  it('--non-interactive on TTY → safe-defaults (forces non-interactive even on TTY)', async () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = true;
    (process.stdin as unknown as { isTTY?: boolean }).isTTY = true;
    await driveParse(['--non-interactive']);

    const opts = lastCallOptions();
    const phases = Array.from(opts.phases).sort();
    expect(phases).toEqual(['claude-md', 'infra', 'integrations', 'welcome'].sort());
    expect(opts.interactive).toBe(false);
  });

  it('--quiet on TTY → safe-defaults (quiet is implicit non-interactive)', async () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = true;
    (process.stdin as unknown as { isTTY?: boolean }).isTTY = true;
    await driveParse(['--quiet']);

    const opts = lastCallOptions();
    const phases = Array.from(opts.phases).sort();
    expect(phases).toEqual(['claude-md', 'infra', 'integrations', 'welcome'].sort());
    expect(opts.quiet).toBe(true);
  });

  it('--interactive --non-interactive → exit 2 (mutex)', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ interactive: true, nonInteractive: true }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/mutually exclusive/);
  });

  it('bare + --interactive + non-TTY → exit 2 (bare-path X4 check with clear message)', async () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = false;
    (process.stdin as unknown as { isTTY?: boolean }).isTTY = false;
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ interactive: true }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/--interactive requires a TTY/);
  });

  it('--infra-only on non-TTY → direct install (escape hatch, NOT safe-defaults)', async () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = false;
    (process.stdin as unknown as { isTTY?: boolean }).isTTY = false;
    await driveParse(['--infra-only', '--quiet']);

    const opts = lastCallOptions();
    const phases = Array.from(opts.phases);
    // --infra-only pins phases=['infra'] — SAFE_DEFAULTS is NOT applied.
    expect(phases).toEqual(['infra']);
    expect(opts.mcp.enabled).toBe(false);
  });
});

describe('omc setup: phase 1 (CLAUDE.md) flags', () => {
  it('--local forwards target=local + adds claude-md phase', async () => {
    await driveParse(['--local', '--quiet']);
    const o = lastCallOptions();
    expect(o.target).toBe('local');
    expect(o.phases.has('claude-md')).toBe(true);
  });

  it('--global forwards target=global', async () => {
    await driveParse(['--global', '--quiet']);
    expect(lastCallOptions().target).toBe('global');
  });

  it('--preserve with --global forwards installStyle=preserve', async () => {
    await driveParse(['--global', '--preserve', '--quiet']);
    expect(lastCallOptions().installStyle).toBe('preserve');
  });

  it('--overwrite forwards installStyle=overwrite', async () => {
    await driveParse(['--global', '--overwrite', '--quiet']);
    expect(lastCallOptions().installStyle).toBe('overwrite');
  });
});

describe('omc setup: phase 2 flags', () => {
  it('--execution-mode forwards', async () => {
    await driveParse(['--execution-mode', 'ralph', '--wizard']);
    expect(lastCallOptions().executionMode).toBe('ralph');
  });

  it('--task-tool forwards', async () => {
    await driveParse(['--task-tool', 'bd', '--wizard']);
    expect(lastCallOptions().taskTool).toBe('bd');
  });

  it('--install-cli sets installCli=true', async () => {
    await driveParse(['--install-cli', '--wizard']);
    expect(lastCallOptions().installCli).toBe(true);
  });

  it('--no-install-cli sets installCli=false', async () => {
    await driveParse(['--no-install-cli', '--wizard']);
    expect(lastCallOptions().installCli).toBe(false);
  });
});

describe('omc setup: phase 3 MCP flags', () => {
  it('--configure-mcp sets mcp.enabled=true', async () => {
    await driveParse(['--configure-mcp', '--wizard']);
    expect(lastCallOptions().mcp.enabled).toBe(true);
  });

  it('--no-mcp sets mcp.enabled=false', async () => {
    await driveParse(['--no-mcp', '--wizard']);
    expect(lastCallOptions().mcp.enabled).toBe(false);
  });

  it('--mcp-servers parses comma-separated list', async () => {
    await driveParse(['--mcp-servers', 'context7,exa', '--mcp-only']);
    const o = lastCallOptions();
    expect(o.mcp.servers.length).toBe(2);
  });

  it('--exa-key-file reads the key from disk', async () => {
    const dir = makeTmpDir();
    const keyFile = join(dir, 'exa.key');
    writeFileSync(keyFile, 'super-secret');
    try {
      await driveParse([
        '--exa-key-file', keyFile,
        '--mcp-servers', 'exa',
        '--mcp-only',
      ]);
      expect(lastCallOptions().mcp.credentials?.exa).toBe('super-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--mcp-scope user forwards', async () => {
    await driveParse([
      '--mcp-scope', 'user',
      '--mcp-servers', 'context7',
      '--mcp-only',
    ]);
    expect(lastCallOptions().mcp.scope).toBe('user');
  });

  it('--mcp-on-missing-creds error forwards', async () => {
    await driveParse([
      '--mcp-on-missing-creds', 'error',
      '--mcp-servers', 'context7',
      '--mcp-only',
    ]);
    expect(lastCallOptions().mcp.onMissingCredentials).toBe('error');
  });
});

describe('omc setup: phase 3 teams flags', () => {
  it('--enable-teams sets teams.enabled=true', async () => {
    await driveParse(['--enable-teams', '--wizard']);
    expect(lastCallOptions().teams.enabled).toBe(true);
  });

  it('--no-teams sets teams.enabled=false', async () => {
    await driveParse(['--no-teams', '--wizard']);
    expect(lastCallOptions().teams.enabled).toBe(false);
  });

  it('--team-agents forwards a valid count', async () => {
    await driveParse(['--team-agents', '3', '--wizard']);
    expect(lastCallOptions().teams.agentCount).toBe(3);
  });

  it('--team-type forwards', async () => {
    await driveParse(['--team-type', 'executor', '--wizard']);
    expect(lastCallOptions().teams.agentType).toBe('executor');
  });

  it('--teammate-display forwards', async () => {
    await driveParse(['--teammate-display', 'tmux', '--wizard']);
    expect(lastCallOptions().teams.displayMode).toBe('tmux');
  });
});

describe('omc setup: phase 4 flags', () => {
  it('--star-repo forwards starRepo=true', async () => {
    await driveParse(['--star-repo', '--wizard']);
    expect(lastCallOptions().starRepo).toBe(true);
  });

  it('--no-star-repo forwards starRepo=false', async () => {
    await driveParse(['--no-star-repo', '--wizard']);
    expect(lastCallOptions().starRepo).toBe(false);
  });
});

describe('omc setup: phase-routing flags', () => {
  it('--claude-md-only uses phases={claude-md}', async () => {
    await driveParse(['--claude-md-only', '--global', '--quiet']);
    const o = lastCallOptions();
    expect(Array.from(o.phases)).toEqual(['claude-md']);
  });

  it('--mcp-only uses phases={mcp-only}', async () => {
    await driveParse(['--mcp-only', '--mcp-servers', 'context7']);
    const o = lastCallOptions();
    expect(Array.from(o.phases)).toEqual(['mcp-only']);
  });
});

describe('omc setup: state-machine flags', () => {
  it('--state-resume sets phases={state}, stateAction.op=resume', async () => {
    await driveParse(['--state-resume']);
    const o = lastCallOptions();
    expect(o.phases.has('state')).toBe(true);
    expect(o.stateAction?.op).toBe('resume');
  });

  it('--state-clear sets stateAction.op=clear', async () => {
    await driveParse(['--state-clear']);
    expect(lastCallOptions().stateAction?.op).toBe('clear');
  });

  it('--state-save 3 sets stateAction.op=save,step=3', async () => {
    await driveParse(['--state-save', '3', '--state-config-type', 'wizard']);
    const o = lastCallOptions();
    expect(o.stateAction?.op).toBe('save');
    const action = o.stateAction as { op: 'save'; step: number; configType: string };
    expect(action.step).toBe(3);
    expect(action.configType).toBe('wizard');
  });

  it('--state-complete 1.2.3 sets stateAction.op=complete,version=1.2.3', async () => {
    await driveParse(['--state-complete', '1.2.3']);
    const o = lastCallOptions();
    expect(o.stateAction?.op).toBe('complete');
    const action = o.stateAction as { op: 'complete'; version: string };
    expect(action.version).toBe('1.2.3');
  });
});

describe('omc setup: --check-state', () => {
  it('sets checkState=true on options', async () => {
    await driveParse(['--check-state']);
    expect(lastCallOptions().checkState).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. --help sanity check
// ---------------------------------------------------------------------------

describe('omc setup: --help output', () => {
  it('advertises every new flag', async () => {
    vi.resetModules();
    const { buildProgram } = await import('../index.js');
    const program = buildProgram();
    const setupCmd = program.commands.find((c) => c.name() === 'setup');
    expect(setupCmd).toBeDefined();
    const flags = setupCmd!.options.map((o) => o.long);
    const expected = [
      // existing 6
      '--force', '--quiet', '--skip-hooks', '--force-hooks',
      '--no-plugin', '--plugin-dir-mode',
      // mode control
      '--preset', '--wizard', '--interactive', '--non-interactive',
      // phase 1
      '--local', '--global', '--preserve', '--overwrite',
      // phase 2
      '--execution-mode', '--task-tool', '--no-install-cli',
      // phase 3 mcp
      '--configure-mcp', '--no-mcp', '--mcp-servers',
      '--exa-key', '--exa-key-file', '--github-token', '--github-token-file',
      '--mcp-on-missing-creds', '--mcp-scope',
      // phase 3 teams
      '--enable-teams', '--no-teams',
      '--team-agents', '--team-type', '--teammate-display',
      // phase 4
      '--no-star-repo',
      // phase routing
      '--claude-md-only', '--mcp-only',
      // state
      '--state-save', '--state-clear', '--state-resume',
      '--state-complete', '--state-config-type',
      // read-only + internal
      '--check-state', '--build-preset', '--answers', '--out',
    ];
    for (const flag of expected) {
      expect(flags).toContain(flag);
    }
  });

  it('marks --build-preset as internal in help output', async () => {
    vi.resetModules();
    const { buildProgram } = await import('../index.js');
    const program = buildProgram();
    const setupCmd = program.commands.find((c) => c.name() === 'setup');
    const helpText = setupCmd!.helpInformation();
    expect(helpText).toMatch(/--build-preset/);
    expect(helpText).toMatch(/internal/);
  });
});

// ---------------------------------------------------------------------------
// 3. Illegal combinations X1–X12 (via runSetupCommand directly)
// ---------------------------------------------------------------------------

describe('omc setup: illegal combinations X1–X12', () => {
  it('X1: --local + --global → exit 2 (conflicting targets)', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ local: true, global: true }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/conflicting targets/);
  });

  it('X2: --preserve without --global → exit 2', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ local: true, preserve: true }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/--preserve only valid with --global/);
  });

  it('X3: --wizard + non-TTY + no --preset → exit 2', async () => {
    (process.stdin as unknown as { isTTY?: boolean }).isTTY = false;
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = false;
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ wizard: true }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/--wizard requires a TTY/);
  });

  it('X4: --interactive + non-TTY → exit 2', async () => {
    (process.stdin as unknown as { isTTY?: boolean }).isTTY = false;
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = false;
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ interactive: true }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/--interactive requires a TTY/);
  });

  it('X5: --non-interactive + --claude-md-only without target → exit 2', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ nonInteractive: true, claudeMdOnly: true }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/missing field target/);
  });

  it('X6: --mcp-only without --preset/--mcp-servers → exit 2', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ mcpOnly: true }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/--mcp-only requires/);
  });

  it('X7: invalid --execution-mode → exit 2', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ executionMode: 'bogus' }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/invalid --execution-mode/);
  });

  it('X8: invalid --task-tool → exit 2', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ taskTool: 'neovim' }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/invalid --task-tool/);
  });

  it('X9: invalid --mcp-scope → exit 2', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ mcpScope: 'cluster' }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/invalid --mcp-scope/);
  });

  it('X10: invalid --team-agents → exit 2', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ teamAgents: '7' }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/invalid --team-agents/);
  });

  it('X11: --preset pointing at a non-existent file → exit 2', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ preset: '/nonexistent/preset.json' }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/preset file not found/);
  });

  it('X12: --check-state + --wizard → exit 2', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ checkState: true, wizard: true }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/mutually exclusive/);
  });
});

// ---------------------------------------------------------------------------
// 4. --build-preset subcommand
// ---------------------------------------------------------------------------

describe('omc setup: --build-preset subcommand', () => {
  it('writes a preset file from valid answers', async () => {
    const dir = makeTmpDir();
    const answersPath = join(dir, 'answers.json');
    const outPath = join(dir, 'out', 'preset.json');
    const answers = {
      target: 'global',
      installStyle: 'overwrite',
      executionMode: 'ultrawork',
      taskTool: 'builtin',
      installCli: true,
      mcpServers: ['context7'],
      mcpScope: 'user',
      enableTeams: false,
      starRepo: false,
    };
    writeFileSync(answersPath, JSON.stringify(answers), 'utf-8');
    try {
      const code = await callRunSetupCommand(
        baseOpts({
          buildPreset: true,
          answers: answersPath,
          out: outPath,
        }),
      );
      expect(code).toBe(0);
      expect(existsSync(outPath)).toBe(true);
      const written = JSON.parse(readFileSync(outPath, 'utf-8'));
      expect(written.target).toBe('global');
      expect(Array.isArray(written.phases)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with exit 2 when --answers is missing', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ buildPreset: true, out: '/tmp/out.json' }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/--build-preset requires --answers/);
  });

  it('fails with exit 2 when --out is missing', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ buildPreset: true, answers: '/tmp/a.json' }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(2);
    expect(stderr.output).toMatch(/--build-preset requires --out/);
  });

  it('fails with exit 1 when the answers file does not exist', async () => {
    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({
        buildPreset: true,
        answers: '/nonexistent/answers.json',
        out: '/tmp/out.json',
      }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(1);
    expect(stderr.output).toMatch(/answers file not found/);
  });
});

// ---------------------------------------------------------------------------
// 5. --skip-hooks deprecation advisory
// ---------------------------------------------------------------------------

describe('omc setup: --skip-hooks advisory', () => {
  it('writes a deprecation advisory to stderr on first invocation of the day', async () => {
    // Wipe the daily sentinel so the advisory re-fires even if an earlier
    // test (or a real invocation on the developer machine) already set it.
    const stateDir =
      process.env.XDG_STATE_HOME
        ? join(process.env.XDG_STATE_HOME, 'omc')
        : join(homedir(), '.omc', 'state');
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const sentinel = join(stateDir, `skip-hooks-advised-${today}`);
    if (existsSync(sentinel)) rmSync(sentinel, { force: true });

    const stderr = new CaptureStderr();
    const code = await callRunSetupCommand(
      baseOpts({ skipHooks: true, quiet: true }),
      stderr as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(0);
    expect(stderr.output).toMatch(/--skip-hooks is now honored/);
  });
});
