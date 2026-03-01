import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  acquireFileLockSync,
  releaseFileLockSync,
  withFileLockSync,
  acquireFileLock,
  releaseFileLock,
  withFileLock,
  lockPathFor,
} from '../lib/file-lock.js';

describe('file-lock', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `file-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('lockPathFor', () => {
    it('should append .lock to the file path', () => {
      expect(lockPathFor('/path/to/file.json')).toBe('/path/to/file.json.lock');
    });
  });

  describe('acquireFileLockSync / releaseFileLockSync', () => {
    it('should acquire and release a lock successfully', () => {
      const lockPath = join(testDir, 'test.lock');
      const handle = acquireFileLockSync(lockPath);

      expect(handle).not.toBeNull();
      expect(existsSync(lockPath)).toBe(true);

      // Verify lock payload contains PID
      const payload = JSON.parse(readFileSync(lockPath, 'utf-8'));
      expect(payload.pid).toBe(process.pid);
      expect(payload.timestamp).toBeGreaterThan(0);

      releaseFileLockSync(handle!);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('should fail to acquire when lock is already held', () => {
      const lockPath = join(testDir, 'test.lock');
      const handle1 = acquireFileLockSync(lockPath);
      expect(handle1).not.toBeNull();

      // Second attempt should fail (same process, but O_EXCL prevents it)
      const handle2 = acquireFileLockSync(lockPath);
      expect(handle2).toBeNull();

      releaseFileLockSync(handle1!);
    });

    it('should reap stale lock from dead PID', () => {
      const lockPath = join(testDir, 'test.lock');

      // Create a fake lock file with a dead PID
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999999999, timestamp: Date.now() - 60_000 }),
      );

      // Backdate the file's mtime so it looks old to stat()
      const oldTime = new Date(Date.now() - 60_000);
      utimesSync(lockPath, oldTime, oldTime);

      // Should reap the stale lock and succeed
      const handle = acquireFileLockSync(lockPath, { staleLockMs: 1000 });
      expect(handle).not.toBeNull();

      releaseFileLockSync(handle!);
    });

    it('should not reap lock from alive PID', () => {
      const lockPath = join(testDir, 'test.lock');

      // Create a lock file with current (alive) PID but old timestamp
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, timestamp: Date.now() - 60_000 }),
      );

      // Should not reap because PID is alive
      const handle = acquireFileLockSync(lockPath, { staleLockMs: 1000 });
      expect(handle).toBeNull();

      // Cleanup
      rmSync(lockPath, { force: true });
    });

    it('should retry with timeout and acquire stale lock', () => {
      const lockPath = join(testDir, 'test.lock');

      // Create a lock held by a dead PID with old mtime
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999999999, timestamp: Date.now() - 60_000 }),
      );
      const oldTime = new Date(Date.now() - 60_000);
      utimesSync(lockPath, oldTime, oldTime);

      // Acquire with retry -- should detect stale and reap on retry
      const handle = acquireFileLockSync(lockPath, { timeoutMs: 1000, retryDelayMs: 50, staleLockMs: 1000 });
      expect(handle).not.toBeNull();

      releaseFileLockSync(handle!);
    });

    it('should fail after timeout expires', () => {
      const lockPath = join(testDir, 'test.lock');

      // Create a lock held by current (alive) PID
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
      );

      const start = Date.now();
      const handle = acquireFileLockSync(lockPath, { timeoutMs: 200, retryDelayMs: 50 });
      const elapsed = Date.now() - start;

      expect(handle).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(150); // Should have waited

      // Cleanup
      rmSync(lockPath, { force: true });
    });
  });

  describe('withFileLockSync', () => {
    it('should execute function under lock and release', () => {
      const lockPath = join(testDir, 'test.lock');
      const result = withFileLockSync(lockPath, () => {
        expect(existsSync(lockPath)).toBe(true);
        return 42;
      });

      expect(result).toBe(42);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('should release lock even on error', () => {
      const lockPath = join(testDir, 'test.lock');

      expect(() => {
        withFileLockSync(lockPath, () => {
          throw new Error('test error');
        });
      }).toThrow('test error');

      expect(existsSync(lockPath)).toBe(false);
    });

    it('should throw when lock cannot be acquired', () => {
      const lockPath = join(testDir, 'test.lock');

      // Hold the lock
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
      );

      expect(() => {
        withFileLockSync(lockPath, () => 'should not run');
      }).toThrow('Failed to acquire file lock');

      // Cleanup
      rmSync(lockPath, { force: true });
    });
  });

  describe('acquireFileLock (async)', () => {
    it('should acquire and release a lock successfully', async () => {
      const lockPath = join(testDir, 'test-async.lock');
      const handle = await acquireFileLock(lockPath);

      expect(handle).not.toBeNull();
      expect(existsSync(lockPath)).toBe(true);

      releaseFileLock(handle!);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('should retry with timeout and acquire when lock is released', async () => {
      const lockPath = join(testDir, 'test-async.lock');
      const handle1 = await acquireFileLock(lockPath);
      expect(handle1).not.toBeNull();

      // Release after a short delay
      setTimeout(() => {
        releaseFileLock(handle1!);
      }, 100);

      const handle2 = await acquireFileLock(lockPath, { timeoutMs: 1000, retryDelayMs: 50 });
      expect(handle2).not.toBeNull();

      releaseFileLock(handle2!);
    });
  });

  describe('withFileLock (async)', () => {
    it('should execute async function under lock and release', async () => {
      const lockPath = join(testDir, 'test-async.lock');
      const result = await withFileLock(lockPath, async () => {
        expect(existsSync(lockPath)).toBe(true);
        return 'async-result';
      });

      expect(result).toBe('async-result');
      expect(existsSync(lockPath)).toBe(false);
    });

    it('should release lock even on async error', async () => {
      const lockPath = join(testDir, 'test-async.lock');

      await expect(
        withFileLock(lockPath, async () => {
          throw new Error('async error');
        }),
      ).rejects.toThrow('async error');

      expect(existsSync(lockPath)).toBe(false);
    });
  });

  describe('concurrent writes with locking', () => {
    it('should prevent data loss with concurrent notepad-style writes', () => {
      const dataPath = join(testDir, 'data.txt');
      const lockPath = lockPathFor(dataPath);
      writeFileSync(dataPath, '');

      // Simulate 10 concurrent writers, each appending a unique line
      const results: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        try {
          withFileLockSync(lockPath, () => {
            const current = readFileSync(dataPath, 'utf-8');
            writeFileSync(dataPath, current + `line-${i}\n`);
          }, { timeoutMs: 5000 });
          results.push(true);
        } catch {
          results.push(false);
        }
      }

      // All writes should succeed
      expect(results.every(r => r)).toBe(true);

      // All 10 lines should be present (no data loss)
      const final = readFileSync(dataPath, 'utf-8');
      const lines = final.trim().split('\n');
      expect(lines).toHaveLength(10);
      for (let i = 0; i < 10; i++) {
        expect(lines).toContain(`line-${i}`);
      }
    });

    it('should prevent data loss with concurrent async writes', async () => {
      const dataPath = join(testDir, 'data-async.json');
      const lockPath = lockPathFor(dataPath);
      writeFileSync(dataPath, JSON.stringify({ items: [] }));

      // Launch 10 concurrent async writers
      const writers = Array.from({ length: 10 }, (_, i) =>
        withFileLock(lockPath, async () => {
          const content = JSON.parse(readFileSync(dataPath, 'utf-8'));
          content.items.push(`item-${i}`);
          writeFileSync(dataPath, JSON.stringify(content));
        }, { timeoutMs: 5000 }),
      );

      await Promise.all(writers);

      // All 10 items should be present
      const final = JSON.parse(readFileSync(dataPath, 'utf-8'));
      expect(final.items).toHaveLength(10);
      for (let i = 0; i < 10; i++) {
        expect(final.items).toContain(`item-${i}`);
      }
    });
  });
});
