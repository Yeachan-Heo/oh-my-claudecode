import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  writeHeartbeat, readHeartbeat, listHeartbeats,
  isWorkerAlive, deleteHeartbeat, cleanupTeamHeartbeats
} from '../heartbeat.js';
import type { HeartbeatData } from '../types.js';

const TEST_DIR = join(tmpdir(), '__test_heartbeat__');
const TEST_TEAM = 'test-team';

function makeHeartbeat(overrides?: Partial<HeartbeatData>): HeartbeatData {
  return {
    workerName: 'w1',
    teamName: TEST_TEAM,
    provider: 'codex',
    pid: 12345,
    lastPollAt: new Date().toISOString(),
    consecutiveErrors: 0,
    status: 'polling',
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('writeHeartbeat / readHeartbeat', () => {
  it('writes and reads heartbeat', () => {
    const hb = makeHeartbeat();
    writeHeartbeat(TEST_DIR, hb);
    const read = readHeartbeat(TEST_DIR, TEST_TEAM, 'w1');
    expect(read?.workerName).toBe('w1');
    expect(read?.status).toBe('polling');
  });

  it('returns null for missing heartbeat', () => {
    expect(readHeartbeat(TEST_DIR, TEST_TEAM, 'nonexistent')).toBeNull();
  });
});

describe('listHeartbeats', () => {
  it('lists all heartbeats for a team', () => {
    writeHeartbeat(TEST_DIR, makeHeartbeat({ workerName: 'w1' }));
    writeHeartbeat(TEST_DIR, makeHeartbeat({ workerName: 'w2' }));
    const list = listHeartbeats(TEST_DIR, TEST_TEAM);
    expect(list).toHaveLength(2);
  });

  it('returns empty for nonexistent team', () => {
    expect(listHeartbeats(TEST_DIR, 'nonexistent-team')).toEqual([]);
  });
});

describe('isWorkerAlive', () => {
  it('returns true for fresh heartbeat', () => {
    writeHeartbeat(TEST_DIR, makeHeartbeat());
    expect(isWorkerAlive(TEST_DIR, TEST_TEAM, 'w1', 60_000)).toBe(true);
  });

  it('returns false for stale heartbeat', () => {
    const stale = makeHeartbeat({ lastPollAt: '2020-01-01T00:00:00Z' });
    writeHeartbeat(TEST_DIR, stale);
    expect(isWorkerAlive(TEST_DIR, TEST_TEAM, 'w1', 60_000)).toBe(false);
  });

  it('returns false for invalid date', () => {
    const bad = makeHeartbeat({ lastPollAt: 'not-a-date' });
    writeHeartbeat(TEST_DIR, bad);
    expect(isWorkerAlive(TEST_DIR, TEST_TEAM, 'w1', 60_000)).toBe(false);
  });

  it('returns false for missing worker', () => {
    expect(isWorkerAlive(TEST_DIR, TEST_TEAM, 'ghost', 60_000)).toBe(false);
  });
});

describe('deleteHeartbeat', () => {
  it('deletes heartbeat file', () => {
    writeHeartbeat(TEST_DIR, makeHeartbeat());
    deleteHeartbeat(TEST_DIR, TEST_TEAM, 'w1');
    expect(readHeartbeat(TEST_DIR, TEST_TEAM, 'w1')).toBeNull();
  });

  it('no-op for missing heartbeat', () => {
    // Should not throw
    deleteHeartbeat(TEST_DIR, TEST_TEAM, 'nonexistent');
    expect(readHeartbeat(TEST_DIR, TEST_TEAM, 'nonexistent')).toBeNull();
  });
});

describe('cleanupTeamHeartbeats', () => {
  it('removes all heartbeat files for team', () => {
    writeHeartbeat(TEST_DIR, makeHeartbeat({ workerName: 'w1' }));
    writeHeartbeat(TEST_DIR, makeHeartbeat({ workerName: 'w2' }));
    cleanupTeamHeartbeats(TEST_DIR, TEST_TEAM);
    expect(listHeartbeats(TEST_DIR, TEST_TEAM)).toEqual([]);
  });

  it('no-op for nonexistent team', () => {
    // Should not throw
    cleanupTeamHeartbeats(TEST_DIR, 'nonexistent-team');
  });
});
