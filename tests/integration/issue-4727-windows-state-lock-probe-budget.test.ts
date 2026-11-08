/**
 * Regression tests for issue #4727: the state-lock owner liveness probe must run
 * outside the SQLite write transaction.
 *
 * On Windows the probe spawns PowerShell (hundreds of milliseconds). Probing while
 * holding BEGIN IMMEDIATE serialized every waiter behind each other's probes and
 * drained the shared 3000ms probe budget, failing acquisitions as "unverifiable"
 * while the owner was alive. These tests seed an occupied lock and observe the
 * SQLite write lock from a second connection while the injected probe runs.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  acquireStateFileLockAtPathSync,
  getStateFileLockFailureKind,
  releaseStateFileLockSync,
} from '../../scripts/lib/state-lock.mjs';

const tmpRoot = mkdtempSync(join(tmpdir(), 'omc-lock-issue-4727-'));
const stateDir = join(tmpRoot, 'state');
mkdirSync(stateDir, { recursive: true });
const dbPath = join(stateDir, '.state-mutation-locks.db');
const SELF_IDENTITY = 'self-start';
const OWNER_PID = 2_000_000_001;
const OWNER_START = 'owner-start';
const NONCE = {
  live: randomUUID(),
  artifact: randomUUID(),
  dead: randomUUID(),
  replacement: randomUUID(),
  crashed: randomUUID(),
  released: randomUUID(),
};

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function openDb(): Database.Database {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 0');
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)');
  return db;
}

function seedOwner(lockPath: string, nonce: string, { row = true, artifact = true } = {}): void {
  const createdAt = new Date().toISOString();
  if (row) {
    const db = openDb();
    db.prepare('INSERT OR REPLACE INTO state_mutation_locks (lock_key, version, pid, process_start, created_at, nonce) VALUES (?, 1, ?, ?, ?, ?)')
      .run(lockPath, OWNER_PID, OWNER_START, createdAt, nonce);
    db.close();
  }
  if (artifact) {
    writeFileSync(lockPath, JSON.stringify({ version: 1, pid: OWNER_PID, processStart: OWNER_START, createdAt, nonce }));
  }
}

function rowNonce(lockPath: string): string | undefined {
  const db = openDb();
  const row = db.prepare('SELECT nonce FROM state_mutation_locks WHERE lock_key = ?').get(lockPath) as { nonce: string } | undefined;
  db.close();
  return row?.nonce;
}

/** True when no other connection holds the SQLite write lock. */
function writeLockFree(): boolean {
  const db = openDb();
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_BUSY') return false;
    throw error;
  } finally {
    db.close();
  }
}

function hooks(ownerIdentity: () => string, onProbe: () => void = () => {}) {
  return {
    nowMs: () => Date.now(),
    processStartIdentity: (pid: number) => {
      if (pid === process.pid) return SELF_IDENTITY;
      onProbe();
      return ownerIdentity();
    },
  };
}

function acquire(lockPath: string, attempts: number, testHooks: ReturnType<typeof hooks>) {
  return acquireStateFileLockAtPathSync(lockPath, attempts, false, false, 2000, 3000, Infinity, testHooks);
}

describe('issue #4727: state-lock owner probe runs outside the write transaction', () => {
  it('probes a live SQLite row owner without holding the write lock', () => {
    const lockPath = join(stateDir, 'live-row.lock');
    seedOwner(lockPath, NONCE.live);
    const lockFreeDuringProbe: boolean[] = [];

    const lock = acquire(lockPath, 1, hooks(() => OWNER_START, () => lockFreeDuringProbe.push(writeLockFree())));

    expect(lock).toBeNull();
    expect(getStateFileLockFailureKind()).toBe('contention');
    expect(lockFreeDuringProbe).toEqual([true]);
    expect(rowNonce(lockPath)).toBe(NONCE.live);
  });

  it('probes a live owner-file holder without holding the write lock', () => {
    const lockPath = join(stateDir, 'live-artifact.lock');
    seedOwner(lockPath, NONCE.artifact, { row: false });
    const lockFreeDuringProbe: boolean[] = [];

    const lock = acquire(lockPath, 1, hooks(() => OWNER_START, () => lockFreeDuringProbe.push(writeLockFree())));

    expect(lock).toBeNull();
    expect(getStateFileLockFailureKind()).toBe('contention');
    expect(lockFreeDuringProbe).toEqual([true]);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe(NONCE.artifact);
  });

  it('keeps a replacement owner that claimed the row during the probe', () => {
    const lockPath = join(stateDir, 'replaced-row.lock');
    seedOwner(lockPath, NONCE.dead, { artifact: false });

    const lock = acquire(lockPath, 1, hooks(() => 'absent', () => seedOwner(lockPath, NONCE.replacement, { artifact: false })));

    expect(lock).toBeNull();
    expect(getStateFileLockFailureKind()).toBe('contention');
    expect(rowNonce(lockPath)).toBe(NONCE.replacement);
  });

  it('keeps a replacement owner file published during the probe', () => {
    const lockPath = join(stateDir, 'replaced-artifact.lock');
    seedOwner(lockPath, NONCE.dead, { row: false });

    const lock = acquire(lockPath, 1, hooks(() => 'absent', () => seedOwner(lockPath, NONCE.replacement, { row: false })));

    expect(lock).toBeNull();
    expect(getStateFileLockFailureKind()).toBe('contention');
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe(NONCE.replacement);
  });

  it('retries when another waiter acquires and releases the lock during the probe', () => {
    const lockPath = join(stateDir, 'released-during-probe.lock');
    seedOwner(lockPath, NONCE.released, { row: false });
    // The competitor reclaims the dead file, takes the lock, and releases it, leaving it free.
    const competitorCycle = () => rmSync(lockPath, { force: true });

    const lock = acquire(lockPath, 5, hooks(() => 'absent', competitorCycle));

    expect(lock).not.toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe(lock!.owner.nonce);
    expect(releaseStateFileLockSync(lock!)).toBe(true);
  });

  it.each([
    ['row owner', { artifact: false }],
    ['owner file', { row: false }],
  ] as const)('retries an inconclusive %s probe while attempts remain', (_label, seed) => {
    const lockPath = join(stateDir, `inconclusive-${seed.row === false ? 'artifact' : 'row'}.lock`);
    seedOwner(lockPath, randomUUID(), seed);
    const verdicts: Array<string | null> = [null, 'absent'];

    const lock = acquire(lockPath, 2, hooks(() => verdicts.shift() as string));

    expect(verdicts).toEqual([]);
    expect(lock).not.toBeNull();
    expect(rowNonce(lockPath)).toBe(lock!.owner.nonce);
    expect(releaseStateFileLockSync(lock!)).toBe(true);
  });

  it('bounds the post-probe transaction wait by the remaining overall budget', () => {
    const lockPath = join(stateDir, 'post-probe-deadline.lock');
    seedOwner(lockPath, randomUUID(), { artifact: false });
    const blocker = openDb();
    try {
      const slowProbeThenBlock = () => {
        const start = Date.now();
        while (Date.now() - start < 300) { /* simulated PowerShell probe latency */ }
        blocker.exec('BEGIN IMMEDIATE');
      };
      const startedAt = Date.now();
      const lock = acquireStateFileLockAtPathSync(lockPath, 1, false, false, 2000, 3000, 400, hooks(() => 'absent', slowProbeThenBlock));
      const elapsedMs = Date.now() - startedAt;

      expect(lock).toBeNull();
      expect(getStateFileLockFailureKind()).toBe('contention');
      expect(elapsedMs).toBeLessThan(550);
    } finally {
      if (blocker.inTransaction) blocker.exec('ROLLBACK');
      blocker.close();
    }
  });

  it.each([
    ['row owner', { artifact: false }],
    ['owner file', { row: false }],
  ] as const)('gives up without reacquiring the transaction when the %s probe exhausts the deadline', (_label, seed) => {
    const lockPath = join(stateDir, `exhausted-${seed.row === false ? 'artifact' : 'row'}.lock`);
    const nonce = randomUUID();
    seedOwner(lockPath, nonce, seed);
    const execSpy = vi.spyOn(Database.prototype, 'exec');
    let begunAfterProbe = 0;
    try {
      const exhaustBudget = () => {
        const start = Date.now();
        while (Date.now() - start < 250) { /* simulated PowerShell probe latency */ }
        execSpy.mockClear();
      };
      const lock = acquireStateFileLockAtPathSync(lockPath, 2, false, false, 2000, 3000, 200, hooks(() => 'absent', exhaustBudget));
      begunAfterProbe = execSpy.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE').length;

      expect(lock).toBeNull();
      expect(getStateFileLockFailureKind()).toBe('contention');
    } finally {
      execSpy.mockRestore();
    }
    expect(begunAfterProbe).toBe(0);
    if (seed.row === false) {
      expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe(nonce);
    } else {
      expect(rowNonce(lockPath)).toBe(nonce);
    }
  });

  it('retries when a crashed waiter leaves a new stale row between the row cleanup and the artifact check', () => {
    const lockPath = join(stateDir, 'stale-after-cleanup.lock');
    seedOwner(lockPath, randomUUID(), { artifact: false });
    const intruderNonce = randomUUID();
    const originalExec = Database.prototype.exec;
    let intruded = false;
    const execSpy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
      const result = originalExec.call(this, sql);
      if (sql === 'COMMIT' && !intruded) {
        intruded = true;
        // Another waiter claims the key and crashes during release: its owner file
        // is gone but its row was never deleted.
        seedOwner(lockPath, intruderNonce, { artifact: false });
      }
      return result;
    });
    let lock: ReturnType<typeof acquire>;
    try {
      lock = acquire(lockPath, 3, hooks(() => 'absent'));
    } finally {
      execSpy.mockRestore();
    }

    expect(intruded).toBe(true);
    expect(lock).not.toBeNull();
    expect(rowNonce(lockPath)).toBe(lock!.owner.nonce);
    expect(releaseStateFileLockSync(lock!)).toBe(true);
  });

  it('recovers a crashed holder that left both its row and its owner file', () => {
    const lockPath = join(stateDir, 'crashed-holder.lock');
    seedOwner(lockPath, NONCE.crashed);

    const lock = acquire(lockPath, 1, hooks(() => 'absent'));

    expect(lock).not.toBeNull();
    expect(rowNonce(lockPath)).toBe(lock!.owner.nonce);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe(lock!.owner.nonce);
    expect(releaseStateFileLockSync(lock!)).toBe(true);
    expect(rowNonce(lockPath)).toBeUndefined();
  });
});
