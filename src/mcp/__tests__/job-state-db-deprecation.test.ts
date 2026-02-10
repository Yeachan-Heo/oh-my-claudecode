import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  initJobDb,
  closeJobDb,
  closeAllJobDbs,
  isJobDbInitialized,
  upsertJob,
  getJob,
} from '../job-state-db.js';
import type { JobStatus } from '../prompt-persistence.js';

const TEST_DIR_A = join(process.cwd(), '.test-jobdb-deprecation-a-' + process.pid);
const TEST_DIR_B = join(process.cwd(), '.test-jobdb-deprecation-b-' + process.pid);

function createTestJob(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    provider: 'codex',
    jobId: 'test-' + Math.random().toString(36).slice(2, 8),
    slug: 'test-prompt',
    status: 'spawned',
    pid: 12345,
    promptFile: '/test/prompt.md',
    responseFile: '/test/response.md',
    model: 'gpt-5.3-codex',
    agentRole: 'architect',
    spawnedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('job-state-db deprecation warnings', () => {
  beforeEach(() => {
    // Ensure clean state
    closeAllJobDbs();
    for (const dir of [TEST_DIR_A, TEST_DIR_B]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
      mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    closeAllJobDbs();
    for (const dir of [TEST_DIR_A, TEST_DIR_B]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe('multi-worktree isolation', () => {
    it('should keep separate data for different cwd paths', async () => {
      await initJobDb(TEST_DIR_A);
      await initJobDb(TEST_DIR_B);

      const jobA = createTestJob({ jobId: 'job-a', provider: 'codex' });
      const jobB = createTestJob({ jobId: 'job-b', provider: 'gemini' });

      upsertJob(jobA, TEST_DIR_A);
      upsertJob(jobB, TEST_DIR_B);

      // Each cwd should only see its own jobs
      expect(getJob('codex', 'job-a', TEST_DIR_A)).not.toBeNull();
      expect(getJob('gemini', 'job-b', TEST_DIR_A)).toBeNull();

      expect(getJob('gemini', 'job-b', TEST_DIR_B)).not.toBeNull();
      expect(getJob('codex', 'job-a', TEST_DIR_B)).toBeNull();
    });
  });

  describe('getDb deprecation warning', () => {
    it('should emit deprecation warning when getDb() called without cwd and multiple DBs are open', async () => {
      await initJobDb(TEST_DIR_A);
      await initJobDb(TEST_DIR_B);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Insert a job without specifying cwd - triggers getDb() no-arg path
      const job = createTestJob({ jobId: 'warn-test' });
      upsertJob(job); // no cwd arg

      const warnings = warnSpy.mock.calls.map(c => c[0]);
      expect(warnings.some((w: string) =>
        typeof w === 'string' && w.includes('DEPRECATED') && w.includes('getDb()')
      )).toBe(true);

      warnSpy.mockRestore();
    });

    it('should not emit deprecation warning with single DB open', async () => {
      await initJobDb(TEST_DIR_A);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const job = createTestJob({ jobId: 'no-warn-test' });
      upsertJob(job); // no cwd arg, but only one DB

      const warnings = warnSpy.mock.calls.map(c => c[0]);
      expect(warnings.some((w: string) =>
        typeof w === 'string' && w.includes('DEPRECATED') && w.includes('getDb()')
      )).toBe(false);

      warnSpy.mockRestore();
    });
  });

  describe('closeAllJobDbs', () => {
    it('should close all open database connections', async () => {
      await initJobDb(TEST_DIR_A);
      await initJobDb(TEST_DIR_B);

      expect(isJobDbInitialized(TEST_DIR_A)).toBe(true);
      expect(isJobDbInitialized(TEST_DIR_B)).toBe(true);

      closeAllJobDbs();

      expect(isJobDbInitialized(TEST_DIR_A)).toBe(false);
      expect(isJobDbInitialized(TEST_DIR_B)).toBe(false);
      expect(isJobDbInitialized()).toBe(false);
    });

    it('should be safe to call when no DBs are open', () => {
      expect(() => closeAllJobDbs()).not.toThrow();
    });

    it('should be safe to call multiple times', async () => {
      await initJobDb(TEST_DIR_A);
      closeAllJobDbs();
      closeAllJobDbs();
      expect(isJobDbInitialized()).toBe(false);
    });
  });

  describe('closeJobDb with specific cwd', () => {
    it('should close only the specified DB', async () => {
      await initJobDb(TEST_DIR_A);
      await initJobDb(TEST_DIR_B);

      closeJobDb(TEST_DIR_A);

      expect(isJobDbInitialized(TEST_DIR_A)).toBe(false);
      expect(isJobDbInitialized(TEST_DIR_B)).toBe(true);
    });
  });

  describe('closeJobDb without cwd deprecation', () => {
    it('should emit deprecation warning when called without cwd', async () => {
      await initJobDb(TEST_DIR_A);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      closeJobDb(); // no cwd

      const warnings = warnSpy.mock.calls.map(c => c[0]);
      expect(warnings.some((w: string) =>
        typeof w === 'string' && w.includes('DEPRECATED') && w.includes('closeJobDb()')
      )).toBe(true);

      warnSpy.mockRestore();
    });
  });
});
