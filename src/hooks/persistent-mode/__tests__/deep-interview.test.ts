import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';

function makeTempProject(): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'di-stop-'));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
  return tempDir;
}

function writeDeepInterviewState(
  tempDir: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
  innerOverrides: Record<string, unknown> = {},
): string {
  const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'deep-interview-state.json');
  const now = new Date().toISOString();
  writeFileSync(
    path,
    JSON.stringify(
      {
        active: true,
        current_phase: 'deep-interview',
        session_id: sessionId,
        started_at: now,
        last_checked_at: now,
        ...overrides,
        state: {
          interview_id: 'test-uuid',
          type: 'greenfield',
          initial_idea: 'test idea',
          rounds: [{ q: 'Q1', a: 'A1' }],
          current_ambiguity: 0.6,
          threshold: 0.2,
          codebase_context: null,
          challenge_modes_used: [],
          ontology_snapshots: [],
          ...innerOverrides,
        },
      },
      null,
      2,
    ),
  );
  return path;
}

describe('deep-interview stop hook', () => {
  let tempDir: string;
  let savedCwd: string;
  let savedDisableOmc: string | undefined;
  let savedSkipHooks: string | undefined;
  let savedTeamWorker: string | undefined;

  beforeEach(() => {
    tempDir = makeTempProject();
    savedCwd = process.cwd();
    process.chdir(tempDir);
    // Scrub OMC kill switches that would short-circuit checkPersistentModes.
    // The OMC plugin itself sets OMC_SKIP_HOOKS=persistent-mode in some shells
    // for the user's own session — we don't want that bleeding into test runs.
    savedDisableOmc = process.env.DISABLE_OMC;
    savedSkipHooks = process.env.OMC_SKIP_HOOKS;
    savedTeamWorker = process.env.OMC_TEAM_WORKER;
    delete process.env.DISABLE_OMC;
    delete process.env.OMC_SKIP_HOOKS;
    delete process.env.OMC_TEAM_WORKER;
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(tempDir, { recursive: true, force: true });
    if (savedDisableOmc === undefined) delete process.env.DISABLE_OMC;
    else process.env.DISABLE_OMC = savedDisableOmc;
    if (savedSkipHooks === undefined) delete process.env.OMC_SKIP_HOOKS;
    else process.env.OMC_SKIP_HOOKS = savedSkipHooks;
    if (savedTeamWorker === undefined) delete process.env.OMC_TEAM_WORKER;
    else process.env.OMC_TEAM_WORKER = savedTeamWorker;
  });

  it('returns no-block when no deep-interview state exists', async () => {
    const result = await checkPersistentModes('di-empty', tempDir);
    expect(result.shouldBlock).toBe(false);
    expect(result.mode).toBe('none');
  });

  it('returns no-block when active=false', async () => {
    const sessionId = 'di-inactive';
    writeDeepInterviewState(tempDir, sessionId, { active: false });
    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.shouldBlock).toBe(false);
  });

  it('blocks when active and ambiguity above threshold', async () => {
    const sessionId = 'di-mid-loop';
    writeDeepInterviewState(tempDir, sessionId, {}, {
      current_ambiguity: 0.55,
      threshold: 0.2,
    });
    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.shouldBlock).toBe(true);
    expect(result.mode).toBe('deep-interview');
    expect(result.message).toContain('DEEP-INTERVIEW LOOP');
    expect(result.message).toContain('Round 1');
    expect(result.message).toContain('55%');
    expect(result.message).toContain('20%');
  });

  it('passes through (no-block) when ambiguity has dropped to threshold', async () => {
    const sessionId = 'di-terminal';
    writeDeepInterviewState(tempDir, sessionId, {}, {
      current_ambiguity: 0.2,
      threshold: 0.2,
    });
    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.shouldBlock).toBe(false);
    expect(result.mode).toBe('deep-interview');
  });

  it('passes through (no-block) when ambiguity has dropped below threshold', async () => {
    const sessionId = 'di-terminal-below';
    writeDeepInterviewState(tempDir, sessionId, {}, {
      current_ambiguity: 0.15,
      threshold: 0.2,
    });
    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.shouldBlock).toBe(false);
  });

  it('honors top-level user_exit_requested', async () => {
    const sessionId = 'di-exit-top';
    writeDeepInterviewState(tempDir, sessionId, { user_exit_requested: true }, {
      current_ambiguity: 0.55,
    });
    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.shouldBlock).toBe(false);
  });

  it('honors nested state.user_exit_requested', async () => {
    const sessionId = 'di-exit-nested';
    writeDeepInterviewState(tempDir, sessionId, {}, {
      current_ambiguity: 0.55,
      user_exit_requested: true,
    });
    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.shouldBlock).toBe(false);
  });

  it('does not block while awaiting_confirmation is set', async () => {
    const sessionId = 'di-awaiting';
    writeDeepInterviewState(tempDir, sessionId, {
      awaiting_confirmation: true,
      awaiting_confirmation_set_at: new Date().toISOString(),
    });
    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.shouldBlock).toBe(false);
  });

  it('isolates by session_id (other-session state is ignored)', async () => {
    writeDeepInterviewState(tempDir, 'session-A');
    const result = await checkPersistentModes('session-B', tempDir);
    expect(result.shouldBlock).toBe(false);
    expect(result.mode).toBe('none');
  });

  it('exhausts the circuit breaker after MAX reinforcements and deactivates', async () => {
    const sessionId = 'di-breaker';
    const statePath = writeDeepInterviewState(tempDir, sessionId, {}, {
      current_ambiguity: 0.55,
      threshold: 0.2,
    });

    let lastResult;
    // First call increments breaker to 1, second to 2, ... 30th still blocks,
    // 31st trips (count > MAX === 30) and deactivates.
    for (let i = 0; i < 31; i += 1) {
      lastResult = await checkPersistentModes(sessionId, tempDir);
    }

    expect(lastResult).toBeDefined();
    expect(lastResult!.shouldBlock).toBe(false);
    expect(lastResult!.mode).toBe('deep-interview');
    expect(lastResult!.message).toContain('CIRCUIT BREAKER');

    // State file should now be deactivated with a reason.
    const persisted = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    expect(persisted.active).toBe(false);
    expect(persisted.deactivated_reason).toBe('stop_breaker_exhausted');
  });

  it('respects DISABLE_OMC kill switch', async () => {
    process.env.DISABLE_OMC = '1';
    const sessionId = 'di-kill-switch';
    writeDeepInterviewState(tempDir, sessionId);
    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.shouldBlock).toBe(false);
    expect(result.mode).toBe('none');
    // afterEach restores DISABLE_OMC.
  });
});
