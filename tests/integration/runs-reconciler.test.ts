import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = process.cwd();
const script = join(root, 'scripts', 'runs-reconciler.mjs');
const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

// The state resolver falls back to the home .omc root when the directory is
// not inside a git repo — fixtures must be git repos so the hook scans the
// fixture's state root, not the developer's real one.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-runs-reconciler-'));
  fixtures.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function writeLedger(dir: string, lines: Array<Record<string, unknown>>): void {
  const ledgerPath = join(dir, '.omc', 'state', 'runs', 'ledger.jsonl');
  mkdirSync(join(ledgerPath, '..'), { recursive: true });
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

interface RunResult {
  stdout: string;
  parsed: { suppressOutput?: boolean; hookSpecificOutput?: { additionalContext?: string } };
}

function runReporter(payload: Record<string, unknown>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      cwd: root,
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

describe('runs reconciler hook', () => {
  // Generate recent timestamps relative to now to avoid time-bomb failures (issue #4215 CI unblock).
  // Keep deliberately-old 2020 fixtures as-is for lookback window tests.
  const now = Date.now();
  const recentStart = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const recentEnd = new Date(now - 1 * 60 * 60 * 1000).toISOString();
  const recentEnd2 = new Date(now - 30 * 60 * 1000).toISOString();

  it('reports ended runs missing their closeout as advisory context', async () => {
    const dir = fixture();
    writeLedger(dir, [
      { ts: recentStart, run: 'ralph', sessionId: 's1', event: 'start', outcome: 'running' },
      { ts: recentEnd, run: 'ralph', sessionId: 's1', event: 'end', outcome: 'completed', closeoutWritten: false },
    ]);
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('[RUN RECONCILIATION]');
    expect(ctx).toContain('ralph (session s1)');
    expect(ctx).toContain('unattended run(s) ended without a notepad closeout');
    expect(ctx).not.toContain('completed unattended');
  });

  it('reports a cancelled run without claiming it completed', async () => {
    const dir = fixture();
    writeLedger(dir, [
      { ts: recentEnd, run: 'team', sessionId: 's2', event: 'end', outcome: 'cancelled', closeoutWritten: false },
    ]);
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('1 unattended run(s) ended without a notepad closeout');
    expect(ctx).toContain('- team (session s2): ended');
  });

  it('stays silent when every ended run wrote its closeout', async () => {
    const dir = fixture();
    writeLedger(dir, [
      { ts: recentStart, run: 'ralph', event: 'start', outcome: 'running' },
      { ts: recentEnd, run: 'ralph', event: 'end', outcome: 'completed', closeoutWritten: true },
    ]);
    const result = await runReporter({ cwd: dir });
    expect(result.parsed.suppressOutput).toBe(true);
  });

  it('ignores findings older than the lookback window', async () => {
    const dir = fixture();
    writeLedger(dir, [
      { ts: '2020-01-01T00:00:00Z', run: 'ralph', event: 'end', outcome: 'completed', closeoutWritten: false },
    ]);
    const result = await runReporter({ cwd: dir });
    expect(result.parsed.suppressOutput).toBe(true);
  });

  it('tolerates a missing ledger and malformed lines', async () => {
    const dir = fixture();
    const result = await runReporter({ cwd: dir });
    expect(result.parsed.suppressOutput).toBe(true);
    writeLedger(dir, [{ broken: true }, { ts: recentEnd, run: 'autopilot', event: 'end', outcome: 'failed', closeoutWritten: false }]);
    const second = await runReporter({ cwd: dir });
    const ctx = second.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('autopilot');
  });

  it('deduplicates per run+session, keeping only the latest end edge', async () => {
    const dir = fixture();
    writeLedger(dir, [
      { ts: recentStart, run: 'ralph', sessionId: 's1', event: 'start', outcome: 'running' },
      { ts: recentEnd, run: 'ralph', sessionId: 's1', event: 'end', outcome: 'completed', closeoutWritten: false },
      { ts: recentEnd2, run: 'ralph', sessionId: 's1', event: 'end', outcome: 'cancelled', closeoutWritten: true },
    ]);
    const result = await runReporter({ cwd: dir });
    expect(result.parsed.suppressOutput).toBe(true);
  });
});
