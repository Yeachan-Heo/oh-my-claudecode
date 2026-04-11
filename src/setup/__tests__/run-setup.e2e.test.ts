/**
 * End-to-end tests for `runSetup()` (src/setup/index.ts).
 *
 * Covers scenarios from plan "replicated-mixing-wren.md":
 *   - A4/A5/A6: wizard TTY/non-TTY/preset
 *   - A21/A22: already-configured + --force bypass
 *   - A23/A24: resume prompt + skip completed phases
 *   - I6: concurrent lockfile blocks second invocation
 *   - I7: partial failure mid-phase preserves state
 *   - J1/J2/J3/J4: interactive/non-interactive edge cases
 *   - SIGINT during run releases lockfile
 *
 * All phases are mocked via `deps` injection — real phase modules are
 * NOT exercised here (they have their own unit tests). The goal is to
 * pin the dispatch/lock/state semantics of `runSetup` itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';

import { runSetup, type RunSetupDeps } from '../index.js';
import { DEFAULTS } from '../options.js';
import type { SetupOptions, SetupPhase } from '../options.js';
import { NullPrompterError, type Prompter } from '../prompts.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeTmp(): { root: string; configDir: string; cwd: string; lockPath: string } {
  const root = join(tmpdir(), `omc-runsetup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const configDir = join(root, 'config');
  const cwd = join(root, 'cwd');
  const lockPath = join(root, 'setup.lock');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, configDir, cwd, lockPath };
}

/** Build a SetupOptions by overriding DEFAULTS with the given patch. */
function makeOptions(patch: Partial<SetupOptions> = {}): SetupOptions {
  const base: SetupOptions = JSON.parse(JSON.stringify({
    ...DEFAULTS,
    phases: Array.from(DEFAULTS.phases),
  })) as unknown as SetupOptions;
  // JSON.parse rehydrates Set as array — re-materialize.
  (base as unknown as { phases: Set<SetupPhase> }).phases = new Set(
    (base as unknown as { phases: SetupPhase[] }).phases,
  );
  return { ...base, ...patch } as SetupOptions;
}

function makePhasesDeps(tracker: string[]): {
  deps: RunSetupDeps;
  install: ReturnType<typeof vi.fn>;
  phase1: ReturnType<typeof vi.fn>;
  phase2: ReturnType<typeof vi.fn>;
  phase3: ReturnType<typeof vi.fn>;
  phase4: ReturnType<typeof vi.fn>;
} {
  const install = vi.fn(() => {
    tracker.push('install');
    return {
      success: true,
      message: 'installed',
      installedAgents: [],
      installedCommands: [],
      installedSkills: [],
      hooksConfigured: true,
      hookConflicts: [],
      errors: [],
    };
  });
  const phase1 = vi.fn(async () => {
    tracker.push('phase1');
    return {
      mode: 'overwrite' as const,
      installStyle: 'overwrite' as const,
      targetPath: '/tmp/CLAUDE.md',
      backupPath: undefined,
      oldVersion: undefined,
      newVersion: '1.0.0',
    };
  });
  const phase2 = vi.fn(async () => { tracker.push('phase2'); });
  const phase3 = vi.fn(async () => {
    tracker.push('phase3');
    return {
      pluginVerified: true,
      mcpInstalled: [],
      mcpSkipped: [],
      teamsConfigured: false,
    };
  });
  const phase4 = vi.fn(async () => { tracker.push('phase4'); });

  return {
    deps: {
      install: install as unknown as RunSetupDeps['install'],
      phase1: phase1 as unknown as RunSetupDeps['phase1'],
      phase2: phase2 as unknown as RunSetupDeps['phase2'],
      phase3: phase3 as unknown as RunSetupDeps['phase3'],
      phase4: phase4 as unknown as RunSetupDeps['phase4'],
      skipSignalHandlers: true,
    },
    install,
    phase1,
    phase2,
    phase3,
    phase4,
  };
}

// ---------------------------------------------------------------------------

describe('runSetup — dispatch + lockfile', () => {
  let tmp: ReturnType<typeof makeTmp>;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp.root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // A4 — wizard TTY fresh install runs all 4 phases
  // -------------------------------------------------------------------------
  it('A4: wizard (all 4 phases) fresh install runs every phase in order', async () => {
    const tracker: string[] = [];
    const { deps } = makePhasesDeps(tracker);

    const options = makeOptions({
      phases: new Set<SetupPhase>(['claude-md', 'infra', 'integrations', 'welcome']),
      interactive: false, // supplied preset, non-TTY ok
    });

    const result = await runSetup(options, {
      ...deps,
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      prompter: makeStubPrompter(),
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(tracker).toEqual(['phase1', 'phase2', 'phase3', 'phase4']);
    expect(result.phasesRun).toEqual(['claude-md', 'infra', 'integrations', 'welcome']);
    // Lockfile released on success.
    expect(existsSync(tmp.lockPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // A21 — already-configured run short-circuits without --force
  // -------------------------------------------------------------------------
  it('A21: already-configured wizard short-circuits with alreadyConfigured flag', async () => {
    // Seed .omc-config.json with `setupCompleted`.
    writeFileSync(
      join(tmp.configDir, '.omc-config.json'),
      JSON.stringify({ setupCompleted: '2026-01-01T00:00:00Z', setupVersion: '1.2.3' }),
    );
    const tracker: string[] = [];
    const { deps } = makePhasesDeps(tracker);

    const options = makeOptions({
      phases: new Set<SetupPhase>(['claude-md', 'infra', 'integrations', 'welcome']),
    });

    const result = await runSetup(options, {
      ...deps,
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      prompter: makeStubPrompter(),
    });

    expect(result.success).toBe(true);
    expect(result.alreadyConfigured).toBe(true);
    expect(tracker).toEqual([]); // no phase ran
  });

  // -------------------------------------------------------------------------
  // A22 — --force bypasses already-configured check
  // -------------------------------------------------------------------------
  it('A22: --force bypasses already-configured check and runs all phases', async () => {
    writeFileSync(
      join(tmp.configDir, '.omc-config.json'),
      JSON.stringify({ setupCompleted: '2026-01-01T00:00:00Z', setupVersion: '1.2.3' }),
    );
    const tracker: string[] = [];
    const { deps } = makePhasesDeps(tracker);

    const options = makeOptions({
      phases: new Set<SetupPhase>(['claude-md', 'infra', 'integrations', 'welcome']),
      force: true,
    });

    const result = await runSetup(options, {
      ...deps,
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      prompter: makeStubPrompter(),
    });

    expect(result.success).toBe(true);
    expect(result.alreadyConfigured).toBeUndefined();
    expect(tracker).toEqual(['phase1', 'phase2', 'phase3', 'phase4']);
  });

  // -------------------------------------------------------------------------
  // A23 / A24 — resume detection skips completed phases
  // -------------------------------------------------------------------------
  it('A23/A24: resume skips phases already completed', async () => {
    // Seed state file: phase 2 was the last completed step.
    const stateDir = join(tmp.cwd, '.omc', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'setup-state.json'),
      JSON.stringify({
        lastCompletedStep: 2,
        timestamp: new Date().toISOString(),
        configType: 'local',
      }),
    );

    const tracker: string[] = [];
    const { deps } = makePhasesDeps(tracker);

    const options = makeOptions({
      phases: new Set<SetupPhase>(['claude-md', 'infra', 'integrations', 'welcome']),
    });

    const result = await runSetup(options, {
      ...deps,
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      prompter: makeStubPrompter(),
    });

    expect(result.success).toBe(true);
    // Only phase 3 and phase 4 should run — phase1/phase2 already recorded.
    expect(tracker).toEqual(['phase3', 'phase4']);
    expect(result.phasesRun).toEqual(['integrations', 'welcome']);
  });

  // -------------------------------------------------------------------------
  // I6 — concurrent lockfile: second invocation blocked
  // -------------------------------------------------------------------------
  it('I6: second concurrent runSetup is blocked by LockHeldError', async () => {
    // Seed a valid lockfile for "our" host + alive PID (self).
    writeFileSync(tmp.lockPath, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      invoker: 'cli',
    }));

    const tracker: string[] = [];
    const { deps } = makePhasesDeps(tracker);

    const options = makeOptions({
      phases: new Set<SetupPhase>(['claude-md', 'infra', 'integrations', 'welcome']),
    });

    const result = await runSetup(options, {
      ...deps,
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      prompter: makeStubPrompter(),
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(75); // EX_TEMPFAIL
    expect(tracker).toEqual([]); // no phase started
    expect(result.errors.join(' ')).toMatch(/already running|different host/);
    // Lock still exists because WE didn't own it.
    expect(existsSync(tmp.lockPath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // I7 — partial failure mid-phase: state reflects last-completed phase
  // -------------------------------------------------------------------------
  it('I7: mid-phase failure persists state up to last-completed phase', async () => {
    const tracker: string[] = [];
    const { deps, phase3 } = makePhasesDeps(tracker);
    phase3.mockImplementationOnce(async () => {
      tracker.push('phase3-throw');
      throw new Error('integrations blew up');
    });

    const options = makeOptions({
      phases: new Set<SetupPhase>(['claude-md', 'infra', 'integrations', 'welcome']),
    });

    const result = await runSetup(options, {
      ...deps,
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      prompter: makeStubPrompter(),
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(tracker).toEqual(['phase1', 'phase2', 'phase3-throw']);
    expect(result.errors.some((e) => e.includes('integrations blew up'))).toBe(true);

    // State file should record phase 2 as last-completed (phase 3 threw before saveState).
    const statePath = join(tmp.cwd, '.omc', 'state', 'setup-state.json');
    expect(existsSync(statePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(parsed.lastCompletedStep).toBe(2);

    // Lockfile released even on error.
    expect(existsSync(tmp.lockPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // J1 — --interactive + non-TTY throws InteractiveRequiredError
  //    (we test the null prompter path by supplying the null prompter
  //    and asking a question through a phase — any question should blow up.)
  // -------------------------------------------------------------------------
  it('J1/J2: null prompter raises on any prompt attempt (non-interactive missing field)', async () => {
    const tracker: string[] = [];
    const { deps, phase1 } = makePhasesDeps(tracker);
    phase1.mockImplementationOnce(async (_opts, _log, _extra, _moreDeps) => {
      // Simulate phase1 trying to ask a question.
      throw new NullPrompterError('target');
    });

    const options = makeOptions({
      phases: new Set<SetupPhase>(['claude-md']),
      interactive: false,
    });

    const result = await runSetup(options, {
      ...deps,
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      prompter: makeStubPrompter(),
    });

    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/target/);
  });

  // -------------------------------------------------------------------------
  // A5 — wizard sub-phase dispatch: ONLY claude-md requested → only phase1 runs
  // -------------------------------------------------------------------------
  it('scoped run (claude-md only) runs phase1 alone', async () => {
    const tracker: string[] = [];
    const { deps } = makePhasesDeps(tracker);

    const options = makeOptions({
      phases: new Set<SetupPhase>(['claude-md']),
    });

    const result = await runSetup(options, {
      ...deps,
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      prompter: makeStubPrompter(),
    });

    expect(result.success).toBe(true);
    expect(tracker).toEqual(['phase1']);
    expect(result.phasesRun).toEqual(['claude-md']);
  });

  // -------------------------------------------------------------------------
  // J5/J6 — --check-state short-circuit: no lock, JSON output
  // -------------------------------------------------------------------------
  it('--check-state emits JSON and does NOT acquire lock', async () => {
    writeFileSync(
      join(tmp.configDir, '.omc-config.json'),
      JSON.stringify({ setupCompleted: '2026-01-01T00:00:00Z', setupVersion: '9.9.9' }),
    );
    // Seed a foreign lockfile — check-state must IGNORE it.
    writeFileSync(tmp.lockPath, JSON.stringify({
      pid: 1, hostname: 'someone-else', startedAt: new Date().toISOString(), invoker: 'cli',
    }));
    const tracker: string[] = [];
    const { deps } = makePhasesDeps(tracker);
    const stdoutLines: string[] = [];

    const options = makeOptions({
      phases: new Set<SetupPhase>(['infra']),
      checkState: true,
    });

    const result = await runSetup(options, {
      ...deps,
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      stdout: (line) => stdoutLines.push(line),
    });

    expect(result.success).toBe(true);
    expect(tracker).toEqual([]); // no install / phase ran
    expect(stdoutLines).toHaveLength(1);
    const payload = JSON.parse(stdoutLines[0]);
    expect(payload.alreadyConfigured).toBe(true);
    expect(payload.setupVersion).toBe('9.9.9');
  });

  // -------------------------------------------------------------------------
  // state-machine sub-phase emits JSON and bypasses the lockfile
  // -------------------------------------------------------------------------
  it('state-machine sub-phase (save/clear/resume/complete) bypasses lockfile', async () => {
    // Foreign lockfile present — state ops must not care.
    writeFileSync(tmp.lockPath, JSON.stringify({
      pid: 1, hostname: 'someone-else', startedAt: new Date().toISOString(), invoker: 'cli',
    }));
    const tracker: string[] = [];
    const { deps } = makePhasesDeps(tracker);
    const stdoutLines: string[] = [];

    // save
    const saveResult = await runSetup(
      makeOptions({
        phases: new Set<SetupPhase>(['state']),
        stateAction: { op: 'save', step: 2, configType: 'local' },
      }),
      {
        ...deps,
        lockPath: tmp.lockPath,
        configDir: tmp.configDir,
        cwd: tmp.cwd,
        stdout: (line) => stdoutLines.push(line),
      },
    );
    expect(saveResult.success).toBe(true);
    expect(tracker).toEqual([]);

    // resume
    const resumeResult = await runSetup(
      makeOptions({
        phases: new Set<SetupPhase>(['state']),
        stateAction: { op: 'resume' },
      }),
      {
        ...deps,
        lockPath: tmp.lockPath,
        configDir: tmp.configDir,
        cwd: tmp.cwd,
        stdout: (line) => stdoutLines.push(line),
      },
    );
    expect(resumeResult.success).toBe(true);
    const resumePayload = JSON.parse(stdoutLines[stdoutLines.length - 1]);
    expect(resumePayload.status).toBe('resume');
    expect(resumePayload.lastStep).toBe(2);

    // clear
    const clearResult = await runSetup(
      makeOptions({
        phases: new Set<SetupPhase>(['state']),
        stateAction: { op: 'clear' },
      }),
      {
        ...deps,
        lockPath: tmp.lockPath,
        configDir: tmp.configDir,
        cwd: tmp.cwd,
        stdout: (line) => stdoutLines.push(line),
      },
    );
    expect(clearResult.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // mcp-only sub-phase: delegates to installMcpServers, no phases run
  // -------------------------------------------------------------------------
  it('mcp-only sub-phase dispatches installMcpServers and no other phase', async () => {
    const tracker: string[] = [];
    const { deps } = makePhasesDeps(tracker);
    const mcpFn = vi.fn(async () => ({
      installed: ['exa'],
      skippedDueToMissingCreds: [],
      failed: [],
    }));

    const options = makeOptions({
      phases: new Set<SetupPhase>(['mcp-only']),
      mcp: {
        enabled: true,
        servers: ['exa'],
        credentials: { exa: 'key' },
        onMissingCredentials: 'skip',
        scope: 'user',
      },
    });

    const result = await runSetup(options, {
      ...deps,
      installMcpServers: mcpFn as never,
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      prompter: makeStubPrompter(),
    });

    expect(result.success).toBe(true);
    expect(mcpFn).toHaveBeenCalledOnce();
    expect(result.phasesRun).toEqual(['mcp-only']);
    expect(result.phaseResults.mcpOnly?.installed).toEqual(['exa']);
    expect(tracker).toEqual([]); // no phase1/2/3/4 ran
    expect(existsSync(tmp.lockPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Bare infra run: calls install() directly, NOT runPhase2
  // -------------------------------------------------------------------------
  it('bare infra-only run calls install() directly, not runPhase2', async () => {
    const tracker: string[] = [];
    const { deps, install, phase2 } = makePhasesDeps(tracker);

    const options = makeOptions({
      phases: new Set<SetupPhase>(['infra']),
    });

    const result = await runSetup(options, {
      ...deps,
      lockPath: tmp.lockPath,
      configDir: tmp.configDir,
      cwd: tmp.cwd,
      prompter: makeStubPrompter(),
    });

    expect(result.success).toBe(true);
    expect(install).toHaveBeenCalledOnce();
    expect(phase2).not.toHaveBeenCalled();
    expect(tracker).toEqual(['install']);
    expect(result.phasesRun).toEqual(['infra']);
  });

  // -------------------------------------------------------------------------
  // install() failure in bare-infra path surfaces as non-zero exit
  // -------------------------------------------------------------------------
  it('bare infra-only run surfaces install() failure with exit code 1', async () => {
    const tracker: string[] = [];
    const { deps, install } = makePhasesDeps(tracker);
    install.mockImplementationOnce(() => {
      tracker.push('install-failed');
      return {
        success: false,
        message: 'broken',
        installedAgents: [],
        installedCommands: [],
        installedSkills: [],
        hooksConfigured: false,
        hookConflicts: [],
        errors: ['disk full', 'permission denied'],
      };
    });

    const result = await runSetup(
      makeOptions({ phases: new Set<SetupPhase>(['infra']) }),
      {
        ...deps,
        lockPath: tmp.lockPath,
        configDir: tmp.configDir,
        cwd: tmp.cwd,
        prompter: makeStubPrompter(),
      },
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.errors).toEqual(['disk full', 'permission denied']);
  });
});

// ---------------------------------------------------------------------------
// Stub prompter — never called in mock-phase tests but required by the API.
// ---------------------------------------------------------------------------
function makeStubPrompter(): Prompter {
  return {
    askSelect: vi.fn(async () => { throw new Error('stub prompter: askSelect called'); }),
    askConfirm: vi.fn(async () => { throw new Error('stub prompter: askConfirm called'); }),
    askText: vi.fn(async () => { throw new Error('stub prompter: askText called'); }),
    askSecret: vi.fn(async () => { throw new Error('stub prompter: askSecret called'); }),
    write: vi.fn(() => undefined),
    close: vi.fn(() => undefined),
  };
}
