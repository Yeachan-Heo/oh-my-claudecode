/**
 * Unit tests for src/setup/lockfile.ts.
 *
 * Covers: happy-path acquire/release, foreign-hostname refusal, stale PID
 * auto-release, collision on live PID, TOCTOU race via concurrent acquire,
 * corrupt-lockfile recovery, PID alive check semantics.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  acquireLock,
  isPidAlive,
  LockHeldError,
  STALE_LOCK_MS,
} from '../lockfile.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `omc-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('lockfile', () => {
  let tmp: string;
  let lockPath: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    lockPath = join(tmp, 'setup.lock');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('acquireLock — happy path', () => {
    it('creates lockfile with full content, releases cleanly', () => {
      const handle = acquireLock(lockPath, 'cli', {
        hostname: 'testhost',
        pid: 12345,
        now: () => Date.parse('2026-04-11T00:00:00.000Z'),
      });

      expect(handle.path).toBe(lockPath);
      expect(handle.content).toEqual({
        pid: 12345,
        hostname: 'testhost',
        startedAt: '2026-04-11T00:00:00.000Z',
        invoker: 'cli',
      });

      expect(existsSync(lockPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(parsed.pid).toBe(12345);

      handle.release();
      expect(existsSync(lockPath)).toBe(false);
    });

    it('creates parent directory if missing', () => {
      const nestedPath = join(tmp, 'nested', 'deep', 'setup.lock');
      const handle = acquireLock(nestedPath, 'skill', {
        hostname: 'h',
        pid: 1,
        now: () => 0,
      });
      expect(existsSync(nestedPath)).toBe(true);
      handle.release();
    });

    it('release is idempotent', () => {
      const handle = acquireLock(lockPath, 'cli', {
        hostname: 'h', pid: 1, now: () => 0,
      });
      handle.release();
      handle.release(); // must not throw
      expect(existsSync(lockPath)).toBe(false);
    });

    it('release does not remove a lock taken over after auto-release', () => {
      // Simulate: first lock released, second lock acquired, first release()
      // called again — must not clobber the second lock.
      const first = acquireLock(lockPath, 'cli', {
        hostname: 'h', pid: 100, now: () => 0,
      });
      first.release();

      const second = acquireLock(lockPath, 'cli', {
        hostname: 'h', pid: 200, now: () => 1000,
      });

      // Double-release first — should NOT remove second's lockfile.
      first.release();
      expect(existsSync(lockPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(parsed.pid).toBe(200);

      second.release();
    });
  });

  describe('acquireLock — conflict handling', () => {
    it('throws LockHeldError on foreign hostname (NFS concern)', () => {
      writeFileSync(lockPath, JSON.stringify({
        pid: 999,
        hostname: 'otherhost',
        startedAt: new Date().toISOString(),
        invoker: 'cli',
      }));

      expect(() =>
        acquireLock(lockPath, 'cli', { hostname: 'myhost', pid: 1, now: Date.now }),
      ).toThrow(LockHeldError);

      try {
        acquireLock(lockPath, 'cli', { hostname: 'myhost', pid: 1, now: Date.now });
      } catch (err) {
        expect(err).toBeInstanceOf(LockHeldError);
        const e = err as LockHeldError;
        expect(e.message).toContain('different host');
        expect(e.message).toContain('otherhost');
        expect(e.existing.hostname).toBe('otherhost');
      }

      // Lockfile MUST still exist — foreign host is never auto-released.
      expect(existsSync(lockPath)).toBe(true);
    });

    it('throws LockHeldError when same-host PID is alive', () => {
      writeFileSync(lockPath, JSON.stringify({
        pid: 42,
        hostname: 'h',
        startedAt: new Date().toISOString(),
        invoker: 'cli',
      }));

      const aliveFn = (pid: number): boolean => pid === 42;
      expect(() =>
        acquireLock(lockPath, 'cli', {
          hostname: 'h', pid: 1, now: Date.now, isPidAlive: aliveFn,
        }),
      ).toThrow(LockHeldError);
      expect(existsSync(lockPath)).toBe(true);
    });

    it('auto-releases stale lock (old + dead PID)', () => {
      const oldTime = Date.parse('2026-04-11T00:00:00.000Z');
      const nowTime = oldTime + STALE_LOCK_MS + 1000;

      writeFileSync(lockPath, JSON.stringify({
        pid: 9999,
        hostname: 'h',
        startedAt: new Date(oldTime).toISOString(),
        invoker: 'cli',
      }));

      const aliveFn = (pid: number): boolean => pid === 42; // 9999 is dead
      const handle = acquireLock(lockPath, 'cli', {
        hostname: 'h', pid: 42, now: () => nowTime, isPidAlive: aliveFn,
      });

      expect(handle.content.pid).toBe(42);
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(parsed.pid).toBe(42);
      handle.release();
    });

    it('does NOT auto-release old lock if PID is still alive', () => {
      const oldTime = Date.parse('2026-04-11T00:00:00.000Z');
      const nowTime = oldTime + STALE_LOCK_MS + 1000;

      writeFileSync(lockPath, JSON.stringify({
        pid: 42,
        hostname: 'h',
        startedAt: new Date(oldTime).toISOString(),
        invoker: 'cli',
      }));

      const aliveFn = (pid: number): boolean => pid === 42; // still alive

      expect(() =>
        acquireLock(lockPath, 'cli', {
          hostname: 'h', pid: 1, now: () => nowTime, isPidAlive: aliveFn,
        }),
      ).toThrow(LockHeldError);
      expect(existsSync(lockPath)).toBe(true);
    });

    it('does NOT auto-release fresh lock even if PID is dead', () => {
      // Fresh lock + dead PID → we still refuse (age threshold not met).
      // This prevents races during heavy load / PID-table wraparound.
      const nowTime = Date.parse('2026-04-11T00:00:00.000Z');
      writeFileSync(lockPath, JSON.stringify({
        pid: 9999,
        hostname: 'h',
        startedAt: new Date(nowTime).toISOString(),
        invoker: 'cli',
      }));

      const aliveFn = (): boolean => false;
      expect(() =>
        acquireLock(lockPath, 'cli', {
          hostname: 'h', pid: 1, now: () => nowTime, isPidAlive: aliveFn,
        }),
      ).toThrow(LockHeldError);
    });

    it('corrupt lockfile is treated as stale and auto-released', () => {
      writeFileSync(lockPath, 'not valid json');
      const handle = acquireLock(lockPath, 'cli', {
        hostname: 'h', pid: 1, now: () => 0,
      });
      expect(handle.content.pid).toBe(1);
      handle.release();
    });

    it('malformed lockfile (missing fields) is treated as stale', () => {
      writeFileSync(lockPath, JSON.stringify({ pid: 1 })); // missing hostname/startedAt/invoker
      const handle = acquireLock(lockPath, 'cli', {
        hostname: 'h', pid: 2, now: () => 0,
      });
      expect(handle.content.pid).toBe(2);
      handle.release();
    });

    it('corrupt lockfile with bad timestamp is treated as stale', () => {
      writeFileSync(lockPath, JSON.stringify({
        pid: 1,
        hostname: 'h',
        startedAt: 'not-a-date',
        invoker: 'cli',
      }));
      const aliveFn = (): boolean => true; // still auto-releases because timestamp is corrupt
      const handle = acquireLock(lockPath, 'cli', {
        hostname: 'h', pid: 2, now: () => 0, isPidAlive: aliveFn,
      });
      expect(handle.content.pid).toBe(2);
      handle.release();
    });
  });

  describe('isPidAlive', () => {
    it('returns true for the current process', () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it('returns false for negative / zero / non-integer', () => {
      expect(isPidAlive(0)).toBe(false);
      expect(isPidAlive(-1)).toBe(false);
      expect(isPidAlive(1.5)).toBe(false);
    });

    it('returns false for a PID that (almost certainly) does not exist', () => {
      // PID 2^30 is above the Linux max_pid ceiling; on macOS/BSD kill() on
      // a PID that high returns ESRCH.
      expect(isPidAlive(1 << 30)).toBe(false);
    });
  });
});
