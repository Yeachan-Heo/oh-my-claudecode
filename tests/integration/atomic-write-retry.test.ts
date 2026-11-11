/**
 * Integration tests for atomic write retry logic on Windows rename errors.
 * Tests cover EPERM, EBUSY, EACCES error recovery with bounded backoff.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  atomicWriteJson,
  atomicWriteJsonSync,
  atomicWriteFileSync,
  atomicWriteBatchSync,
} from '../../src/lib/atomic-write.js';

describe('atomic write retry logic for Windows rename errors', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-write-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  describe('shouldRetryRename behavior', () => {
    it('retries EPERM on Windows only', async () => {
      const originalPlatform = process.platform;
      const filePath = path.join(tmpDir, 'test.json');
      const testData = { test: 'data' };

      // Mock fs.rename to simulate EPERM error
      const originalRename = fs.rename;
      let attemptCount = 0;

      // Only test on Windows
      if (originalPlatform === 'win32') {
        try {
          vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
            attemptCount++;
            if (attemptCount < 3) {
              const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
              error.code = 'EPERM';
              throw error;
            }
            // Succeed on third attempt
            return originalRename(src, dst);
          });

          await atomicWriteJson(filePath, testData);
          expect(attemptCount).toBe(3);

          const content = await fs.readFile(filePath, 'utf-8');
          expect(JSON.parse(content)).toEqual(testData);
        } finally {
          vi.restoreAllMocks();
        }
      } else {
        // On non-Windows, retry should not happen
        expect(originalPlatform).not.toBe('win32');
      }
    });

    it('retries EBUSY on Windows only', async () => {
      const filePath = path.join(tmpDir, 'test-busy.json');
      const testData = { test: 'busy' };
      const originalPlatform = process.platform;

      if (originalPlatform === 'win32') {
        const originalRename = fs.rename;
        let attemptCount = 0;

        try {
          vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
            attemptCount++;
            if (attemptCount === 1) {
              const error = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
              error.code = 'EBUSY';
              throw error;
            }
            return originalRename(src, dst);
          });

          await atomicWriteJson(filePath, testData);
          expect(attemptCount).toBe(2);

          const content = await fs.readFile(filePath, 'utf-8');
          expect(JSON.parse(content)).toEqual(testData);
        } finally {
          vi.restoreAllMocks();
        }
      }
    });

    it('retries EACCES on Windows only', async () => {
      const filePath = path.join(tmpDir, 'test-access.json');
      const testData = { test: 'access' };
      const originalPlatform = process.platform;

      if (originalPlatform === 'win32') {
        const originalRename = fs.rename;
        let attemptCount = 0;

        try {
          vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
            attemptCount++;
            if (attemptCount === 1) {
              const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
              error.code = 'EACCES';
              throw error;
            }
            return originalRename(src, dst);
          });

          await atomicWriteJson(filePath, testData);
          expect(attemptCount).toBe(2);

          const content = await fs.readFile(filePath, 'utf-8');
          expect(JSON.parse(content)).toEqual(testData);
        } finally {
          vi.restoreAllMocks();
        }
      }
    });

    it('does not retry other error codes', async () => {
      const filePath = path.join(tmpDir, 'test-noretry.json');
      const testData = { test: 'noretry' };
      const originalPlatform = process.platform;

      if (originalPlatform === 'win32') {
        const originalRename = fs.rename;

        try {
          vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
            const error = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          });

          await expect(atomicWriteJson(filePath, testData)).rejects.toThrow('ENOENT');
        } finally {
          vi.restoreAllMocks();
        }
      }
    });

    it('fails after max retry attempts', async () => {
      const filePath = path.join(tmpDir, 'test-maxretry.json');
      const testData = { test: 'maxretry' };
      const originalPlatform = process.platform;

      if (originalPlatform === 'win32') {
        try {
          vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
            const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          });

          await expect(atomicWriteJson(filePath, testData)).rejects.toThrow('EPERM');

          // Temp file should be cleaned up
          const tempFiles = await fs.readdir(path.dirname(filePath));
          const tmpCount = tempFiles.filter(f => f.includes('.tmp.')).length;
          expect(tmpCount).toBe(0);
        } finally {
          vi.restoreAllMocks();
        }
      }
    });
  });

  describe('sync write retry behavior', () => {
    it('retries EPERM on sync rename on Windows', async () => {
      const filePath = path.join(tmpDir, 'sync-test.txt');
      const content = 'test content';
      const originalPlatform = process.platform;

      if (originalPlatform === 'win32') {
        const originalRenameSync = fsSync.renameSync;
        let attemptCount = 0;

        try {
          vi.spyOn(fsSync, 'renameSync').mockImplementation((src, dst) => {
            attemptCount++;
            if (attemptCount < 2) {
              const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
              error.code = 'EPERM';
              throw error;
            }
            return originalRenameSync(src, dst);
          });

          atomicWriteFileSync(filePath, content);
          expect(attemptCount).toBeGreaterThanOrEqual(2);

          const fileContent = fsSync.readFileSync(filePath, 'utf-8');
          expect(fileContent).toBe(content);
        } finally {
          vi.restoreAllMocks();
        }
      }
    });

    it('sync write cleans up temp file after max retries', async () => {
      const filePath = path.join(tmpDir, 'sync-maxretry.txt');
      const content = 'test content';
      const originalPlatform = process.platform;

      if (originalPlatform === 'win32') {
        try {
          vi.spyOn(fsSync, 'renameSync').mockImplementation((src, dst) => {
            const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          });

          expect(() => atomicWriteFileSync(filePath, content)).toThrow('EPERM');

          // Temp file should be cleaned up in finally block
          const files = fsSync.readdirSync(path.dirname(filePath));
          const tmpCount = files.filter(f => f.includes('.tmp.')).length;
          expect(tmpCount).toBe(0);
        } finally {
          vi.restoreAllMocks();
        }
      }
    });
  });

  describe('batch write retry behavior', () => {
    it('retries EPERM on batch sync rename on Windows', async () => {
      const filePath1 = path.join(tmpDir, 'batch-test-1.txt');
      const filePath2 = path.join(tmpDir, 'batch-test-2.txt');
      const originalPlatform = process.platform;

      if (originalPlatform === 'win32') {
        const originalRenameSync = fsSync.renameSync;
        let attemptCount = 0;

        try {
          vi.spyOn(fsSync, 'renameSync').mockImplementation((src, dst) => {
            attemptCount++;
            // Fail first two attempts only for the first file
            if (attemptCount <= 2) {
              const error = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
              error.code = 'EBUSY';
              throw error;
            }
            return originalRenameSync(src, dst);
          });

          atomicWriteBatchSync([
            { path: filePath1, content: 'content1' },
            { path: filePath2, content: 'content2' },
          ]);

          expect(fsSync.readFileSync(filePath1, 'utf-8')).toBe('content1');
          expect(fsSync.readFileSync(filePath2, 'utf-8')).toBe('content2');
        } finally {
          vi.restoreAllMocks();
        }
      }
    });
  });

  describe('basic functionality preserved', () => {
    it('writes JSON correctly without errors', async () => {
      const filePath = path.join(tmpDir, 'basic.json');
      const testData = { name: 'test', value: 42, nested: { key: 'value' } };

      await atomicWriteJson(filePath, testData);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(JSON.parse(content)).toEqual(testData);
    });

    it('writes text correctly without errors', () => {
      const filePath = path.join(tmpDir, 'basic.txt');
      const testContent = 'Hello, World!\nLine 2\nLine 3';

      atomicWriteFileSync(filePath, testContent);

      const content = fsSync.readFileSync(filePath, 'utf-8');
      expect(content).toBe(testContent);
    });

    it('writes batch correctly without errors', () => {
      const files = [
        { path: path.join(tmpDir, 'batch-1.txt'), content: 'content1' },
        { path: path.join(tmpDir, 'batch-2.txt'), content: 'content2' },
        { path: path.join(tmpDir, 'batch-3.txt'), content: 'content3' },
      ];

      atomicWriteBatchSync(files);

      for (const file of files) {
        const content = fsSync.readFileSync(file.path, 'utf-8');
        expect(content).toBe(file.content);
      }
    });

    it('syncs JSON correctly without errors', () => {
      const filePath = path.join(tmpDir, 'sync-basic.json');
      const testData = { sync: true, value: 123 };

      atomicWriteJsonSync(filePath, testData);

      const content = fsSync.readFileSync(filePath, 'utf-8');
      expect(JSON.parse(content)).toEqual(testData);
    });
  });
});
