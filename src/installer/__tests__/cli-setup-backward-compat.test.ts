/**
 * Non-regression #1 for the setup unification refactor:
 *
 *   Bare `omc setup` (no extra flags) MUST behave byte-identically to
 *   today's `installOmc()` call. The new `runSetup()` entry point routes
 *   `phases={'infra'}` directly through `install()` and MUST NOT:
 *
 *     - touch CLAUDE.md (phase 1)
 *     - write preferences to `.omc-config.json` (phase 2 tail)
 *     - run any prompter
 *     - run phase 3 (integrations) or phase 4 (welcome)
 *     - install `oh-my-claude-sisyphus` globally
 *
 * This test pins the contract at the `runSetup()` level — it is not a
 * CLI-argument parser test (that lives alongside PR3 when the CLI is
 * rewired). It asserts that given the InstallOptions shape today's CLI
 * constructs, `runSetup()` delegates exactly once to `install()` and
 * returns without any other side-effect.
 *
 * Plan ref: `replicated-mixing-wren.md` — "Risks table row: install() +
 * runSetup double-write", "non-regression #1 bare `omc setup`".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runSetup, type RunSetupDeps } from '../../setup/index.js';
import { DEFAULTS } from '../../setup/options.js';
import type { SetupOptions, SetupPhase } from '../../setup/options.js';
import type { InstallOptions, InstallResult } from '../index.js';

function makeTmp(): { root: string; configDir: string; cwd: string; lockPath: string } {
  const root = join(tmpdir(), `omc-cli-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const configDir = join(root, 'config');
  const cwd = join(root, 'cwd');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, configDir, cwd, lockPath: join(root, 'setup.lock') };
}

function clonedDefaults(): SetupOptions {
  const base: SetupOptions = JSON.parse(JSON.stringify({
    ...DEFAULTS,
    phases: Array.from(DEFAULTS.phases),
  })) as unknown as SetupOptions;
  (base as unknown as { phases: Set<SetupPhase> }).phases = new Set(
    (base as unknown as { phases: SetupPhase[] }).phases,
  );
  return base;
}

function okInstall(): InstallResult {
  return {
    success: true,
    message: 'install-ok',
    installedAgents: ['a'],
    installedCommands: ['c'],
    installedSkills: ['s'],
    hooksConfigured: true,
    hookConflicts: [],
    errors: [],
  };
}

describe('CLI setup backward-compat (non-regression #1)', () => {
  let tmp: ReturnType<typeof makeTmp>;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp.root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // A1 — bare `omc setup --force` → single install() call, phases={'infra'},
  //      NO phase 2/3/4 run, NO CLAUDE.md touched.
  // -------------------------------------------------------------------------
  it('A1: bare `omc setup --force` → phases={infra}, install() called exactly once with force:true', async () => {
    const installFn = vi.fn<(opts?: InstallOptions) => InstallResult>(okInstall);
    const phase1 = vi.fn();
    const phase2 = vi.fn();
    const phase3 = vi.fn();
    const phase4 = vi.fn();

    // Today's CLI (src/cli/index.ts `.command('setup').action(...)` line 1259)
    // constructs the following InstallOptions from bare `--force`:
    const cliInstallOptions: InstallOptions = {
      force: true,
      verbose: true,             // !options.quiet
      skipClaudeCheck: true,
      forceHooks: false,
      noPlugin: false,
      pluginDirMode: false,
    };

    const options: SetupOptions = {
      ...clonedDefaults(),
      phases: new Set<SetupPhase>(['infra']),
      force: true,
      installerOptions: cliInstallOptions,
    };

    const result = await runSetup(options, {
      install: installFn as unknown as RunSetupDeps['install'],
      phase1: phase1 as unknown as RunSetupDeps['phase1'],
      phase2: phase2 as unknown as RunSetupDeps['phase2'],
      phase3: phase3 as unknown as RunSetupDeps['phase3'],
      phase4: phase4 as unknown as RunSetupDeps['phase4'],
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      skipSignalHandlers: true,
    });

    // install() called exactly once with the CLI's InstallOptions shape.
    expect(installFn).toHaveBeenCalledOnce();
    expect(installFn).toHaveBeenCalledWith(cliInstallOptions);

    // Phase helpers NEVER invoked — this is the "infra-only" contract.
    expect(phase1).not.toHaveBeenCalled();
    expect(phase2).not.toHaveBeenCalled();
    expect(phase3).not.toHaveBeenCalled();
    expect(phase4).not.toHaveBeenCalled();

    // Result is success with only infra in phasesRun.
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.phasesRun).toEqual(['infra']);

    // NO CLAUDE.md written to the isolated cwd.
    expect(existsSync(join(tmp.cwd, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(tmp.configDir, 'CLAUDE.md'))).toBe(false);

    // NO .omc-config.json written by phase2 (install() may or may not
    // touch it — that's install()'s business, but phase2 tail must not).
    // We verify phase2 wasn't called, which is the contract.
  });

  // -------------------------------------------------------------------------
  // A2 — bare `omc setup` (no --force, no --quiet) → verbose:true,
  //      force:false, exit 0.
  // -------------------------------------------------------------------------
  it('A2: bare `omc setup` (no force) forwards verbose:true, force:false', async () => {
    const installFn = vi.fn<(opts?: InstallOptions) => InstallResult>(okInstall);
    const options: SetupOptions = {
      ...clonedDefaults(),
      phases: new Set<SetupPhase>(['infra']),
      installerOptions: {
        force: false,
        verbose: true,
        skipClaudeCheck: true,
        forceHooks: false,
        noPlugin: false,
        pluginDirMode: false,
      },
    };

    const result = await runSetup(options, {
      install: installFn as unknown as RunSetupDeps['install'],
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      skipSignalHandlers: true,
    });

    expect(result.success).toBe(true);
    expect(installFn).toHaveBeenCalledOnce();
    const call = installFn.mock.calls[0][0] as InstallOptions;
    expect(call.force).toBe(false);
    expect(call.verbose).toBe(true);
    expect(call.skipClaudeCheck).toBe(true);
  });

  // -------------------------------------------------------------------------
  // A3 — `omc setup --quiet` → verbose:false, no output from wrapper.
  // -------------------------------------------------------------------------
  it('A3: --quiet forwards verbose:false and suppresses wrapper output', async () => {
    const installFn = vi.fn<(opts?: InstallOptions) => InstallResult>(okInstall);
    const stdoutLines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // Capture any stdout the wrapper emits — should be zero when quiet.
    process.stdout.write = ((chunk: unknown): boolean => {
      if (typeof chunk === 'string') stdoutLines.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const options: SetupOptions = {
        ...clonedDefaults(),
        phases: new Set<SetupPhase>(['infra']),
        quiet: true,
        installerOptions: {
          force: false,
          verbose: false,
          skipClaudeCheck: true,
          forceHooks: false,
          noPlugin: false,
          pluginDirMode: false,
        },
      };

      const result = await runSetup(options, {
        install: installFn as unknown as RunSetupDeps['install'],
        lockPath: tmp.lockPath,
        configDir: tmp.configDir,
        cwd: tmp.cwd,
        skipSignalHandlers: true,
      });

      expect(result.success).toBe(true);
      expect(installFn).toHaveBeenCalledOnce();
      const call = installFn.mock.calls[0][0] as InstallOptions;
      expect(call.verbose).toBe(false);
    } finally {
      process.stdout.write = origWrite;
    }

    // Wrapper should NOT have written anything when quiet=true.
    // (install()'s own output is mocked out via the vi.fn, so any output
    // we see here came from runSetup itself.)
    expect(stdoutLines.join('')).toBe('');
  });

  // -------------------------------------------------------------------------
  // A35 — `--skip-hooks` forwards through to InstallOptions (future flag
  //       wired in PR3). Today's test pins the pass-through.
  // -------------------------------------------------------------------------
  it('A35: --skip-hooks / --force-hooks flags pass through to install()', async () => {
    const installFn = vi.fn<(opts?: InstallOptions) => InstallResult>(okInstall);
    const options: SetupOptions = {
      ...clonedDefaults(),
      phases: new Set<SetupPhase>(['infra']),
      installerOptions: {
        force: false,
        verbose: true,
        skipClaudeCheck: true,
        forceHooks: true, // --force-hooks
        noPlugin: false,
        pluginDirMode: false,
      },
    };

    await runSetup(options, {
      install: installFn as unknown as RunSetupDeps['install'],
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      skipSignalHandlers: true,
    });

    expect(installFn).toHaveBeenCalledOnce();
    const call = installFn.mock.calls[0][0] as InstallOptions;
    expect(call.forceHooks).toBe(true);
  });

  // -------------------------------------------------------------------------
  // A36 — `--plugin-dir-mode` forwards.
  // -------------------------------------------------------------------------
  it('A36: --plugin-dir-mode forwards to install()', async () => {
    const installFn = vi.fn<(opts?: InstallOptions) => InstallResult>(okInstall);
    const options: SetupOptions = {
      ...clonedDefaults(),
      phases: new Set<SetupPhase>(['infra']),
      installerOptions: {
        force: false,
        verbose: true,
        skipClaudeCheck: true,
        forceHooks: false,
        noPlugin: false,
        pluginDirMode: true,
      },
    };

    await runSetup(options, {
      install: installFn as unknown as RunSetupDeps['install'],
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      skipSignalHandlers: true,
    });

    expect(installFn).toHaveBeenCalledOnce();
    const call = installFn.mock.calls[0][0] as InstallOptions;
    expect(call.pluginDirMode).toBe(true);
  });

  // -------------------------------------------------------------------------
  // A37 — install() failure bubbles up as exit 1 with errors array.
  // -------------------------------------------------------------------------
  it('A37: install() failure surfaces as non-zero exit with errors', async () => {
    const installFn = vi.fn((): InstallResult => ({
      success: false,
      message: 'setup failed',
      installedAgents: [],
      installedCommands: [],
      installedSkills: [],
      hooksConfigured: false,
      hookConflicts: [],
      errors: ['boom1', 'boom2'],
    }));

    const options: SetupOptions = {
      ...clonedDefaults(),
      phases: new Set<SetupPhase>(['infra']),
      installerOptions: {
        force: true,
        verbose: true,
        skipClaudeCheck: true,
      },
    };

    const result = await runSetup(options, {
      install: installFn as unknown as RunSetupDeps['install'],
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      skipSignalHandlers: true,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.errors).toEqual(['boom1', 'boom2']);
  });

  // -------------------------------------------------------------------------
  // Anti-regression: adding a second phase MUST break out of the bare-infra
  // path and NOT call install() via the direct backward-compat branch. This
  // test guards against "someone adds 'claude-md' to the default set without
  // noticing" — a drive-by change that would silently break `omc setup`.
  // -------------------------------------------------------------------------
  it('adding a second phase routes through runPhase2 (NOT the bare-infra shortcut)', async () => {
    const installFn = vi.fn<(opts?: InstallOptions) => InstallResult>(okInstall);
    const phase1 = vi.fn(async () => ({
      mode: 'overwrite' as const,
      installStyle: 'overwrite' as const,
      targetPath: '/tmp/CLAUDE.md',
      backupPath: undefined,
      oldVersion: undefined,
      newVersion: '1.0.0',
    }));
    const phase2 = vi.fn(async () => undefined);

    const options: SetupOptions = {
      ...clonedDefaults(),
      phases: new Set<SetupPhase>(['claude-md', 'infra']),
      force: true, // bypass already-configured check
      installerOptions: {
        force: true,
        verbose: true,
        skipClaudeCheck: true,
      },
    };

    await runSetup(options, {
      install: installFn as unknown as RunSetupDeps['install'],
      phase1: phase1 as unknown as RunSetupDeps['phase1'],
      phase2: phase2 as unknown as RunSetupDeps['phase2'],
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      skipSignalHandlers: true,
      prompter: {
        askSelect: vi.fn(),
        askConfirm: vi.fn(),
        askText: vi.fn(),
        askSecret: vi.fn(),
        close: vi.fn(),
      },
    });

    // Bare-infra backward-compat path is NOT taken — install() is NOT
    // called directly. It is called from runPhase2 inside phase2Fn, which
    // we mocked, so installFn is 0.
    expect(installFn).not.toHaveBeenCalled();
    expect(phase1).toHaveBeenCalledOnce();
    expect(phase2).toHaveBeenCalledOnce();
  });
});
