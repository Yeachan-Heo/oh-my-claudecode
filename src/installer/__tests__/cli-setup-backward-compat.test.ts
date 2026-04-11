/**
 * Backward-compat / safe-defaults flip for the setup-unification PR6:
 *
 * Originally (PR1-PR5) bare `omc setup --force` routed phases={'infra'} only
 * and pinned the exact install() call shape — the "infra-only non-regression
 * #1" contract. In PR6 we INTENTIONALLY flip the bare path to run the
 * SAFE_DEFAULTS preset (claude-md + infra + integrations + welcome), and
 * move the old contract behind the explicit `--infra-only` escape flag.
 *
 * This test file now pins BOTH contracts:
 *   - `--infra-only` path: phases={'infra'}, install() called with today's
 *     six-key shape, NO phase2/3/4 helpers invoked, NO CLAUDE.md touched.
 *     This keeps the pre-safe-defaults behavior available for CI /
 *     provisioning / automation that historically relied on bare-is-minimal.
 *   - Safe-defaults path: phases matches SAFE_DEFAULTS (claude-md, infra,
 *     integrations, welcome), runSetup is called with a fully-resolved
 *     SetupOptions whose nested fields match the SAFE_DEFAULTS constant.
 *
 * Plan ref: user request "make bare omc setup run the best result out of
 * the box, keep --infra-only as escape hatch".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runSetup, type RunSetupDeps } from '../../setup/index.js';
import { DEFAULTS } from '../../setup/options.js';
import { SAFE_DEFAULTS } from '../../setup/safe-defaults.js';
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

function clonedSafeDefaults(): SetupOptions {
  return {
    ...SAFE_DEFAULTS,
    phases: new Set(SAFE_DEFAULTS.phases),
    mcp: {
      ...SAFE_DEFAULTS.mcp,
      credentials: { ...SAFE_DEFAULTS.mcp.credentials },
      servers: [...SAFE_DEFAULTS.mcp.servers],
    },
    teams: { ...SAFE_DEFAULTS.teams },
    installerOptions: { ...SAFE_DEFAULTS.installerOptions },
    hud: SAFE_DEFAULTS.hud
      ? { elements: { ...SAFE_DEFAULTS.hud.elements } }
      : undefined,
  };
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

// ---------------------------------------------------------------------------
// --infra-only escape hatch (preserves pre-safe-defaults bare contract)
// ---------------------------------------------------------------------------

describe('CLI setup --infra-only escape hatch (pre-safe-defaults bare contract)', () => {
  let tmp: ReturnType<typeof makeTmp>;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp.root, { recursive: true, force: true });
  });

  it('B1: --infra-only + --force → phases={infra}, install() called exactly once with force:true', async () => {
    const installFn = vi.fn<(opts?: InstallOptions) => InstallResult>(okInstall);
    const phase1 = vi.fn();
    const phase2 = vi.fn();
    const phase3 = vi.fn();
    const phase4 = vi.fn();

    // The CLI handler, when given `--infra-only --force`, constructs this
    // exact InstallOptions shape (matches the pre-safe-defaults contract).
    const cliInstallOptions: InstallOptions = {
      force: true,
      verbose: true,
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

    expect(installFn).toHaveBeenCalledOnce();
    expect(installFn).toHaveBeenCalledWith(cliInstallOptions);

    // Phase helpers NEVER invoked — this is the infra-only contract.
    expect(phase1).not.toHaveBeenCalled();
    expect(phase2).not.toHaveBeenCalled();
    expect(phase3).not.toHaveBeenCalled();
    expect(phase4).not.toHaveBeenCalled();

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.phasesRun).toEqual(['infra']);

    // NO CLAUDE.md written to the isolated cwd.
    expect(existsSync(join(tmp.cwd, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(tmp.configDir, 'CLAUDE.md'))).toBe(false);
  });

  it('B2: --infra-only (no force) forwards verbose:true, force:false', async () => {
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

  it('B3: --infra-only --quiet forwards verbose:false and suppresses wrapper output', async () => {
    const installFn = vi.fn<(opts?: InstallOptions) => InstallResult>(okInstall);
    const stdoutLines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
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

    expect(stdoutLines.join('')).toBe('');
  });

  it('B4: --skip-hooks / --force-hooks flags pass through to install()', async () => {
    const installFn = vi.fn<(opts?: InstallOptions) => InstallResult>(okInstall);
    const options: SetupOptions = {
      ...clonedDefaults(),
      phases: new Set<SetupPhase>(['infra']),
      installerOptions: {
        force: false,
        verbose: true,
        skipClaudeCheck: true,
        forceHooks: true,
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

  it('B5: --plugin-dir-mode forwards to install()', async () => {
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

  it('B6: install() failure surfaces as non-zero exit with errors', async () => {
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

  it('B7: adding a second phase routes through runPhase2 (NOT the bare-infra shortcut)', async () => {
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
      force: true,
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
        write: vi.fn(),
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

// ---------------------------------------------------------------------------
// Safe-defaults bare contract (new)
// ---------------------------------------------------------------------------

describe('CLI setup safe-defaults bare contract', () => {
  let tmp: ReturnType<typeof makeTmp>;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp.root, { recursive: true, force: true });
  });

  it('S1: safe-defaults SetupOptions routes through phase1..phase4 (NOT install-shortcut)', async () => {
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
    const phase3 = vi.fn(async () => ({
      pluginVerified: true,
      mcpInstalled: [] as string[],
      mcpSkipped: [] as string[],
      teamsConfigured: false,
    }));
    const phase4 = vi.fn(async () => undefined);

    const options = clonedSafeDefaults();
    // Bypass the already-configured check for a deterministic run.
    options.force = true;

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
      prompter: {
        askSelect: vi.fn(),
        askConfirm: vi.fn(),
        askText: vi.fn(),
        askSecret: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
      },
    });

    expect(installFn).not.toHaveBeenCalled();
    expect(phase1).toHaveBeenCalledOnce();
    expect(phase2).toHaveBeenCalledOnce();
    expect(phase3).toHaveBeenCalledOnce();
    expect(phase4).toHaveBeenCalledOnce();

    expect(result.success).toBe(true);
    expect(result.phasesRun).toEqual(['claude-md', 'infra', 'integrations', 'welcome']);
  });

  it('S2: SAFE_DEFAULTS pins exact phase set', () => {
    expect(Array.from(SAFE_DEFAULTS.phases).sort()).toEqual(
      ['claude-md', 'infra', 'integrations', 'welcome'].sort(),
    );
  });

  it('S3: SAFE_DEFAULTS pins target, installStyle, executionMode', () => {
    expect(SAFE_DEFAULTS.target).toBe('global');
    expect(SAFE_DEFAULTS.installStyle).toBe('overwrite');
    expect(SAFE_DEFAULTS.executionMode).toBe('ultrawork');
  });

  it('S4: SAFE_DEFAULTS pins MCP curated server list and install-without-auth policy', () => {
    expect(SAFE_DEFAULTS.mcp.enabled).toBe(true);
    expect(SAFE_DEFAULTS.mcp.servers).toEqual(['context7', 'exa', 'filesystem', 'github']);
    expect(SAFE_DEFAULTS.mcp.onMissingCredentials).toBe('install-without-auth');
    expect(SAFE_DEFAULTS.mcp.scope).toBe('user');
  });

  it('S5: SAFE_DEFAULTS pins teams enabled with 3:executor auto', () => {
    expect(SAFE_DEFAULTS.teams.enabled).toBe(true);
    expect(SAFE_DEFAULTS.teams.agentCount).toBe(3);
    expect(SAFE_DEFAULTS.teams.agentType).toBe('executor');
    expect(SAFE_DEFAULTS.teams.displayMode).toBe('auto');
  });

  it('S6: SAFE_DEFAULTS pins HUD element overrides (cwd, git, session health; no bars)', () => {
    expect(SAFE_DEFAULTS.hud?.elements).toMatchObject({
      cwd: true,
      gitBranch: true,
      gitStatus: true,
      sessionHealth: true,
      useBars: false,
      contextBar: false,
    });
  });
});
