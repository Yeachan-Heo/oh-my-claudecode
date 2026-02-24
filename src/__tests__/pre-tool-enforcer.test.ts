import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Integration tests for scripts/pre-tool-enforcer.mjs
 *
 * Verifies that the boulder message is only injected when an OMC mode
 * is actually active (issue #970).
 */

const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'pre-tool-enforcer.mjs');
const NODE = process.execPath;

function runEnforcer(input: Record<string, unknown>, env: Record<string, string> = {}): {
  continue: boolean;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  suppressOutput?: boolean;
} {
  const result = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 10000,
  });
  return JSON.parse(result.trim());
}

describe('pre-tool-enforcer: boulder message gating (issue #970)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-enforcer-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns tool-specific message for known tools regardless of mode state', () => {
    const result = runEnforcer({ tool_name: 'Bash', cwd: tempDir });
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toContain('parallel execution');
  });

  it('suppresses boulder message when no OMC mode is active', () => {
    const result = runEnforcer({ tool_name: 'WebFetch', cwd: tempDir });
    expect(result.continue).toBe(true);
    // Should NOT have additionalContext with boulder message
    expect(result.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('injects boulder message when legacy ultrawork state is active', () => {
    const stateDir = join(tempDir, '.omc', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'ultrawork-state.json'),
      JSON.stringify({ active: true, iteration: 1 })
    );

    const result = runEnforcer({ tool_name: 'WebFetch', cwd: tempDir });
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toContain('The boulder never stops');
  });

  it('injects boulder message when session-scoped ralph state is active', () => {
    const sessionDir = join(tempDir, '.omc', 'state', 'sessions', 'test-session-123');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'ralph-state.json'),
      JSON.stringify({ active: true, iteration: 3 })
    );

    const result = runEnforcer({ tool_name: 'mcp__custom__tool', cwd: tempDir });
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toContain('The boulder never stops');
  });

  it('suppresses boulder message when state file has active: false', () => {
    const stateDir = join(tempDir, '.omc', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'ultrawork-state.json'),
      JSON.stringify({ active: false, iteration: 5 })
    );

    const result = runEnforcer({ tool_name: 'WebFetch', cwd: tempDir });
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('injects boulder message when swarm marker exists', () => {
    const stateDir = join(tempDir, '.omc', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'swarm-active.marker'), '');

    const result = runEnforcer({ tool_name: 'Skill', cwd: tempDir });
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toContain('The boulder never stops');
  });

  it('suppresses output entirely when DISABLE_OMC is set', () => {
    const result = runEnforcer({ tool_name: 'Bash', cwd: tempDir }, { DISABLE_OMC: '1' });
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });
});
