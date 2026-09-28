import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import fs, { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildIntentPrompt,
  MAX_BODY_BYTES,
  processEvent,
  routeTrackerEvent,
  startListener,
  stopListener,
  verifySignature,
  type ListenerConfig,
  type TrackerEvent,
} from '../listener.js';
import { acquireFileLockSync, releaseFileLockSync, type FileLockHandle } from '../../lib/file-lock.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';

const SECRET = 'test-secret';
const WHITELIST = ['pangpang778/factory-demo'];

const tempCwds: string[] = [];
let previousOmcStateDir: string | undefined;
let stateRoot: string;

beforeEach(() => {
  previousOmcStateDir = process.env.OMC_STATE_DIR;
  stateRoot = mkdtempSync(join(tmpdir(), 'omc-factory-state-'));
  tempCwds.push(stateRoot);
  process.env.OMC_STATE_DIR = stateRoot;
});

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-listener-'));
  tempCwds.push(dir);
  return dir;
}

function config(overrides: Partial<ListenerConfig> = {}): ListenerConfig {
  return { port: 0, secret: SECRET, whitelist: WHITELIST, cwd: tempCwd(), ...overrides };
}

afterEach(() => {
  if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = previousOmcStateDir;
  for (const dir of tempCwds) rmSync(dir, { recursive: true, force: true });
  tempCwds.length = 0;
});

function event(overrides: Partial<TrackerEvent> = {}): TrackerEvent {
  return {
    action: 'labeled',
    repository: { full_name: 'pangpang778/factory-demo' },
    label: { name: 'intake' },
    issue: { number: 7, title: '退款咨询', html_url: 'https://github.com/pangpang778/factory-demo/issues/7' },
    ...overrides,
  };
}

function signedBody(payload: unknown): { body: string; signature: string } {
  const body = JSON.stringify(payload);
  return { body, signature: `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}` };
}

describe('verifySignature', () => {
  it('accepts a correct sha256 signature', () => {
    const { body, signature } = signedBody(event());
    expect(verifySignature(SECRET, body, signature)).toBe(true);
  });

  it('rejects a wrong secret and a tampered body', () => {
    const { body, signature } = signedBody(event());
    expect(verifySignature('other', body, signature)).toBe(false);
    expect(verifySignature(SECRET, `${body} `, signature)).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    const { body } = signedBody(event());
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
    expect(verifySignature(SECRET, body, 'md5=abc')).toBe(false);
  });
});

describe('routeTrackerEvent', () => {
  it('routes an intake-labeled event to the intent directive', () => {
    const r = routeTrackerEvent(event(), WHITELIST);
    expect(r).toEqual({
      kind: 'routed',
      directive: { stage: 'intent', skill: 'intent' },
      issueNumber: 7,
      issueUrl: 'https://github.com/pangpang778/factory-demo/issues/7',
    });
  });

  it('routes an opened issue that already carries the intake label', () => {
    const r = routeTrackerEvent(event({ action: 'opened', label: undefined, issue: { number: 1, labels: [{ name: 'intake' }] } }), WHITELIST);
    expect(r.kind).toBe('routed');
  });

  it('discards events without the intake label', () => {
    const r = routeTrackerEvent(event({ label: { name: 'bug' } }), WHITELIST);
    expect(r).toEqual({ kind: 'discarded', reason: 'no intake label (action: labeled)' });
  });

  it('discards when the route table has no intake directive', () => {
    const r = routeTrackerEvent(event(), WHITELIST, {});
    expect(r.kind).toBe('discarded');
  });
});

describe('processEvent', () => {
  it('spawns a headless intent session with a pre-written chain ledger', () => {
    const cfg = config();
    const spawned: Array<[string, string[]]> = [];
    const audits: Record<string, unknown>[] = [];
    const result = processEvent(event(), cfg, {
      spawner: (cmd, args) => spawned.push([cmd, args]),
      audit: (r) => audits.push(r),
    });
    expect(result.kind).toBe('accepted');
    const prompt = buildIntentPrompt({ stage: 'intent', skill: 'intent' }, 7, 'https://github.com/pangpang778/factory-demo/issues/7');
    expect(spawned).toHaveLength(1);
    expect(spawned[0][0]).toBe('claude');
    expect(spawned[0][1][0]).toBe('-p');
    expect(spawned[0][1][1]).toBe(prompt);
    expect(spawned[0][1][2]).toBe('--session-id');
    const sessionId = spawned[0][1][3];
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const ledgerPath = join(getOmcRoot(cfg.cwd), 'state', 'factory', `chain-${sessionId}.json`);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as { intentId: string; stage: string };
    expect(ledger.intentId).toBe('pangpang778-factory-demo-7');
    expect(ledger.stage).toBe('intent');
    expect(audits[0]).toMatchObject({ kind: 'routed', stage: 'intent', skill: 'intent', issue: 'https://github.com/pangpang778/factory-demo/issues/7', session: sessionId });
  });

  it('discards label-less events without spawning', () => {
    const spawned: Array<[string, string[]]> = [];
    const result = processEvent(event({ label: { name: 'question' } }), config(), { spawner: (cmd, args) => spawned.push([cmd, args]) });
    expect(result).toMatchObject({ status: 204, kind: 'discarded' });
    expect(spawned).toEqual([]);
  });

  it('rejects out-of-whitelist repos with an audit record', () => {
    const audits: Record<string, unknown>[] = [];
    const spawned: Array<[string, string[]]> = [];
    const result = processEvent(event({ repository: { full_name: 'someone/else' } }), config(), {
      spawner: (cmd, args) => spawned.push([cmd, args]),
      audit: (r) => audits.push(r),
    });
    expect(result).toMatchObject({ status: 403, kind: 'rejected' });
    expect(spawned).toEqual([]);
    expect(audits).toEqual([{ kind: 'rejected', status: 403, reason: 'repository outside whitelist: someone/else' }]);
  });

  it('discards and audits an issue url outside the whitelisted repo', () => {
    const audits: Record<string, unknown>[] = [];
    const spawned: Array<[string, string[]]> = [];
    const result = processEvent(
      event({ issue: { number: 7, title: 'x', html_url: 'https://evil.example/pangpang778/factory-demo/issues/7' } }),
      config(),
      { spawner: (cmd, args) => spawned.push([cmd, args]), audit: (r) => audits.push(r) },
    );
    expect(result).toMatchObject({ status: 204, kind: 'discarded' });
    expect(spawned).toEqual([]);
    expect(audits[0]).toMatchObject({ kind: 'discarded', reason: 'issue url outside whitelisted repo' });
  });

  it('discards and audits when the intent chain guardrail holds the serial slot', () => {
    const cfg = config();
    const lockPath = join(getOmcRoot(cfg.cwd), 'state', 'factory', 'chain-pangpang778-factory-demo-7.active.lock');
    const held: FileLockHandle | null = acquireFileLockSync(lockPath);
    expect(held).not.toBeNull();
    try {
      const audits: Record<string, unknown>[] = [];
      const spawned: Array<[string, string[]]> = [];
      const result = processEvent(event(), cfg, {
        spawner: (cmd, args) => spawned.push([cmd, args]),
        audit: (r) => audits.push(r),
      });
      expect(result).toMatchObject({ status: 204, kind: 'discarded' });
      expect(spawned).toEqual([]);
      expect(audits[0]).toMatchObject({ kind: 'discarded', reason: 'guardrail: serial-conflict' });
    } finally {
      if (held) releaseFileLockSync(held);
    }
  });

  it('releases the chain serial slot after a successful spawn', () => {
    const cfg = config();
    const lockPath = join(getOmcRoot(cfg.cwd), 'state', 'factory', 'chain-pangpang778-factory-demo-7.active.lock');
    const result = processEvent(event(), cfg, { spawner: () => {} });
    expect(result.kind).toBe('accepted');
    const probe: FileLockHandle | null = acquireFileLockSync(lockPath);
    expect(probe).not.toBeNull();
    if (probe) releaseFileLockSync(probe);
  });
});

describe('listener server', () => {
  it('throws when the secret is empty or missing', () => {
    const cfg = config({ secret: '' });
    expect(() => { const _p = startListener(cfg); }).toThrow('HMAC secret is required and cannot be empty');
    const cfg2 = config({ secret: '   ' });
    expect(() => { const _p = startListener(cfg2); }).toThrow('HMAC secret is required and cannot be empty');
  });

  it('binds to 127.0.0.1 by default for localhost-only access', async () => {
    const cfg = config({ port: 0 });
    const server = await startListener(cfg);
    try {
      const addr = server.address();
      expect(addr).not.toBeNull();
      if (addr && typeof addr !== 'string') {
        expect(addr.address).toBe('127.0.0.1');
      }
    } finally {
      stopListener(server, cfg.cwd);
    }
  });

  it('binds to a custom host when specified', async () => {
    const cfg = config({ port: 0, host: '127.0.0.1' });
    const server = await startListener(cfg);
    try {
      const addr = server.address();
      expect(addr).not.toBeNull();
      if (addr && typeof addr !== 'string') {
        expect(addr.address).toBe('127.0.0.1');
      }
    } finally {
      stopListener(server, cfg.cwd);
    }
  });

  it('rejects bad HMAC with 401 and never routes', async () => {
    const spawned: Array<[string, string[]]> = [];
    const cfg = config({ port: 0 });
    const server = await startListener(cfg, { spawner: (cmd, args) => spawned.push([cmd, args]) });
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      const res = await fetch(`http://${addr.address}:${addr.port}`, {
        method: 'POST',
        headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
        body: JSON.stringify(event()),
      });
      expect(res.status).toBe(401);
      expect(spawned).toEqual([]);
    } finally {
      stopListener(server, cfg.cwd);
    }
  });

  it('returns 413 and never routes when the body exceeds the size cap', async () => {
    const spawned: Array<[string, string[]]> = [];
    const cfg = config({ port: 0 });
    const server = await startListener(cfg, { spawner: (cmd, args) => spawned.push([cmd, args]) });
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      const res = await fetch(`http://${addr.address}:${addr.port}`, {
        method: 'POST',
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
      });
      expect(res.status).toBe(413);
      expect(spawned).toEqual([]);
    } finally {
      stopListener(server, cfg.cwd);
    }
  });

  it('accepts a signed legal event end to end and exposes liveness on /status', async () => {
    const spawned: Array<[string, string[]]> = [];
    const cfg = config({ port: 0 });
    const server = await startListener(cfg, { spawner: (cmd, args) => spawned.push([cmd, args]) });
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      const base = `http://${addr.address}:${addr.port}`;

      const status = await fetch(`${base}/status`);
      expect(status.status).toBe(200);
      expect(((await status.json()) as { ok: boolean }).ok).toBe(true);

      const { body, signature } = signedBody(event());
      const res = await fetch(base, { method: 'POST', headers: { 'x-hub-signature-256': signature }, body });
      expect(res.status).toBe(202);
      expect(spawned).toHaveLength(1);
      expect(spawned[0][0]).toBe('claude');
      expect(spawned[0][1][0]).toBe('-p');
    } finally {
      stopListener(server, cfg.cwd);
    }
  });
});
