import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = process.cwd();
const script = join(root, 'scripts', 'stale-run-reporter.mjs');
const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

// The state resolver falls back to the home .omc root when the directory is
// not inside a git repo — fixtures must be git repos so the hook scans the
// fixture's state root, not the developer's real one.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-stale-run-'));
  fixtures.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function writeModeState(dir: string, mode: string, state: Record<string, unknown>, sessionId?: string, ageHours?: number): string {
  const statePath = sessionId
    ? join(dir, '.omc', 'state', 'sessions', sessionId, `${mode}-state.json`)
    : join(dir, '.omc', 'state', `${mode}-state.json`);
  mkdirSync(join(statePath, '..'), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (ageHours !== undefined) {
    const past = new Date(Date.now() - ageHours * 3600_000);
    utimesSync(statePath, past, past);
  }
  return statePath;
}

interface RunResult {
  stdout: string;
  parsed: { suppressOutput?: boolean; hookSpecificOutput?: { additionalContext?: string } };
}

function runReporter(payload: Record<string, unknown>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      cwd: (payload.cwd as string) ?? root,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', reject);
    child.on('close', () => resolve({ stdout, parsed: JSON.parse(stdout) }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

describe('stale-run reporter hook', () => {
  it('reports a stale legacy active state as advisory context', async () => {
    const dir = fixture();
    writeModeState(dir, 'ralph', { active: true, iteration: 3 }, undefined, 9);
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('[STALE RUN]');
    expect(ctx).toContain('ralph');
    expect(ctx).toContain('~9h');
    expect(ctx).toContain('Re-kicking is a human decision');
  });

  it('reports a stale session-scoped state with its session id', async () => {
    const dir = fixture();
    writeModeState(dir, 'autopilot', { active: true }, 'sess-dead-1', 5);
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('autopilot (session sess-dead-1)');
  });

  it('stays silent when every active state is fresh', async () => {
    const dir = fixture();
    writeModeState(dir, 'ralph', { active: true }, undefined, 0.1);
    const result = await runReporter({ cwd: dir });
    expect(result.parsed.suppressOutput).toBe(true);
    expect(result.parsed.hookSpecificOutput).toBeUndefined();
  });

  it('ignores inactive state files', async () => {
    const dir = fixture();
    writeModeState(dir, 'ralph', { active: false }, undefined, 99);
    const result = await runReporter({ cwd: dir });
    expect(result.parsed.suppressOutput).toBe(true);
  });

  it('ignores malformed state files instead of failing', async () => {
    const dir = fixture();
    const statePath = join(dir, '.omc', 'state', 'team-state.json');
    mkdirSync(join(statePath, '..'), { recursive: true });
    writeFileSync(statePath, '{ not json');
    const result = await runReporter({ cwd: dir });
    expect(result.parsed.suppressOutput).toBe(true);
  });

  it('excludes the current session own state from the report', async () => {
    const dir = fixture();
    writeModeState(dir, 'autopilot', { active: true }, 'sess-current', 9);
    const result = await runReporter({ cwd: dir, session_id: 'sess-current' });
    expect(result.parsed.suppressOutput).toBe(true);
  });

  it('sorts entries most-stale first', async () => {
    const dir = fixture();
    writeModeState(dir, 'ralph', { active: true }, undefined, 4);
    writeModeState(dir, 'team', { active: true }, undefined, 30);
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx.indexOf('team')).toBeLessThan(ctx.indexOf('ralph'));
  });
});
