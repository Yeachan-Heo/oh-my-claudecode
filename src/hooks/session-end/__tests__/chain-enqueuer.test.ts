import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  planChainEnqueue,
  readChainLedger,
  readProjectRoutes,
  sessionEndOutcome,
  factoryStateDir,
} from '../chain-enqueuer.js';
import { acquireChainSlot, releaseChainSlot, readChainStopMarker, DAILY_CHAIN_LIMIT, type ChainSlotPermit } from '../guardrails.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-chain-enqueuer-'));
  tempRoots.push(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
});

function writeLedger(directory: string, sessionId: string, ledger: Record<string, unknown>): void {
  const dir = factoryStateDir(directory);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `chain-${sessionId}.json`), JSON.stringify(ledger), 'utf8');
}

function writeProjectRoutes(directory: string, table: Record<string, unknown>): void {
  const omcDir = join(directory, '.omc');
  mkdirSync(omcDir, { recursive: true });
  writeFileSync(join(omcDir, 'factory-routes.json'), JSON.stringify(table), 'utf8');
}

function readDecisions(directory: string): Array<Record<string, unknown>> {
  const path = join(factoryStateDir(directory), 'chain-decisions.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('sessionEndOutcome', () => {
  it('maps a clean exit to success and everything else to failed', () => {
    expect(sessionEndOutcome('prompt_input_exit')).toBe('success');
    expect(sessionEndOutcome('logout')).toBe('success');
    expect(sessionEndOutcome('clear')).toBe('failed');
    expect(sessionEndOutcome('other')).toBe('failed');
  });
});

describe('readChainLedger / readProjectRoutes', () => {
  it('returns null for a missing, malformed, or traversal session id', () => {
    const dir = tempDir();
    expect(readChainLedger(dir, 'sess-a')).toBeNull();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    expect(readChainLedger(dir, 'sess-a')).toEqual({ intentId: 'intent-a' });
    writeFileSync(join(factoryStateDir(dir), 'chain-sess-b.json'), '{broken', 'utf8');
    expect(readChainLedger(dir, 'sess-b')).toBeNull();
    expect(readChainLedger(dir, '../evil')).toBeNull();
  });

  it('returns null when the project routes file is missing or malformed', () => {
    const dir = tempDir();
    expect(readProjectRoutes(dir)).toBeNull();
    writeProjectRoutes(dir, { 'success:*': { stage: 'x', skill: 'x' } });
    expect(readProjectRoutes(dir)).toEqual({ 'success:*': { stage: 'x', skill: 'x' } });
    writeProjectRoutes(dir, 'not-an-object' as unknown as Record<string, unknown>);
    expect(readProjectRoutes(dir)).toBeNull();
  });
});

describe('planChainEnqueue', () => {
  it('returns null and records nothing when the session has no ledger', () => {
    const dir = tempDir();
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir)).toEqual([]);
  });

  it('enqueues the chain on a clean exit using the project route table', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    writeProjectRoutes(dir, { 'success:*': { stage: 'spec', skill: 'spec' } });
    const chain = planChainEnqueue(dir, 'sess-a', 'prompt_input_exit');
    expect(chain).toMatchObject({
      outcome: 'success',
      reason: 'prompt_input_exit',
      sessionId: 'sess-a',
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
    });
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'enqueued', stage: 'spec', intentId: 'intent-a' });
  });

  it('a ledger route table overrides the project file', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', routeTable: { 'success:*': { stage: 'ledger', skill: 'ledger' } } });
    writeProjectRoutes(dir, { 'success:*': { stage: 'project', skill: 'project' } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')?.routeTable).toEqual({ 'success:*': { stage: 'ledger', skill: 'ledger' } });
  });

  it('a failed exit with no route halts the chain and leaves a stop marker', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    expect(planChainEnqueue(dir, 'sess-a', 'other')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'no-route', outcome: 'failed' });
    expect(readChainStopMarker('intent-a', factoryStateDir(dir))).toMatchObject({ intentId: 'intent-a', reason: 'session-end:other' });
  });

  it('a clean exit with no route simply ends the chain without a stop marker', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'no-route', outcome: 'success' });
    expect(readChainStopMarker('intent-a', factoryStateDir(dir))).toBeNull();
  });

  it('a human gate halts the chain and leaves a stop marker', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
      gate: 'intent-accept',
    });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'human-gate', gate: 'intent-accept' });
    expect(readChainStopMarker('intent-a', factoryStateDir(dir))).toMatchObject({ reason: 'human-gate:intent-accept' });
  });

  it('an auto-pass gate enqueues and records the signer fact', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
      gate: 'spec-approve',
      gateFacts: { irreversibleOrExternal: false, precedentSetting: false, valueJudgment: false, mechanicalChecksPassed: true },
    });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).not.toBeNull();
    expect(readDecisions(dir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'auto-pass', gate: 'spec-approve' }),
      expect.objectContaining({ decision: 'enqueued' }),
    ]));
  });

  it('missing gate facts fail conservative to a human gate', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
      gate: 'spec-approve',
    });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'human-gate' });
  });

  it('a guardrail rejection skips the enqueue and records it', () => {
    const dir = tempDir();
    for (let i = 0; i < DAILY_CHAIN_LIMIT; i++) {
      const permit = acquireChainSlot('intent-cap', factoryStateDir(dir));
      if (permit.allowed) releaseChainSlot(permit as ChainSlotPermit);
    }
    writeLedger(dir, 'sess-a', { intentId: 'intent-cap' });
    writeProjectRoutes(dir, { 'success:*': { stage: 'spec', skill: 'spec' } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'guardrail', guardrail: 'daily-cap' });
  });

  it('an invalid ledger (bad tracker repo) halts without enqueueing', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
      tracker: { repo: 'bad repo; rm', issue: 1, nextLabel: 'x', failedLabel: 'y' },
    });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'invalid-ledger' });
  });

  it('rejects a ledger whose intentId carries path metacharacters', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: '../../evil' });
    writeProjectRoutes(dir, { 'success:*': { stage: 'spec', skill: 'spec' } });
    expect(planChainEnqueue(dir, 'sess-a', 'other')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'invalid-ledger' });
    // No stop marker may escape the factory dir (or be written at all).
    expect(existsSync(join(factoryStateDir(dir), 'chain-....stopped.json'))).toBe(false);
    expect(existsSync(join(dir, 'evil.stopped.json'))).toBe(false);
  });

  it('rejects a ledger route whose stage or skill carries path metacharacters', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', routeTable: { 'success:*': { stage: '../evil', skill: 'spec' } } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'invalid-ledger' });

    const failedDir = tempDir();
    writeLedger(failedDir, 'sess-a', { intentId: 'intent-a', routeTable: { 'failed:*': { stage: 'spec', skill: 'x".y' } } });
    expect(planChainEnqueue(failedDir, 'sess-a', 'other')).toBeNull();
    expect(readDecisions(failedDir).at(-1)).toMatchObject({ decision: 'invalid-ledger' });
    // failed outcome leaves a halt marker inside the factory dir only.
    expect(readChainStopMarker('intent-a', factoryStateDir(failedDir))).toMatchObject({ reason: 'invalid-ledger:other' });
  });

  it('a terminal route (skill stop) halts the chain without enqueueing', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', routeTable: { 'success:*': { stage: 'harbor', skill: 'stop' } } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'chain-terminal', stage: 'harbor' });
    expect(readChainStopMarker('intent-a', factoryStateDir(dir))).toMatchObject({ reason: 'terminal:harbor' });
  });

  it('halts with chain-loop-capped when the next stage hit its visit cap', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'failed:other': { stage: 'spec', skill: 'spec' } },
      visits: { spec: 2 },
    });
    expect(planChainEnqueue(dir, 'sess-a', 'other')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'chain-loop-capped', stage: 'spec', visits: 2, cap: 2 });
    expect(readChainStopMarker('intent-a', factoryStateDir(dir))).toMatchObject({ reason: 'loop-capped:spec' });
  });

  it('enqueues while visits are under the cap and carries them forward', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'failed:other': { stage: 'spec', skill: 'spec' } },
      visits: { spec: 1 },
      maxStageVisits: 3,
    });
    const chain = planChainEnqueue(dir, 'sess-a', 'other');
    expect(chain).not.toBeNull();
    expect(chain?.visits).toEqual({ spec: 1 });
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'enqueued', stage: 'spec' });
  });

  it('an invalid maxStageVisits falls back to the default cap', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'failed:other': { stage: 'spec', skill: 'spec' } },
      visits: { spec: 2 },
      maxStageVisits: 0,
    });
    expect(planChainEnqueue(dir, 'sess-a', 'other')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'chain-loop-capped', cap: 2 });
  });
});
