import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');

function runPreToolEnforcer(input: Record<string, unknown>): Record<string, unknown> {
  const stdout = execSync(`node "${SCRIPT_PATH}"`, {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 5000,
    env: { ...process.env, NODE_ENV: 'test' },
  });

  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

function writeJson(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

describe('pre-tool-enforcer fallback gating (issue #970)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pre-tool-enforcer-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('suppresses unknown-tool fallback when no active mode exists', () => {
    const output = runPreToolEnforcer({
      tool_name: 'ToolSearch',
      cwd: tempDir,
      session_id: 'session-970',
    });

    expect(output).toEqual({ continue: true, suppressOutput: true });
  });

  it('emits boulder fallback for unknown tools when session-scoped mode is active', () => {
    const sessionId = 'session-970';
    writeJson(
      join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'),
      {
        active: true,
        session_id: sessionId,
      },
    );

    const output = runPreToolEnforcer({
      tool_name: 'ToolSearch',
      cwd: tempDir,
      session_id: sessionId,
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(hookSpecificOutput.additionalContext).toContain('The boulder never stops');
  });

  it('does not fall back to legacy mode files when a valid session_id is provided', () => {
    writeJson(join(tempDir, '.omc', 'state', 'ralph-state.json'), {
      active: true,
    });

    const output = runPreToolEnforcer({
      tool_name: 'mcp__omx_state__state_read',
      cwd: tempDir,
      session_id: 'session-970',
    });

    expect(output).toEqual({ continue: true, suppressOutput: true });
  });

  it('uses legacy mode files when session_id is not provided', () => {
    writeJson(join(tempDir, '.omc', 'state', 'ultrawork-state.json'), {
      active: true,
    });

    const output = runPreToolEnforcer({
      tool_name: 'mcp__omx_state__state_read',
      cwd: tempDir,
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookSpecificOutput.additionalContext).toContain('The boulder never stops');
  });

  // === Team-routing enforcement tests (issue #1006) ===

  it('injects team-routing redirect when Task called without team_name during active team session', () => {
    const sessionId = 'session-1006';
    writeJson(
      join(tempDir, '.omc', 'state', 'sessions', sessionId, 'team-state.json'),
      {
        active: true,
        session_id: sessionId,
        team_name: 'fix-ts-errors',
      },
    );

    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Fix type errors',
        prompt: 'Fix all type errors in src/auth/',
      },
      cwd: tempDir,
      session_id: sessionId,
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookSpecificOutput.additionalContext).toContain('TEAM ROUTING REQUIRED');
    expect(hookSpecificOutput.additionalContext).toContain('fix-ts-errors');
    expect(hookSpecificOutput.additionalContext).toContain('team_name=');
  });

  it('does NOT inject team-routing redirect when Task called WITH team_name', () => {
    const sessionId = 'session-1006b';
    writeJson(
      join(tempDir, '.omc', 'state', 'sessions', sessionId, 'team-state.json'),
      {
        active: true,
        session_id: sessionId,
        team_name: 'fix-ts-errors',
      },
    );

    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        team_name: 'fix-ts-errors',
        name: 'worker-1',
        description: 'Fix type errors',
        prompt: 'Fix all type errors in src/auth/',
      },
      cwd: tempDir,
      session_id: sessionId,
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    // Should be a normal spawn message, not a redirect
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('TEAM ROUTING REQUIRED');
    expect(String(hookSpecificOutput.additionalContext)).toContain('Spawning agent');
  });

  it('does NOT inject team-routing redirect when no team state is active', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Fix type errors',
        prompt: 'Fix all type errors in src/auth/',
      },
      cwd: tempDir,
      session_id: 'session-no-team',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('TEAM ROUTING REQUIRED');
    expect(String(hookSpecificOutput.additionalContext)).toContain('Spawning agent');
  });

  it('reads team state from legacy path when session_id is absent', () => {
    writeJson(join(tempDir, '.omc', 'state', 'team-state.json'), {
      active: true,
      team_name: 'legacy-team',
    });

    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Fix something',
        prompt: 'Fix it',
      },
      cwd: tempDir,
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookSpecificOutput.additionalContext).toContain('TEAM ROUTING REQUIRED');
    expect(hookSpecificOutput.additionalContext).toContain('legacy-team');
  });

  it('respects session isolation — ignores team state from different session', () => {
    writeJson(
      join(tempDir, '.omc', 'state', 'sessions', 'other-session', 'team-state.json'),
      {
        active: true,
        session_id: 'other-session',
        team_name: 'other-team',
      },
    );

    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Fix something',
        prompt: 'Fix it',
      },
      cwd: tempDir,
      session_id: 'my-session',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('TEAM ROUTING REQUIRED');
  });

  it('keeps known tool messages unchanged (Bash, Read)', () => {
    const bash = runPreToolEnforcer({
      tool_name: 'Bash',
      cwd: tempDir,
    });
    const bashOutput = bash.hookSpecificOutput as Record<string, unknown>;
    expect(bashOutput.additionalContext).toBe(
      'Use parallel execution for independent tasks. Use run_in_background for long operations (npm install, builds, tests).',
    );

    const read = runPreToolEnforcer({
      tool_name: 'Read',
      cwd: tempDir,
    });
    const readOutput = read.hookSpecificOutput as Record<string, unknown>;
    expect(readOutput.additionalContext).toBe(
      'Read multiple files in parallel when possible for faster analysis.',
    );
  });
});
