import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readChainStatus } from '../status.js';
import { factoryStateDir } from '../../hooks/session-end/chain-enqueuer.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-factory-status-'));
  tempRoots.push(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function writeDecisions(directory: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(factoryStateDir(directory), { recursive: true });
  writeFileSync(
    join(factoryStateDir(directory), 'chain-decisions.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
});

describe('readChainStatus', () => {
  it('returns an empty audit view for a project that never ran a chain', () => {
    const dir = tempDir();
    const status = readChainStatus(dir);
    expect(status).toEqual({ directory: dir, routeKeys: [], activeLedgers: 0, intents: [], stalled: [] });
  });

  it('summarizes each intent from the decisions trail, most recent first', () => {
    const dir = tempDir();
    writeDecisions(dir, [
      { decision: 'enqueued', intentId: 'intent-a', at: '2026-09-29T12:00:00.000Z' },
      { decision: 'enqueued', intentId: 'intent-a', at: '2026-09-29T12:05:00.000Z' },
      { decision: 'chain-terminal', intentId: 'intent-a', at: '2026-09-29T12:10:00.000Z' },
      { decision: 'enqueued', intentId: 'intent-b', at: '2026-09-30T02:00:00.000Z' },
    ]);

    const status = readChainStatus(dir);

    expect(status.intents.map((intent) => intent.intentId)).toEqual(['intent-b', 'intent-a']);
    const a = status.intents[1];
    expect(a).toMatchObject({ decisionCount: 3, counts: { enqueued: 2, 'chain-terminal': 1 }, lastDecision: 'chain-terminal', lastDecisionAt: '2026-09-29T12:10:00.000Z' });
  });

  it('merges stop markers and counts live ledgers', () => {
    const dir = tempDir();
    writeDecisions(dir, [{ decision: 'chain-terminal', intentId: 'intent-a', at: '2026-09-29T12:10:00.000Z' }]);
    mkdirSync(factoryStateDir(dir), { recursive: true });
    writeFileSync(join(factoryStateDir(dir), 'chain-intent-a.stopped.json'), JSON.stringify({ intentId: 'intent-a', reason: 'terminal:delivery-review', stoppedAt: '2026-09-29T12:10:00.000Z' }), 'utf8');
    writeFileSync(join(factoryStateDir(dir), 'chain-056ecf5c-5ed7-47b9-ba73-0722a1c7314d.json'), JSON.stringify({ intentId: 'intent-a', stage: 'launch' }), 'utf8');

    const status = readChainStatus(dir);

    expect(status.intents[0].stopped).toEqual({ reason: 'terminal:delivery-review', stoppedAt: '2026-09-29T12:10:00.000Z' });
    expect(status.activeLedgers).toBe(1);
  });

  it('surfaces a pre-written first-ring ledger that never advanced as a stalled link', () => {
    const dir = tempDir();
    const session = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const factoryDir = factoryStateDir(dir);
    mkdirSync(factoryDir, { recursive: true });
    // A pre-written first-ring ledger carries no routeTable; the enqueuer has
    // not taken it over, so an aged file is the stall signature.
    writeFileSync(join(factoryDir, `chain-${session}.json`), JSON.stringify({ intentId: 'intent-stalled', stage: 'launch' }), 'utf8');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(factoryDir, `chain-${session}.json`), twoHoursAgo, twoHoursAgo);

    const status = readChainStatus(dir);

    expect(status.stalled).toHaveLength(1);
    expect(status.stalled[0]).toMatchObject({ intentId: 'intent-stalled', stage: 'launch', session });
  });

  it('lists the project route table keys as the single authority', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.omc'), { recursive: true });
    writeFileSync(join(dir, '.omc', 'factory-routes.json'), JSON.stringify({
      'success:other': { stage: 'delivery-review', skill: 'stop' },
      'failed:*': { stage: 'terminal', skill: 'stop' },
    }), 'utf8');

    expect(readChainStatus(dir).routeKeys).toEqual(['success:other', 'failed:*']);
  });
});
