import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { DEFAULT_STALL_THRESHOLD_MS, detectStalledLinks, flagStall, type StalledLink } from './watchdog.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-factory-watchdog-'));
  tempRoots.push(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
});

const NOW = new Date('2026-09-28T12:00:00Z');

function writeLedger(factoryDir: string, sessionId: string, ledger: Record<string, unknown>, ageMs = 0): void {
  mkdirSync(factoryDir, { recursive: true });
  const path = join(factoryDir, `chain-${sessionId}.json`);
  writeFileSync(path, JSON.stringify(ledger), 'utf8');
  if (ageMs > 0) {
    const past = new Date(NOW.getTime() - ageMs);
    utimesSync(path, past, past);
  }
}

describe('detectStalledLinks', () => {
  it('reports a no-routeTable ledger past the threshold with intentId, session, stage, and age', () => {
    const dir = tempDir();
    const factoryDir = join(dir, '.omc', 'state', 'factory');
    const session = randomUUID();
    const ageMs = DEFAULT_STALL_THRESHOLD_MS + 60_000;
    writeLedger(factoryDir, session, { intentId: 'acme/widget#12', stage: 'intent' }, ageMs);

    const stalls = detectStalledLinks(factoryDir, { now: NOW });
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ intentId: 'acme/widget#12', session, stage: 'intent' });
    expect(stalls[0].stalledForMs).toBeGreaterThanOrEqual(DEFAULT_STALL_THRESHOLD_MS);
  });

  it('does not report ledgers that carry a routeTable', () => {
    const dir = tempDir();
    const factoryDir = join(dir, '.omc', 'state', 'factory');
    writeLedger(factoryDir, randomUUID(), {
      intentId: 'acme/widget#12',
      stage: 'plan',
      routeTable: { 'success:plan': { stage: 'build', skill: 'build' } },
    }, DEFAULT_STALL_THRESHOLD_MS + 60_000);

    expect(detectStalledLinks(factoryDir, { now: NOW })).toEqual([]);
  });

  it('does not report a fresh no-routeTable ledger', () => {
    const dir = tempDir();
    const factoryDir = join(dir, '.omc', 'state', 'factory');
    writeLedger(factoryDir, randomUUID(), { intentId: 'acme/widget#12', stage: 'intent' }, DEFAULT_STALL_THRESHOLD_MS - 60_000);

    expect(detectStalledLinks(factoryDir, { now: NOW })).toEqual([]);
  });

  it('does not report a no-routeTable ledger whose session was already enqueued', () => {
    const dir = tempDir();
    const factoryDir = join(dir, '.omc', 'state', 'factory');
    const session = randomUUID();
    writeLedger(factoryDir, session, { intentId: 'acme/widget#12', stage: 'intent' }, DEFAULT_STALL_THRESHOLD_MS + 60_000);
    // The enqueuer never rewrites the ledger; it only records the decision.
    writeFileSync(join(factoryDir, 'chain-decisions.jsonl'), `${JSON.stringify({ decision: 'enqueued', sessionId: session, intentId: 'acme/widget#12' })}\n`, 'utf8');

    expect(detectStalledLinks(factoryDir, { now: NOW })).toEqual([]);
  });

  it('returns empty for a missing factory dir and ignores non-ledger files', () => {
    const dir = tempDir();
    const factoryDir = join(dir, '.omc', 'state', 'factory');
    expect(detectStalledLinks(factoryDir, { now: NOW })).toEqual([]);

    mkdirSync(factoryDir, { recursive: true });
    writeFileSync(join(factoryDir, 'chain-usage.json'), '{}', 'utf8');
    writeFileSync(join(factoryDir, `chain-${randomUUID()}.stopped.json`), '{}', 'utf8');
    writeFileSync(join(factoryDir, 'chain-decisions.jsonl'), '{}\n', 'utf8');
    writeFileSync(join(factoryDir, `chain-${randomUUID()}.json`), '{broken', 'utf8');
    expect(detectStalledLinks(factoryDir, { now: NOW })).toEqual([]);
  });
});

describe('flagStall', () => {
  const stall: StalledLink = {
    intentId: 'acme/widget#12',
    session: randomUUID(),
    stage: 'intent',
    stalledForMs: 45 * 60_000,
  };
  const tracker = { repo: 'acme/widget', issue: 12, nextLabel: 'factory:plan', failedLabel: 'factory:failed' };

  it('labels and comments the tracker issue with harbor:need-info when a tracker is present', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    flagStall({ ...stall, tracker }, { cwd: tempDir(), spawner: (cmd, args) => { calls.push({ cmd, args }); } });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      cmd: 'gh',
      args: ['issue', 'edit', '12', '--repo', 'acme/widget', '--add-label', 'harbor:need-info'],
    });
    expect(calls[1].cmd).toBe('gh');
    expect(calls[1].args.slice(0, 5)).toEqual(['issue', 'comment', '12', '--repo', 'acme/widget']);
    expect(calls[1].args[5]).toBe('--body');
    expect(calls[1].args[6]).toContain('intent');
  });

  it('appends a stalled record to the audit trail when there is no tracker', () => {
    const dir = tempDir();
    flagStall(stall, { cwd: dir });

    const auditPath = join(dir, '.omc', 'state', 'factory-listener-audit.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    const records = readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'stalled', intentId: stall.intentId, session: stall.session, stage: 'intent', stalledForMs: stall.stalledForMs });
    expect(typeof records[0].at).toBe('string');
  });
});
