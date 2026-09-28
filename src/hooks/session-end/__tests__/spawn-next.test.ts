import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { executeSpawnNext, planSpawnNext, spawnNextAlertComment, type SpawnNextChain, type SpawnFn } from '../spawn-next.js';

const chain: SpawnNextChain = {
  outcome: 'success',
  reason: 'clear',
  routeTable: { 'success:clear': { stage: 'launch', skill: 'launch' }, 'success:*': { stage: 'fallback', skill: 'fallback' } },
  sessionId: 'sess-1',
  handoffContext: 'context body',
  tracker: { repo: 'owner/repo', issue: 42, nextLabel: 'in-launch', failedLabel: 'failed' },
};

const sessions = (): Array<[string, string[]]> => [];
const spawnRecording = (): { spawnFn: SpawnFn; calls: Array<[string, string[]]> } => {
  const calls = sessions();
  const spawnFn: SpawnFn = (command, args) => { calls.push([command, args]); return { unref() {} }; };
  return { spawnFn, calls };
};

describe('planSpawnNext', () => {
  it('routes exact key hit to the next stage plan', () => {
    const plan = planSpawnNext(chain, '/omc-root');
    expect(plan?.directive).toEqual({ stage: 'launch', skill: 'launch' });
    expect(plan?.handoffPath).toBe(path.join('/omc-root', 'handoffs', 'sess-1-launch.json'));
    expect(plan?.spawnArgv[0]).toBe('claude');
    expect(plan?.spawnArgv.join(' ')).toContain('-p');
    expect(plan?.spawnArgv.join(' ')).toContain('launch');
    expect(plan?.spawnArgv).toContain('--session-id');
    expect(plan?.nextSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('falls back to the wildcard key', () => {
    const plan = planSpawnNext({ ...chain, reason: 'other' }, '/omc-root');
    expect(plan?.directive).toEqual({ stage: 'fallback', skill: 'fallback' });
  });

  it('returns null when no route matches', () => {
    expect(planSpawnNext({ ...chain, outcome: 'failed' as const }, '/omc-root')).toBeNull();
  });

  it('builds tracker writeback argv arrays only when a tracker is configured', () => {
    const withTracker = planSpawnNext(chain, '/omc-root');
    expect(withTracker?.trackerCommands[0]).toEqual(['gh', 'issue', 'edit', '42', '--repo', 'owner/repo', '--add-label', 'in-launch']);
    expect(withTracker?.trackerCommands[1]?.slice(0, 6)).toEqual(['gh', 'issue', 'comment', '42', '--repo', 'owner/repo']);
    const withoutTracker = planSpawnNext({ ...chain, tracker: undefined }, '/omc-root');
    expect(withoutTracker?.trackerCommands).toEqual([]);
  });

  it('rejects a chain with a path-traversal session id before planning', () => {
    const { spawnFn, calls } = spawnRecording();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-next-'));
    try {
      expect(() => executeSpawnNext({ ...chain, sessionId: '../evil' }, directory, spawnFn)).toThrow(/Invalid session ID/);
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a chain whose tracker repo or label carries shell metacharacters', () => {
    expect(() => planSpawnNext({ ...chain, tracker: { ...chain.tracker!, repo: 'owner/repo; rm -rf /' } }, '/omc-root')).toThrow(/invalid tracker repo/);
    expect(() => planSpawnNext({ ...chain, tracker: { ...chain.tracker!, nextLabel: 'a b; touch /tmp/x' } }, '/omc-root')).toThrow(/invalid tracker label/);
  });
});

describe('spawnNextAlertComment', () => {
  it('names the failing outcome and reason with no-retry semantics', () => {
    const comment = spawnNextAlertComment(chain);
    expect(comment).toContain('success:clear');
    expect(comment).toContain('无自动重试');
  });
});

describe('executeSpawnNext', () => {
  it('writes the handoff file, the next-link ledger, and spawns the next session plus tracker writebacks', () => {
    const { spawnFn, calls } = spawnRecording();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-next-'));
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    try {
      executeSpawnNext(chain, directory, spawnFn);
      const handoffPath = path.join(directory, '.omc', 'handoffs', 'sess-1-launch.json');
      const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8')) as { sessionId: string; next: unknown; context: string };
      expect(handoff.sessionId).toBe('sess-1');
      expect(handoff.next).toEqual({ stage: 'launch', skill: 'launch' });
      expect(handoff.context).toBe('context body');
      const factoryDir = path.join(directory, '.omc', 'state', 'factory');
      const ledgerFiles = fs.readdirSync(factoryDir).filter((f) => f.startsWith('chain-') && f.endsWith('.json'));
      expect(ledgerFiles).toHaveLength(1);
      const ledger = JSON.parse(fs.readFileSync(path.join(factoryDir, ledgerFiles[0]), 'utf8')) as { intentId: string; stage: string; routeTable: unknown };
      expect(ledger.intentId).toBe('chain-sess-1');
      expect(ledger.stage).toBe('launch');
      expect(ledger.routeTable).toEqual(chain.routeTable);
      const claudeCall = calls.find(([command]) => command === 'claude');
      expect(claudeCall).toBeDefined();
      expect(claudeCall?.[1]).toContain('--session-id');
      expect(calls.filter(([command]) => command === 'gh')).toHaveLength(2);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does nothing when the route misses', () => {
    const { spawnFn, calls } = spawnRecording();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-next-'));
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    try {
      executeSpawnNext({ ...chain, outcome: 'failed' as const }, directory, spawnFn);
      expect(fs.existsSync(path.join(directory, '.omc'))).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('carries a chain intentId into the next-link ledger', () => {
    const { spawnFn } = spawnRecording();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-next-'));
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    try {
      executeSpawnNext({ ...chain, intentId: 'demo#7' }, directory, spawnFn);
      const factoryDir = path.join(directory, '.omc', 'state', 'factory');
      const ledgerFile = fs.readdirSync(factoryDir).find((f) => f.startsWith('chain-') && f.endsWith('.json'));
      const ledger = JSON.parse(fs.readFileSync(path.join(factoryDir, ledgerFile!), 'utf8')) as { intentId: string };
      expect(ledger.intentId).toBe('demo#7');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('alerts the tracker and rethrows when spawning the next session fails', () => {
    const calls = sessions();
    const failingSpawn: SpawnFn = (command, args) => {
      if (command === 'claude') throw new Error('spawn-failure');
      calls.push([command, args]);
      return { unref() {} };
    };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-next-'));
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    try {
      expect(() => executeSpawnNext(chain, directory, failingSpawn)).toThrow('spawn-failure');
      const ghCalls = calls.filter(([command]) => command === 'gh');
      expect(ghCalls).toHaveLength(2);
      const comment = ghCalls.find(([, args]) => args.includes('comment'));
      expect(comment?.[1].join(' ')).toContain('--body');
      expect(comment?.[1].join(' ')).toContain('无自动重试');
      const label = ghCalls.find(([, args]) => args.includes('edit'));
      expect(label?.[1].join(' ')).toContain('failed');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
