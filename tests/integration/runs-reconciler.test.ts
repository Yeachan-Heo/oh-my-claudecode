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
  it('reports completed runs missing their closeout as advisory context', async () => {
    const dir = fixture();
    writeLedger(dir, [
      { ts: '2026-09-27T00:00:00Z', run: 'ralph', sessionId: 's1', event: 'start', outcome: 'running' },
      { ts: '2026-09-27T01:00:00Z', run: 'ralph', sessionId: 's1', event: 'end', outcome: 'completed', closeoutWritten: false },
    ]);
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('[RUN RECONCILIATION]');
    expect(ctx).toContain('ralph (session s1)');
    expect(ctx).toContain('never wrote their closeout');
  });

  it('stays silent when every ended run wrote its closeout', async () => {
    const dir = fixture();
    writeLedger(dir, [
      { ts: '2026-09-27T00:00:00Z', run: 'ralph', event: 'start', outcome: 'running' },
      { ts: '2026-09-27T01:00:00Z', run: 'ralph', event: 'end', outcome: 'completed', closeoutWritten: true },
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
    writeLedger(dir, [{ broken: true }, { ts: '2026-09-27T00:00:00Z', run: 'autopilot', event: 'end', outcome: 'failed', closeoutWritten: false }]);
    const second = await runReporter({ cwd: dir });
    const ctx = second.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('autopilot');
  });

  it('deduplicates per run+session, keeping only the latest end edge', async () => {
    const dir = fixture();
    writeLedger(dir, [
      { ts: '2026-09-27T00:00:00Z', run: 'ralph', sessionId: 's1', event: 'start', outcome: 'running' },
      { ts: '2026-09-27T01:00:00Z', run: 'ralph', sessionId: 's1', event: 'end', outcome: 'completed', closeoutWritten: false },
      { ts: '2026-09-27T02:00:00Z', run: 'ralph', sessionId: 's1', event: 'end', outcome: 'cancelled', closeoutWritten: true },
    ]);
    const result = await runReporter({ cwd: dir });
    expect(result.parsed.suppressOutput).toBe(true);
  });
});
