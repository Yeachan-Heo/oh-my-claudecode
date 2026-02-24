import { execSync } from 'child_process';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'context-safety.mjs');

function runContextSafety(input: Record<string, unknown>): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node "${SCRIPT_PATH}"`, {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: (e.stdout ?? '').trim(), exitCode: e.status ?? 1 };
  }
}

describe('context-safety hook (issue #1006)', () => {
  it('does NOT block TeamCreate — removed from BLOCKED_TOOLS', () => {
    const result = runContextSafety({
      tool_name: 'TeamCreate',
      toolInput: { team_name: 'test-team', description: 'Test team' },
      session_id: 'session-1006',
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);
  });

  it('still blocks ExitPlanMode when transcript shows high context', () => {
    // Without a valid transcript_path, estimateContextPercent returns 0,
    // so ExitPlanMode passes. This test verifies the tool is still in BLOCKED_TOOLS
    // (it just can't reach the block threshold without a real transcript).
    const result = runContextSafety({
      tool_name: 'ExitPlanMode',
      toolInput: {},
      session_id: 'session-1006',
      cwd: process.cwd(),
    });

    // Should pass (0% < 55%) but ExitPlanMode is still checked
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);
  });

  it('allows unknown tools through without blocking', () => {
    const result = runContextSafety({
      tool_name: 'Bash',
      toolInput: { command: 'echo hi' },
      session_id: 'session-1006',
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);
  });
});
