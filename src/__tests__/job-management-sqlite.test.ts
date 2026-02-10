import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { initJobDb, closeJobDb, upsertJob, getJob } from '../mcp/job-state-db.js';
import { handleCheckJobStatus, handleListJobs, handleKillJob } from '../mcp/job-management.js';
import type { JobStatus } from '../mcp/prompt-persistence.js';

// Mock prompt-persistence to prevent JSON file operations
vi.mock('../mcp/prompt-persistence.js', async () => {
  const actual = await vi.importActual('../mcp/prompt-persistence.js');
  return {
    ...actual,
    getPromptsDir: vi.fn(() => '/tmp/nonexistent-prompts-dir'),
    readJobStatus: vi.fn(() => null),
    writeJobStatus: vi.fn(),
    readCompletedResponse: vi.fn(),
    listActiveJobs: vi.fn(() => []),
  };
});

// Mock fs to return no JSON files (simulating SQLite-only scenario)
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    // Override only readdirSync and existsSync for the prompts dir
    existsSync: vi.fn((path: string) => {
      if (typeof path === 'string' && path.includes('nonexistent-prompts')) return false;
      return (actual as any).existsSync(path);
    }),
    readdirSync: vi.fn((path: string, ...args: any[]) => {
      if (typeof path === 'string' && path.includes('nonexistent-prompts')) return [];
      return (actual as any).readdirSync(path, ...args);
    }),
  };
});

// Mock codex-core and gemini-core PID registries
vi.mock('../mcp/codex-core.js', async () => {
  const actual = await vi.importActual('../mcp/codex-core.js');
  return {
    ...actual,
    isSpawnedPid: vi.fn(() => true),
  };
});

vi.mock('../mcp/gemini-core.js', async () => {
  const actual = await vi.importActual('../mcp/gemini-core.js');
  return {
    ...actual,
    isSpawnedPid: vi.fn(() => true),
  };
});

const TEST_DIR = join(process.cwd(), '.test-job-mgmt-sqlite-' + process.pid);

function createTestJob(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    provider: 'codex',
    jobId: 'abcd1234',
    slug: 'test-prompt',
    status: 'running',
    pid: 12345,
    promptFile: '/test/prompt.md',
    responseFile: '/test/response.md',
    model: 'gpt-5.3-codex',
    agentRole: 'architect',
    spawnedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('job-management SQLite integration', () => {
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    await initJobDb(TEST_DIR);
  });

  afterEach(() => {
    closeJobDb();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('handleCheckJobStatus - SQLite path', () => {
    it('returns job data from SQLite when no JSON file exists', async () => {
      const job = createTestJob({ jobId: 'aabb1122', status: 'running' });
      upsertJob(job);

      const result = await handleCheckJobStatus('codex', 'aabb1122');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('aabb1122');
      expect(result.content[0].text).toContain('running');
      expect(result.content[0].text).toContain('gpt-5.3-codex');
    });

    it('returns error when job not found in SQLite or JSON', async () => {
      const result = await handleCheckJobStatus('codex', 'deadbeef');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No job found');
    });

    it('shows fallback metadata when present', async () => {
      const job = createTestJob({
        jobId: 'aabb1133',
        status: 'completed',
        usedFallback: true,
        fallbackModel: 'gpt-5.2-codex',
        completedAt: new Date().toISOString(),
      });
      upsertJob(job);

      const result = await handleCheckJobStatus('codex', 'aabb1133');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Fallback Model');
      expect(result.content[0].text).toContain('gpt-5.2-codex');
    });
  });

  describe('handleListJobs - SQLite path', () => {
    it('lists active jobs from SQLite', async () => {
      upsertJob(createTestJob({ jobId: 'aaaa1111', status: 'running' }));
      upsertJob(createTestJob({ jobId: 'bbbb2222', status: 'spawned' }));

      const result = await handleListJobs('codex', 'active');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('aaaa1111');
      expect(result.content[0].text).toContain('bbbb2222');
      expect(result.content[0].text).toContain('2 active');
    });

    it('lists completed jobs from SQLite', async () => {
      const now = Date.now();
      upsertJob(createTestJob({
        jobId: 'cccc3333',
        status: 'completed',
        completedAt: new Date(now - 1000).toISOString(),
        spawnedAt: new Date(now - 3000).toISOString(),
      }));
      upsertJob(createTestJob({
        jobId: 'dddd4444',
        status: 'completed',
        completedAt: new Date(now - 500).toISOString(),
        spawnedAt: new Date(now - 2000).toISOString(),
      }));
      upsertJob(createTestJob({
        jobId: 'eeee5555',
        status: 'completed',
        completedAt: new Date(now).toISOString(),
        spawnedAt: new Date(now - 1000).toISOString(),
      }));

      const result = await handleListJobs('codex', 'completed');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('cccc3333');
      expect(result.content[0].text).toContain('dddd4444');
      expect(result.content[0].text).toContain('eeee5555');
      expect(result.content[0].text).toContain('3');
    });

    it('lists failed and timeout jobs under failed filter', async () => {
      upsertJob(createTestJob({
        jobId: 'ffff6666',
        status: 'failed',
        error: 'Process crashed',
        completedAt: new Date().toISOString(),
      }));
      upsertJob(createTestJob({
        jobId: 'aaaa7777',
        status: 'timeout',
        error: 'Timed out',
        completedAt: new Date().toISOString(),
      }));

      const result = await handleListJobs('codex', 'failed');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('ffff6666');
      expect(result.content[0].text).toContain('aaaa7777');
    });

    it('lists all jobs with deduplication', async () => {
      upsertJob(createTestJob({ jobId: 'aaaa1111', status: 'running' }));
      upsertJob(createTestJob({
        jobId: 'bbbb2222',
        status: 'completed',
        completedAt: new Date().toISOString(),
      }));
      upsertJob(createTestJob({
        jobId: 'cccc3333',
        status: 'failed',
        error: 'Error',
        completedAt: new Date().toISOString(),
      }));

      const result = await handleListJobs('codex', 'all');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('aaaa1111');
      expect(result.content[0].text).toContain('bbbb2222');
      expect(result.content[0].text).toContain('cccc3333');
      // Should have exactly 3 jobs (no duplicates)
      expect(result.content[0].text).toContain('3');
    });

    it('respects limit parameter', async () => {
      upsertJob(createTestJob({ jobId: 'aaaa1111', status: 'running', spawnedAt: new Date(Date.now() - 3000).toISOString() }));
      upsertJob(createTestJob({ jobId: 'bbbb2222', status: 'running', spawnedAt: new Date(Date.now() - 2000).toISOString() }));
      upsertJob(createTestJob({ jobId: 'cccc3333', status: 'running', spawnedAt: new Date(Date.now() - 1000).toISOString() }));

      const result = await handleListJobs('codex', 'active', 2);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('2 active');
    });

    it('filters by provider', async () => {
      upsertJob(createTestJob({ provider: 'codex', jobId: 'aaaa1111', status: 'running' }));
      upsertJob(createTestJob({ provider: 'gemini', jobId: 'bbbb2222', status: 'running' }));

      const result = await handleListJobs('codex', 'active');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('aaaa1111');
      expect(result.content[0].text).not.toContain('bbbb2222');
    });
  });

  describe('handleKillJob - SQLite fallback path', () => {
    it('kills a running job found only in SQLite', async () => {
      const job = createTestJob({ jobId: 'aabb1122', status: 'running', pid: 99999 });
      upsertJob(job);

      // Mock process.kill to succeed
      vi.spyOn(process, 'kill').mockImplementation(() => true);

      const result = await handleKillJob('codex', 'aabb1122', 'SIGTERM');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Sent SIGTERM');
      expect(result.content[0].text).toContain('aabb1122');

      // Verify status was updated in DB
      const updated = getJob('codex', 'aabb1122');
      expect(updated?.status).toBe('failed');
      expect(updated?.killedByUser).toBe(true);

      vi.restoreAllMocks();
    });

    it('handles ESRCH (process already exited) via SQLite path', async () => {
      const job = createTestJob({ jobId: 'aabb1133', status: 'running', pid: 99999 });
      upsertJob(job);

      const esrchError = new Error('ESRCH') as NodeJS.ErrnoException;
      esrchError.code = 'ESRCH';
      vi.spyOn(process, 'kill').mockImplementation(() => { throw esrchError; });

      const result = await handleKillJob('codex', 'aabb1133', 'SIGTERM');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('already exited');

      // Verify status was updated in DB
      const updated = getJob('codex', 'aabb1133');
      expect(updated?.status).toBe('failed');
      expect(updated?.killedByUser).toBe(true);

      vi.restoreAllMocks();
    });

    it('does NOT update DB status on non-ESRCH kill errors', async () => {
      const job = createTestJob({ jobId: 'aabb1144', status: 'running', pid: 99999 });
      upsertJob(job);

      const epermError = new Error('EPERM') as NodeJS.ErrnoException;
      epermError.code = 'EPERM';
      vi.spyOn(process, 'kill').mockImplementation(() => { throw epermError; });

      const result = await handleKillJob('codex', 'aabb1144', 'SIGTERM');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to kill');

      // Verify status was NOT changed in DB
      const unchanged = getJob('codex', 'aabb1144');
      expect(unchanged?.status).toBe('running');
      expect(unchanged?.killedByUser).toBeFalsy();

      vi.restoreAllMocks();
    });

    it('rejects killing a terminal-state job in SQLite', async () => {
      const job = createTestJob({
        jobId: 'aabb1155',
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      upsertJob(job);

      const result = await handleKillJob('codex', 'aabb1155', 'SIGTERM');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('terminal state');
      expect(result.content[0].text).toContain('completed');
    });

    it('rejects killing a job with no valid PID in SQLite', async () => {
      const job = createTestJob({ jobId: 'aabb1166', status: 'running', pid: 0 });
      upsertJob(job);

      const result = await handleKillJob('codex', 'aabb1166', 'SIGTERM');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no valid PID');
    });
  });

  describe('JSON fallback when SQLite not initialized', () => {
    it('returns not found when both SQLite and JSON are unavailable', async () => {
      closeJobDb();

      const result = await handleCheckJobStatus('codex', 'deadbeef');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No job found');
    });

    it('handleListJobs returns empty when no source available', async () => {
      closeJobDb();

      const result = await handleListJobs('codex', 'active');
      expect(result.content[0].text).toContain('No active');
    });
  });
});
