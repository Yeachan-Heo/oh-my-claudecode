import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import {
  initJobDb,
  closeJobDb,
  isJobDbInitialized,
  getJobDb,
  upsertJob,
  getJob,
  getJobsByStatus,
  getActiveJobs,
  getRecentJobs,
  updateJobStatus,
  deleteJob,
  migrateFromJsonFiles,
  cleanupOldJobs,
  getJobStats,
  getJobSummaryForPreCompact,
} from '../mcp/job-state-db.js';
import type { JobStatus } from '../mcp/prompt-persistence.js';

// Test fixtures
const TEST_DIR = join(process.cwd(), '.test-job-state-db-' + process.pid);
const PROMPTS_DIR = join(TEST_DIR, '.omc', 'prompts');

function createTestJob(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    provider: 'codex',
    jobId: 'abcd1234',
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

describe('job-state-db', () => {
  beforeEach(async () => {
    // Clean up any previous test state
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    closeJobDb();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('initJobDb', () => {
    it('should initialize the database successfully', async () => {
      const result = await initJobDb(TEST_DIR);
      expect(result).toBe(true);
      expect(isJobDbInitialized()).toBe(true);
    });

    it('should create the jobs.db file', async () => {
      await initJobDb(TEST_DIR);
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'jobs.db'))).toBe(true);
    });

    it('should be idempotent', async () => {
      await initJobDb(TEST_DIR);
      const result = await initJobDb(TEST_DIR);
      expect(result).toBe(true);
    });
  });

  describe('closeJobDb', () => {
    it('should close the database', async () => {
      await initJobDb(TEST_DIR);
      closeJobDb();
      expect(isJobDbInitialized()).toBe(false);
    });

    it('should be safe to call when not initialized', () => {
      expect(() => closeJobDb()).not.toThrow();
    });
  });

  describe('isJobDbInitialized', () => {
    it('should return false before init', () => {
      expect(isJobDbInitialized()).toBe(false);
    });

    it('should return true after init', async () => {
      await initJobDb(TEST_DIR);
      expect(isJobDbInitialized()).toBe(true);
    });

    it('should return false after close', async () => {
      await initJobDb(TEST_DIR);
      closeJobDb();
      expect(isJobDbInitialized()).toBe(false);
    });
  });

  describe('getJobDb', () => {
    it('should return null when not initialized', () => {
      expect(getJobDb()).toBeNull();
    });

    it('should return database instance when initialized', async () => {
      await initJobDb(TEST_DIR);
      const db = getJobDb();
      expect(db).not.toBeNull();
      expect(db).toHaveProperty('prepare');
    });
  });

  describe('upsertJob', () => {
    beforeEach(async () => {
      await initJobDb(TEST_DIR);
    });

    it('should insert a new job', () => {
      const job = createTestJob();
      expect(upsertJob(job)).toBe(true);
    });

    it('should update an existing job', () => {
      const job = createTestJob();
      upsertJob(job);

      const updated = createTestJob({ status: 'completed', completedAt: new Date().toISOString() });
      expect(upsertJob(updated)).toBe(true);

      const fetched = getJob('codex', 'abcd1234');
      expect(fetched?.status).toBe('completed');
    });

    it('should return false when db is not initialized', () => {
      closeJobDb();
      expect(upsertJob(createTestJob())).toBe(false);
    });

    it('should handle jobs with all optional fields', () => {
      const job = createTestJob({
        completedAt: '2024-01-01T00:00:00Z',
        error: 'test error',
        usedFallback: true,
        fallbackModel: 'gpt-4',
        killedByUser: true,
      });
      expect(upsertJob(job)).toBe(true);

      const fetched = getJob('codex', 'abcd1234');
      expect(fetched?.completedAt).toBe('2024-01-01T00:00:00Z');
      expect(fetched?.error).toBe('test error');
      expect(fetched?.usedFallback).toBe(true);
      expect(fetched?.fallbackModel).toBe('gpt-4');
      expect(fetched?.killedByUser).toBe(true);
    });

    it('should handle jobs with undefined optional fields', () => {
      const job = createTestJob({
        pid: undefined,
        completedAt: undefined,
        error: undefined,
        usedFallback: undefined,
        fallbackModel: undefined,
        killedByUser: undefined,
      });
      expect(upsertJob(job)).toBe(true);

      const fetched = getJob('codex', 'abcd1234');
      expect(fetched).not.toBeNull();
      expect(fetched?.pid).toBeUndefined();
      expect(fetched?.completedAt).toBeUndefined();
      expect(fetched?.error).toBeUndefined();
      expect(fetched?.usedFallback).toBeUndefined();
      expect(fetched?.fallbackModel).toBeUndefined();
      expect(fetched?.killedByUser).toBeUndefined();
    });
  });

  describe('getJob', () => {
    beforeEach(async () => {
      await initJobDb(TEST_DIR);
    });

    it('should return a job by provider and jobId', () => {
      const job = createTestJob();
      upsertJob(job);

      const result = getJob('codex', 'abcd1234');
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('codex');
      expect(result!.jobId).toBe('abcd1234');
      expect(result!.model).toBe('gpt-5.3-codex');
      expect(result!.agentRole).toBe('architect');
    });

    it('should return null for non-existent job', () => {
      expect(getJob('codex', 'nonexist')).toBeNull();
    });

    it('should handle both providers independently', () => {
      upsertJob(createTestJob({ provider: 'codex', jobId: 'aaaa1111' }));
      upsertJob(createTestJob({ provider: 'gemini', jobId: 'aaaa1111' }));

      expect(getJob('codex', 'aaaa1111')).not.toBeNull();
      expect(getJob('gemini', 'aaaa1111')).not.toBeNull();
    });

    it('should correctly map boolean fields', () => {
      const job = createTestJob({ usedFallback: true, fallbackModel: 'gpt-4', killedByUser: true });
      upsertJob(job);

      const result = getJob('codex', 'abcd1234');
      expect(result!.usedFallback).toBe(true);
      expect(result!.fallbackModel).toBe('gpt-4');
      expect(result!.killedByUser).toBe(true);
    });

    it('should return null when db is not initialized', () => {
      closeJobDb();
      expect(getJob('codex', 'abcd1234')).toBeNull();
    });
  });

  describe('getJobsByStatus', () => {
    beforeEach(async () => {
      await initJobDb(TEST_DIR);
    });

    it('should filter by status for all providers', () => {
      upsertJob(createTestJob({ provider: 'codex', jobId: 'c1', status: 'completed' }));
      upsertJob(createTestJob({ provider: 'gemini', jobId: 'g1', status: 'completed' }));
      upsertJob(createTestJob({ provider: 'codex', jobId: 'c2', status: 'failed' }));

      const completed = getJobsByStatus(undefined, 'completed');
      expect(completed).toHaveLength(2);
      expect(completed.map(j => j.jobId).sort()).toEqual(['c1', 'g1']);
    });

    it('should filter by provider and status', () => {
      upsertJob(createTestJob({ provider: 'codex', jobId: 'c1', status: 'completed' }));
      upsertJob(createTestJob({ provider: 'gemini', jobId: 'g1', status: 'completed' }));

      const codexCompleted = getJobsByStatus('codex', 'completed');
      expect(codexCompleted).toHaveLength(1);
      expect(codexCompleted[0].provider).toBe('codex');
    });

    it('should return empty array when no matches', () => {
      upsertJob(createTestJob({ status: 'running' }));
      expect(getJobsByStatus(undefined, 'completed')).toEqual([]);
    });

    it('should return empty array when db is not initialized', () => {
      closeJobDb();
      expect(getJobsByStatus(undefined, 'completed')).toEqual([]);
    });
  });

  describe('getActiveJobs', () => {
    beforeEach(async () => {
      await initJobDb(TEST_DIR);
    });

    it('should return spawned and running jobs', () => {
      upsertJob(createTestJob({ jobId: 'j1', status: 'spawned' }));
      upsertJob(createTestJob({ jobId: 'j2', status: 'running' }));
      upsertJob(createTestJob({ jobId: 'j3', status: 'completed' }));
      upsertJob(createTestJob({ jobId: 'j4', status: 'failed' }));

      const active = getActiveJobs();
      expect(active).toHaveLength(2);
      expect(active.map(j => j.jobId).sort()).toEqual(['j1', 'j2']);
    });

    it('should filter by provider', () => {
      upsertJob(createTestJob({ provider: 'codex', jobId: 'c1', status: 'running' }));
      upsertJob(createTestJob({ provider: 'gemini', jobId: 'g1', status: 'running' }));

      const codexJobs = getActiveJobs('codex');
      expect(codexJobs).toHaveLength(1);
      expect(codexJobs[0].provider).toBe('codex');
    });

    it('should return empty array when no active jobs', () => {
      upsertJob(createTestJob({ status: 'completed' }));
      expect(getActiveJobs()).toEqual([]);
    });

    it('should return empty array when db is not initialized', () => {
      closeJobDb();
      expect(getActiveJobs()).toEqual([]);
    });

    it('should include timeout status as not active', () => {
      upsertJob(createTestJob({ jobId: 'j1', status: 'timeout' }));
      upsertJob(createTestJob({ jobId: 'j2', status: 'running' }));

      const active = getActiveJobs();
      expect(active).toHaveLength(1);
      expect(active[0].jobId).toBe('j2');
    });
  });

  describe('getRecentJobs', () => {
    beforeEach(async () => {
      await initJobDb(TEST_DIR);
    });

    it('should return jobs within time window', () => {
      const recentTime = new Date().toISOString();
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

      upsertJob(createTestJob({ jobId: 'recent1', spawnedAt: recentTime }));
      upsertJob(createTestJob({ jobId: 'old1', spawnedAt: oldTime }));

      const recent = getRecentJobs(undefined, 60 * 60 * 1000); // 1 hour
      expect(recent).toHaveLength(1);
      expect(recent[0].jobId).toBe('recent1');
    });

    it('should filter by provider', () => {
      const recentTime = new Date().toISOString();
      upsertJob(createTestJob({ provider: 'codex', jobId: 'c1', spawnedAt: recentTime }));
      upsertJob(createTestJob({ provider: 'gemini', jobId: 'g1', spawnedAt: recentTime }));

      const codexRecent = getRecentJobs('codex', 60 * 60 * 1000);
      expect(codexRecent).toHaveLength(1);
      expect(codexRecent[0].provider).toBe('codex');
    });

    it('should use default time window of 1 hour', () => {
      const recentTime = new Date().toISOString();
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      upsertJob(createTestJob({ jobId: 'recent1', spawnedAt: recentTime }));
      upsertJob(createTestJob({ jobId: 'old1', spawnedAt: oldTime }));

      const recent = getRecentJobs();
      expect(recent).toHaveLength(1);
    });

    it('should return empty array when db is not initialized', () => {
      closeJobDb();
      expect(getRecentJobs()).toEqual([]);
    });
  });

  describe('updateJobStatus', () => {
    beforeEach(async () => {
      await initJobDb(TEST_DIR);
    });

    it('should update specific fields', () => {
      upsertJob(createTestJob());

      updateJobStatus('codex', 'abcd1234', {
        status: 'completed',
        completedAt: '2024-01-01T00:00:00Z',
      });

      const result = getJob('codex', 'abcd1234');
      expect(result!.status).toBe('completed');
      expect(result!.completedAt).toBe('2024-01-01T00:00:00Z');
      // Unchanged fields should remain
      expect(result!.model).toBe('gpt-5.3-codex');
    });

    it('should return true even if no fields to update', () => {
      upsertJob(createTestJob());
      expect(updateJobStatus('codex', 'abcd1234', {})).toBe(true);
    });

    it('should update pid field', () => {
      upsertJob(createTestJob({ pid: 12345 }));
      updateJobStatus('codex', 'abcd1234', { pid: 99999 });

      const result = getJob('codex', 'abcd1234');
      expect(result!.pid).toBe(99999);
    });

    it('should update error field', () => {
      upsertJob(createTestJob());
      updateJobStatus('codex', 'abcd1234', { error: 'test error message' });

      const result = getJob('codex', 'abcd1234');
      expect(result!.error).toBe('test error message');
    });

    it('should update fallback fields', () => {
      upsertJob(createTestJob());
      updateJobStatus('codex', 'abcd1234', {
        usedFallback: true,
        fallbackModel: 'gpt-4',
      });

      const result = getJob('codex', 'abcd1234');
      expect(result!.usedFallback).toBe(true);
      expect(result!.fallbackModel).toBe('gpt-4');
    });

    it('should update killedByUser field', () => {
      upsertJob(createTestJob());
      updateJobStatus('codex', 'abcd1234', { killedByUser: true });

      const result = getJob('codex', 'abcd1234');
      expect(result!.killedByUser).toBe(true);
    });

    it('should update slug, model, and agentRole fields', () => {
      upsertJob(createTestJob());
      updateJobStatus('codex', 'abcd1234', {
        slug: 'new-slug',
        model: 'gpt-4',
        agentRole: 'planner',
      });

      const result = getJob('codex', 'abcd1234');
      expect(result!.slug).toBe('new-slug');
      expect(result!.model).toBe('gpt-4');
      expect(result!.agentRole).toBe('planner');
    });

    it('should return false when db is not initialized', () => {
      closeJobDb();
      expect(updateJobStatus('codex', 'abcd1234', { status: 'completed' })).toBe(false);
    });
  });

  describe('deleteJob', () => {
    beforeEach(async () => {
      await initJobDb(TEST_DIR);
    });

    it('should delete a job', () => {
      upsertJob(createTestJob());
      expect(deleteJob('codex', 'abcd1234')).toBe(true);
      expect(getJob('codex', 'abcd1234')).toBeNull();
    });

    it('should succeed even if job does not exist', () => {
      expect(deleteJob('codex', 'nonexist')).toBe(true);
    });

    it('should only delete the specified provider job', () => {
      upsertJob(createTestJob({ provider: 'codex', jobId: 'aaaa1111' }));
      upsertJob(createTestJob({ provider: 'gemini', jobId: 'aaaa1111' }));

      deleteJob('codex', 'aaaa1111');

      expect(getJob('codex', 'aaaa1111')).toBeNull();
      expect(getJob('gemini', 'aaaa1111')).not.toBeNull();
    });

    it('should return false when db is not initialized', () => {
      closeJobDb();
      expect(deleteJob('codex', 'abcd1234')).toBe(false);
    });
  });

  describe('migrateFromJsonFiles', () => {
    beforeEach(async () => {
      await initJobDb(TEST_DIR);
      mkdirSync(PROMPTS_DIR, { recursive: true });
    });

    it('should import valid status JSON files', () => {
      const job = createTestJob({ jobId: 'migrated1' });
      writeFileSync(
        join(PROMPTS_DIR, 'codex-status-test-migrated1.json'),
        JSON.stringify(job),
      );

      const result = migrateFromJsonFiles(PROMPTS_DIR);
      expect(result.imported).toBe(1);
      expect(result.errors).toBe(0);

      const fetched = getJob('codex', 'migrated1');
      expect(fetched).not.toBeNull();
      expect(fetched!.jobId).toBe('migrated1');
    });

    it('should skip malformed files', () => {
      writeFileSync(
        join(PROMPTS_DIR, 'codex-status-bad-file.json'),
        'not valid json',
      );

      const result = migrateFromJsonFiles(PROMPTS_DIR);
      expect(result.errors).toBe(1);
      expect(result.imported).toBe(0);
    });

    it('should return zero counts for empty directory', () => {
      const result = migrateFromJsonFiles(PROMPTS_DIR);
      expect(result.imported).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('should import multiple files in a transaction', () => {
      const job1 = createTestJob({ jobId: 'job1' });
      const job2 = createTestJob({ jobId: 'job2', provider: 'gemini' });

      writeFileSync(
        join(PROMPTS_DIR, 'codex-status-test-job1.json'),
        JSON.stringify(job1),
      );
      writeFileSync(
        join(PROMPTS_DIR, 'gemini-status-test-job2.json'),
        JSON.stringify(job2),
      );

      const result = migrateFromJsonFiles(PROMPTS_DIR);
      expect(result.imported).toBe(2);
      expect(result.errors).toBe(0);

      expect(getJob('codex', 'job1')).not.toBeNull();
      expect(getJob('gemini', 'job2')).not.toBeNull();
    });

    it('should skip files missing required fields', () => {
      const invalidJob = { status: 'completed' }; // missing provider, jobId, promptFile

      writeFileSync(
        join(PROMPTS_DIR, 'codex-status-invalid.json'),
        JSON.stringify(invalidJob),
      );

      const result = migrateFromJsonFiles(PROMPTS_DIR);
      expect(result.imported).toBe(0);
      expect(result.errors).toBe(1);
    });

    it('should handle non-existent directory gracefully', () => {
      const result = migrateFromJsonFiles('/nonexistent/path');
      expect(result.imported).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('should return zero counts when db is not initialized', () => {
      closeJobDb();
      const result = migrateFromJsonFiles(PROMPTS_DIR);
      expect(result.imported).toBe(0);
      expect(result.errors).toBe(0);
    });
  });

  describe('cleanupOldJobs', () => {
    beforeEach(async () => {
      await initJobDb(TEST_DIR);
    });

    it('should remove old terminal jobs', () => {
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago
      upsertJob(createTestJob({ jobId: 'old1', status: 'completed', spawnedAt: oldTime }));
      upsertJob(createTestJob({ jobId: 'old2', status: 'failed', spawnedAt: oldTime }));
      upsertJob(createTestJob({ jobId: 'new1', status: 'completed', spawnedAt: new Date().toISOString() }));
      upsertJob(createTestJob({ jobId: 'active1', status: 'running', spawnedAt: oldTime }));

      const cleaned = cleanupOldJobs(24 * 60 * 60 * 1000);
      expect(cleaned).toBe(2);

      // New completed and active old should still exist
      expect(getJob('codex', 'new1')).not.toBeNull();
      expect(getJob('codex', 'active1')).not.toBeNull();
      expect(getJob('codex', 'old1')).toBeNull();
      expect(getJob('codex', 'old2')).toBeNull();
    });

    it('should not remove active jobs regardless of age', () => {
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      upsertJob(createTestJob({ jobId: 'active1', status: 'spawned', spawnedAt: oldTime }));
      upsertJob(createTestJob({ jobId: 'active2', status: 'running', spawnedAt: oldTime }));

      cleanupOldJobs(1000); // 1 second
      expect(getJob('codex', 'active1')).not.toBeNull();
      expect(getJob('codex', 'active2')).not.toBeNull();
    });

    it('should remove timeout status jobs', () => {
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      upsertJob(createTestJob({ jobId: 'timeout1', status: 'timeout', spawnedAt: oldTime }));

      const cleaned = cleanupOldJobs(24 * 60 * 60 * 1000);
      expect(cleaned).toBe(1);
      expect(getJob('codex', 'timeout1')).toBeNull();
    });

    it('should use default max age of 24 hours', () => {
      const oldTime = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30 hours ago
      const recentTime = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(); // 12 hours ago

      upsertJob(createTestJob({ jobId: 'old1', status: 'completed', spawnedAt: oldTime }));
      upsertJob(createTestJob({ jobId: 'recent1', status: 'completed', spawnedAt: recentTime }));

      const cleaned = cleanupOldJobs();
      expect(cleaned).toBe(1);
      expect(getJob('codex', 'old1')).toBeNull();
      expect(getJob('codex', 'recent1')).not.toBeNull();
    });

    it('should return 0 when db is not initialized', () => {
      closeJobDb();
      expect(cleanupOldJobs()).toBe(0);
    });

    it('should return 0 when no jobs to clean', () => {
      upsertJob(createTestJob({ status: 'running' }));
      expect(cleanupOldJobs()).toBe(0);
    });
  });

  describe('getJobStats', () => {
    beforeEach(async () => {
      await initJobDb(TEST_DIR);
    });

    it('should return correct counts', () => {
      upsertJob(createTestJob({ jobId: 'j1', status: 'spawned' }));
      upsertJob(createTestJob({ jobId: 'j2', status: 'running' }));
      upsertJob(createTestJob({ jobId: 'j3', status: 'completed' }));
      upsertJob(createTestJob({ jobId: 'j4', status: 'failed' }));
      upsertJob(createTestJob({ jobId: 'j5', status: 'timeout' }));

      const stats = getJobStats();
      expect(stats).not.toBeNull();
      expect(stats!.total).toBe(5);
      expect(stats!.active).toBe(2);
      expect(stats!.completed).toBe(1);
      expect(stats!.failed).toBe(2); // failed + timeout
    });

    it('should return all zeros for empty db', () => {
      const stats = getJobStats();
      expect(stats).not.toBeNull();
      expect(stats!.total).toBe(0);
      expect(stats!.active).toBe(0);
      expect(stats!.completed).toBe(0);
      expect(stats!.failed).toBe(0);
    });

    it('should count both providers together', () => {
      upsertJob(createTestJob({ provider: 'codex', jobId: 'c1', status: 'running' }));
      upsertJob(createTestJob({ provider: 'gemini', jobId: 'g1', status: 'completed' }));

      const stats = getJobStats();
      expect(stats!.total).toBe(2);
      expect(stats!.active).toBe(1);
      expect(stats!.completed).toBe(1);
    });

    it('should return null when db is not initialized', () => {
      closeJobDb();
      expect(getJobStats()).toBeNull();
    });
  });

  describe('getJobSummaryForPreCompact', () => {
    beforeEach(async () => {
      await initJobDb(TEST_DIR);
    });

    it('should return empty string when no jobs', () => {
      expect(getJobSummaryForPreCompact()).toBe('');
    });

    it('should include active jobs', () => {
      upsertJob(createTestJob({ jobId: 'j1', status: 'running', agentRole: 'architect' }));

      const summary = getJobSummaryForPreCompact();
      expect(summary).toContain('Active Background Jobs');
      expect(summary).toContain('j1');
      expect(summary).toContain('architect');
    });

    it('should include recent completed jobs', () => {
      upsertJob(createTestJob({ jobId: 'j1', status: 'completed', agentRole: 'planner' }));

      const summary = getJobSummaryForPreCompact();
      expect(summary).toContain('Recent Completed Jobs');
      expect(summary).toContain('j1');
      expect(summary).toContain('planner');
    });

    it('should include job stats', () => {
      upsertJob(createTestJob({ jobId: 'j1', status: 'running' }));
      upsertJob(createTestJob({ jobId: 'j2', status: 'completed' }));

      const summary = getJobSummaryForPreCompact();
      expect(summary).toContain('Job totals:');
      expect(summary).toContain('2 total');
      expect(summary).toContain('1 active');
      expect(summary).toContain('1 completed');
    });

    it('should show elapsed time for active jobs', () => {
      const oldTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
      upsertJob(createTestJob({ jobId: 'j1', status: 'running', spawnedAt: oldTime }));

      const summary = getJobSummaryForPreCompact();
      expect(summary).toMatch(/running for \d+m/);
    });

    it('should show fallback information', () => {
      upsertJob(createTestJob({
        jobId: 'j1',
        status: 'completed',
        usedFallback: true,
        fallbackModel: 'gpt-4',
      }));

      const summary = getJobSummaryForPreCompact();
      expect(summary).toContain('fallback: gpt-4');
    });

    it('should show error messages', () => {
      upsertJob(createTestJob({
        jobId: 'j1',
        status: 'failed',
        error: 'test error message',
      }));

      const summary = getJobSummaryForPreCompact();
      expect(summary).toContain('error: test error message');
    });

    it('should truncate long error messages', () => {
      const longError = 'a'.repeat(200);
      upsertJob(createTestJob({
        jobId: 'j1',
        status: 'failed',
        error: longError,
      }));

      const summary = getJobSummaryForPreCompact();
      expect(summary).toContain('error:');
      expect(summary).not.toContain(longError); // Should be truncated
    });

    it('should limit recent jobs to 10', () => {
      // Create 15 completed jobs
      for (let i = 1; i <= 15; i++) {
        upsertJob(createTestJob({ jobId: `j${i}`, status: 'completed' }));
      }

      const summary = getJobSummaryForPreCompact();
      expect(summary).toContain('and 5 more');
    });

    it('should only show recent jobs from last hour', () => {
      const recentTime = new Date().toISOString();
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

      upsertJob(createTestJob({ jobId: 'recent1', status: 'completed', spawnedAt: recentTime }));
      upsertJob(createTestJob({ jobId: 'old1', status: 'completed', spawnedAt: oldTime }));

      const summary = getJobSummaryForPreCompact();
      expect(summary).toContain('recent1');
      expect(summary).not.toContain('old1');
    });

    it('should show both codex and gemini jobs', () => {
      upsertJob(createTestJob({ provider: 'codex', jobId: 'c1', status: 'running' }));
      upsertJob(createTestJob({ provider: 'gemini', jobId: 'g1', status: 'running' }));

      const summary = getJobSummaryForPreCompact();
      expect(summary).toContain('codex');
      expect(summary).toContain('gemini');
      expect(summary).toContain('c1');
      expect(summary).toContain('g1');
    });

    it('should return empty string when db is not initialized', () => {
      closeJobDb();
      expect(getJobSummaryForPreCompact()).toBe('');
    });
  });
});
