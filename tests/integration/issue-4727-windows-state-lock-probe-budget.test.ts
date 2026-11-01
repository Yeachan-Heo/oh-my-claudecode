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
import { afterAll, describe, expect, it } from 'vitest';
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
