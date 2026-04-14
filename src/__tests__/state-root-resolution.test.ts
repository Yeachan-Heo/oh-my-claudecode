/**
 * Regression tests for issue #2532: centralized OMC_STATE_DIR state-root resolution.
 *
 * Verifies that:
 *   1. Default behavior (no OMC_STATE_DIR) is unchanged — state lives in {dir}/.omc/
 *   2. session-start.mjs reads session state from the custom OMC_STATE_DIR location
 *   3. persistent-mode.cjs (stop hook) reads mode state from the custom OMC_STATE_DIR
 *      location and correctly blocks the stop when an active mode is present there
 *   4. pre-tool-enforcer.mjs (PreToolUse hook) reads team-state and writes
 *      skill-active-state through the centralized OMC_STATE_DIR location
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getOmcRoot, clearWorktreeCache } from '../lib/worktree-paths.js';

const NODE = process.execPath;
const REPO_ROOT = resolve(join(__dirname, '..', '..'));
const SESSION_START = join(REPO_ROOT, 'scripts', 'session-start.mjs');
const STOP_HOOK = join(REPO_ROOT, 'scripts', 'persistent-mode.cjs');
const PRE_TOOL_ENFORCER = join(REPO_ROOT, 'scripts', 'pre-tool-enforcer.mjs');

/** Run a hook script synchronously and return the parsed JSON output. */
function runHook(
  scriptPath: string,
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Record<string, unknown> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Remove OMC_STATE_DIR from parent env so only extraEnv controls it
  delete env.OMC_STATE_DIR;
  Object.assign(env, { CLAUDE_PLUGIN_ROOT: REPO_ROOT }, extraEnv);

  const raw = execFileSync(NODE, [scriptPath], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env,
    timeout: 15000,
  }).trim();
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Compute the centralized .omc root path for a given project dir and state dir.
 * Temporarily sets OMC_STATE_DIR so getOmcRoot() returns the centralized path.
 */
function getCentralizedOmcRoot(projectDir: string, stateDir: string): string {
  const prev = process.env.OMC_STATE_DIR;
  try {
    process.env.OMC_STATE_DIR = stateDir;
    clearWorktreeCache();
    return getOmcRoot(projectDir);
  } finally {
    if (prev === undefined) {
      delete process.env.OMC_STATE_DIR;
    } else {
      process.env.OMC_STATE_DIR = prev;
    }
    clearWorktreeCache();
  }
}

describe('OMC_STATE_DIR state-root resolution (issue #2532)', () => {
  let tempDir: string;
  let fakeProject: string;
  let fakeStateDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-state-root-'));
    fakeProject = join(tempDir, 'project');
    fakeStateDir = join(tempDir, 'centralized-state');
    mkdirSync(fakeProject, { recursive: true });
    mkdirSync(fakeStateDir, { recursive: true });
    delete process.env.OMC_STATE_DIR;
    clearWorktreeCache();
  });

  afterEach(() => {
    delete process.env.OMC_STATE_DIR;
    clearWorktreeCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 1. Default state dir (no OMC_STATE_DIR)
  // ────────────────────────────────────────────────────────────────────────────

  it('session-start reads ralph state from default .omc path when OMC_STATE_DIR is not set', () => {
    const sessionId = 'test-session-default';
    const stateDir = join(fakeProject, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'ralph-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        prompt: 'Default-path task',
        iteration: 1,
        max_iterations: 5,
      }),
    );

    const output = runHook(SESSION_START, {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      cwd: fakeProject,
    });

    const context = (output as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('[RALPH LOOP RESTORED]');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 2. Custom OMC_STATE_DIR — session-start
  // ────────────────────────────────────────────────────────────────────────────

  it('session-start reads ralph state from centralized path when OMC_STATE_DIR is set', () => {
    const sessionId = 'test-session-centralized';
    const centralizedOmcRoot = getCentralizedOmcRoot(fakeProject, fakeStateDir);
    const stateDir = join(centralizedOmcRoot, 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'ralph-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        prompt: 'Centralized-state task',
        iteration: 2,
        max_iterations: 10,
      }),
    );

    const output = runHook(
      SESSION_START,
      { hook_event_name: 'SessionStart', session_id: sessionId, cwd: fakeProject },
      { OMC_STATE_DIR: fakeStateDir },
    );

    const context = (output as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('[RALPH LOOP RESTORED]');
    expect(context).toContain('Centralized-state task');
  });

  it('session-start reads ultrawork state from centralized path when OMC_STATE_DIR is set', () => {
    const sessionId = 'test-session-uw-central';
    const centralizedOmcRoot = getCentralizedOmcRoot(fakeProject, fakeStateDir);
    const stateDir = join(centralizedOmcRoot, 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        started_at: '2026-01-01T00:00:00.000Z',
        original_prompt: 'Centralized ultrawork task',
      }),
    );

    const output = runHook(
      SESSION_START,
      { hook_event_name: 'SessionStart', session_id: sessionId, cwd: fakeProject },
      { OMC_STATE_DIR: fakeStateDir },
    );

    const context = (output as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('[ULTRAWORK MODE RESTORED]');
    expect(context).toContain('Centralized ultrawork task');
  });

  it('session-start does NOT restore state when OMC_STATE_DIR is set but state is only in default .omc', () => {
    const sessionId = 'test-session-only-default';
    // Place state ONLY in the default .omc location
    const defaultStateDir = join(fakeProject, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(defaultStateDir, { recursive: true });
    writeFileSync(
      join(defaultStateDir, 'ralph-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        prompt: 'Should not restore from default when OMC_STATE_DIR is set',
        iteration: 1,
        max_iterations: 5,
      }),
    );

    // Run with OMC_STATE_DIR pointing elsewhere — centralized location is empty
    const output = runHook(
      SESSION_START,
      { hook_event_name: 'SessionStart', session_id: sessionId, cwd: fakeProject },
      { OMC_STATE_DIR: fakeStateDir },
    );

    const context = (output as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext ?? '';
    expect(context).not.toContain('[RALPH LOOP RESTORED]');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 3. Custom OMC_STATE_DIR — stop hook (persistent-mode.cjs)
  // ────────────────────────────────────────────────────────────────────────────

  it('stop hook blocks when active ralph state is in default .omc path (baseline)', () => {
    const sessionId = 'test-stop-default';
    const stateDir = join(fakeProject, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'ralph-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        prompt: 'Stop hook baseline task',
        iteration: 1,
        max_iterations: 5,
        started_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
      }),
    );

    const output = runHook(STOP_HOOK, {
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: fakeProject,
    });

    expect(output.decision).toBe('block');
    expect(String(output.reason)).toContain('[RALPH LOOP');
  });

  it('stop hook blocks when active ralph state is in centralized OMC_STATE_DIR path', () => {
    const sessionId = 'test-stop-centralized';
    const centralizedOmcRoot = getCentralizedOmcRoot(fakeProject, fakeStateDir);
    const stateDir = join(centralizedOmcRoot, 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'ralph-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        prompt: 'Stop hook centralized task',
        iteration: 1,
        max_iterations: 5,
        started_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
      }),
    );

    // No .omc in fakeProject — active state ONLY in centralized dir
    const output = runHook(
      STOP_HOOK,
      { hook_event_name: 'Stop', session_id: sessionId, cwd: fakeProject },
      { OMC_STATE_DIR: fakeStateDir },
    );

    expect(output.decision).toBe('block');
    expect(String(output.reason)).toContain('[RALPH LOOP');
  });

  it('stop hook does NOT block when OMC_STATE_DIR is set but state is only in default .omc', () => {
    const sessionId = 'test-stop-mismatch';
    // Place active state in default location only
    const defaultStateDir = join(fakeProject, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(defaultStateDir, { recursive: true });
    writeFileSync(
      join(defaultStateDir, 'ralph-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        prompt: 'Should be invisible to centralized hook',
        iteration: 1,
        max_iterations: 5,
      }),
    );

    // Run stop hook with OMC_STATE_DIR — centralized path is empty → no block
    const output = runHook(
      STOP_HOOK,
      { hook_event_name: 'Stop', session_id: sessionId, cwd: fakeProject },
      { OMC_STATE_DIR: fakeStateDir },
    );

    expect(output.decision).not.toBe('block');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 4. pre-tool-enforcer.mjs (PreToolUse hook) — follow-up to #2532
  //    Scenario: enforcer must read team-state and write skill-active-state
  //    from the same centralized OMC_STATE_DIR location as sibling hooks.
  // ────────────────────────────────────────────────────────────────────────────

  it('pre-tool-enforcer injects [TEAM ROUTING REQUIRED] when team-state lives in default .omc (baseline)', () => {
    const sessionId = 'test-pte-team-default';
    const stateDir = join(fakeProject, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'team-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        team_name: 'alpha',
        current_phase: 'team-exec',
      }),
    );

    const output = runHook(PRE_TOOL_ENFORCER, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: { subagent_type: 'executor', description: 'sample task' },
      session_id: sessionId,
      cwd: fakeProject,
    });

    const context = (output as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('[TEAM ROUTING REQUIRED]');
    expect(context).toContain('alpha');
  });

  it('pre-tool-enforcer injects [TEAM ROUTING REQUIRED] when team-state lives in centralized OMC_STATE_DIR', () => {
    const sessionId = 'test-pte-team-central';
    const centralizedOmcRoot = getCentralizedOmcRoot(fakeProject, fakeStateDir);
    const stateDir = join(centralizedOmcRoot, 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'team-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        team_name: 'beta',
        current_phase: 'team-exec',
      }),
    );

    // No .omc in fakeProject — active team-state ONLY in centralized dir
    const output = runHook(
      PRE_TOOL_ENFORCER,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: { subagent_type: 'executor', description: 'sample task' },
        session_id: sessionId,
        cwd: fakeProject,
      },
      { OMC_STATE_DIR: fakeStateDir },
    );

    const context = (output as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('[TEAM ROUTING REQUIRED]');
    expect(context).toContain('beta');
  });

  it('pre-tool-enforcer ignores stale team-state in default .omc when OMC_STATE_DIR is set', () => {
    const sessionId = 'test-pte-team-mismatch';
    // Place active team-state in default location only
    const stateDir = join(fakeProject, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'team-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        team_name: 'gamma',
        current_phase: 'team-exec',
      }),
    );

    // Run with OMC_STATE_DIR pointing elsewhere — centralized path is empty → no redirect
    const output = runHook(
      PRE_TOOL_ENFORCER,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: { subagent_type: 'executor', description: 'sample task' },
        session_id: sessionId,
        cwd: fakeProject,
      },
      { OMC_STATE_DIR: fakeStateDir },
    );

    const context = (output as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext ?? '';
    expect(context).not.toContain('[TEAM ROUTING REQUIRED]');
  });

  it('pre-tool-enforcer writes skill-active-state into the centralized OMC_STATE_DIR path', () => {
    const sessionId = 'test-pte-skill-central';
    const centralizedOmcRoot = getCentralizedOmcRoot(fakeProject, fakeStateDir);

    runHook(
      PRE_TOOL_ENFORCER,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        // `skill` needs a non-'none' protection level. The OMC-prefixed `skill`
        // slash-command maps to 'light' protection, which triggers the write.
        tool_input: { skill: 'oh-my-claudecode:skill' },
        session_id: sessionId,
        cwd: fakeProject,
      },
      { OMC_STATE_DIR: fakeStateDir },
    );

    const centralizedPath = join(
      centralizedOmcRoot,
      'state',
      'sessions',
      sessionId,
      'skill-active-state.json',
    );
    const defaultPath = join(
      fakeProject,
      '.omc',
      'state',
      'sessions',
      sessionId,
      'skill-active-state.json',
    );
    expect(existsSync(centralizedPath)).toBe(true);
    expect(existsSync(defaultPath)).toBe(false);
  });
});
