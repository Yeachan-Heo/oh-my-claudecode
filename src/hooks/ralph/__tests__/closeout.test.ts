import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

import { closeoutPath, isCloseoutSatisfied, readCloseout, writeCloseout } from '../closeout.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-ralph-closeout-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ralph closeout record', () => {
  it('round-trips a completed deslop record', () => {
    const root = tempRoot();
    const path = closeoutPath(root, 'session-a');
    const now = new Date('2026-11-03T00:00:00.000Z');

    expect(writeCloseout(path, { sessionId: 'session-a', deslop: 'completed', criteriaRevision: 'sha256:abc' }, now)).toBe(true);

    const record = readCloseout(path);
    expect(record).toMatchObject({
      version: 1,
      sessionId: 'session-a',
      deslop: 'completed',
      criteriaRevision: 'sha256:abc',
      recordedAt: '2026-11-03T00:00:00.000Z',
    });
    // Written under the session directory, never at the .omc root.
    expect(path).toBe(join(root, 'state', 'sessions', 'session-a', 'ralph-closeout.json'));
  });

  it('records an explicit skip the same way as a completed pass', () => {
    const root = tempRoot();
    const path = closeoutPath(root, 'session-b');
    writeCloseout(path, { sessionId: 'session-b', deslop: 'skipped', criteriaRevision: 'sha256:def' });

    expect(readCloseout(path)?.deslop).toBe('skipped');
    expect(isCloseoutSatisfied(readCloseout(path), 'sha256:def')).toBe(true);
  });

  it('rejects an unknown deslop status instead of treating it as a pass', () => {
    const root = tempRoot();
    const path = closeoutPath(root, 'session-c');
    mkdirSync(join(root, 'state', 'sessions', 'session-c'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 1,
      sessionId: 'session-c',
      deslop: 'probably',
      criteriaRevision: 'sha256:abc',
      recordedAt: '2026-11-03T00:00:00.000Z',
    }));

    expect(readCloseout(path)).toBeNull();
    expect(isCloseoutSatisfied(readCloseout(path), 'sha256:abc')).toBe(false);
  });

  it('refuses a record whose criteria revision no longer matches', () => {
    const root = tempRoot();
    const path = closeoutPath(root, 'session-d');
    writeCloseout(path, { sessionId: 'session-d', deslop: 'completed', criteriaRevision: 'sha256:old' });

    expect(isCloseoutSatisfied(readCloseout(path), 'sha256:new')).toBe(false);
  });

  it('treats a missing or unreadable record as unsatisfied', () => {
    const root = tempRoot();
    const path = closeoutPath(root, 'session-e');

    expect(readCloseout(path)).toBeNull();
    expect(isCloseoutSatisfied(null, 'sha256:abc')).toBe(false);

    mkdirSync(join(root, 'state', 'sessions', 'session-e'), { recursive: true });
    writeFileSync(path, '{not json');
    expect(readCloseout(path)).toBeNull();
  });

  it('keeps the recorded revision opaque', () => {
    // The gate compares strings; it must not re-derive a revision and silently
    // "repair" a record written against different criteria.
    const root = tempRoot();
    const path = closeoutPath(root, 'session-f');
    const revision = `sha256:${createHash('sha256').update('criteria').digest('hex')}`;
    writeCloseout(path, { sessionId: 'session-f', deslop: 'completed', criteriaRevision: revision });

    const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(stored.criteriaRevision).toBe(revision);
    expect(existsSync(path)).toBe(true);
  });
});
