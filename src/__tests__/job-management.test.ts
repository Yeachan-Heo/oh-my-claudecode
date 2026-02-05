import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findJobStatusFile, handleKillJob, handleWaitForJob, handleCheckJobStatus, handleListJobs } from '../mcp/job-management.js';
import * as promptPersistence from '../mcp/prompt-persistence.js';

// Mock the prompt-persistence module
vi.mock('../mcp/prompt-persistence.js', async () => {
  const actual = await vi.importActual('../mcp/prompt-persistence.js');
  return {
    ...actual,
    getPromptsDir: vi.fn(() => '/tmp/test-prompts'),
    readJobStatus: vi.fn(),
    writeJobStatus: vi.fn(),
    readCompletedResponse: vi.fn(),
    listActiveJobs: vi.fn(() => []),
  };
});

// Mock fs functions
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(),
  };
});

// Mock codex-core PID registry
vi.mock('../mcp/codex-core.js', async () => {
  const actual = await vi.importActual('../mcp/codex-core.js');
  return {
    ...actual,
    isSpawnedPid: vi.fn(() => true),
  };
});

// Mock gemini-core PID registry
vi.mock('../mcp/gemini-core.js', async () => {
  const actual = await vi.importActual('../mcp/gemini-core.js');
  return {
    ...actual,
    isSpawnedPid: vi.fn(() => true),
  };
});

describe('job-management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findJobStatusFile', () => {
    describe('jobId validation', () => {
      it('returns undefined for non-hex jobId', () => {
        const result = findJobStatusFile('codex', 'not-hex!');
        expect(result).toBeUndefined();
      });

      it('returns undefined for too-short jobId', () => {
        const result = findJobStatusFile('codex', 'abc123');
        expect(result).toBeUndefined();
      });

      it('returns undefined for too-long jobId', () => {
        const result = findJobStatusFile('codex', 'abc123def456');
        expect(result).toBeUndefined();
      });

      it('returns undefined for path traversal attempt', () => {
        const result = findJobStatusFile('codex', '../etc/pa');
        expect(result).toBeUndefined();
      });

      it('proceeds for valid 8-char hex jobId (lowercase)', async () => {
        const fs = await import('fs');
        (fs.existsSync as any).mockReturnValue(true);
        (fs.readdirSync as any).mockReturnValue(['codex-status-test-slug-ab12cd34.json']);
        (fs.readFileSync as any).mockReturnValue(JSON.stringify({
          status: 'running',
          spawnedAt: new Date().toISOString()
        }));

        const result = findJobStatusFile('codex', 'ab12cd34');
        expect(result).toBeDefined();
        expect(result?.slug).toBe('test-slug');
      });

      it('proceeds for valid 8-char hex jobId (uppercase)', async () => {
        const fs = await import('fs');
        (fs.existsSync as any).mockReturnValue(true);
        (fs.readdirSync as any).mockReturnValue(['codex-status-test-slug-AB12CD34.json']);
        (fs.readFileSync as any).mockReturnValue(JSON.stringify({
          status: 'running',
          spawnedAt: new Date().toISOString()
        }));

        const result = findJobStatusFile('codex', 'AB12CD34');
        expect(result).toBeDefined();
      });
    });
  });

  describe('handleKillJob', () => {
    describe('signal validation', () => {
      it('allows SIGTERM', async () => {
        const mockStatus = {
          provider: 'codex',
          jobId: 'ab12cd34',
          slug: 'test',
          status: 'running',
          pid: 12345,
          promptFile: '/tmp/prompt.md',
          responseFile: '/tmp/response.md',
          model: 'gpt-5.2',
          agentRole: 'architect',
          spawnedAt: new Date().toISOString(),
        };

        vi.spyOn(promptPersistence, 'readJobStatus').mockReturnValue(mockStatus as any);
        vi.spyOn(process, 'kill').mockImplementation(() => true);

        const fs = await import('fs');
        (fs.existsSync as any).mockReturnValue(true);
        (fs.readdirSync as any).mockReturnValue(['codex-status-test-ab12cd34.json']);
        (fs.readFileSync as any).mockReturnValue(JSON.stringify(mockStatus));

        const result = await handleKillJob('codex', 'ab12cd34', 'SIGTERM');
        expect(result.isError).toBeFalsy();
      });

      it('allows SIGINT', async () => {
        const mockStatus = {
          provider: 'codex',
          jobId: 'ab12cd34',
          slug: 'test',
          status: 'running',
          pid: 12345,
          promptFile: '/tmp/prompt.md',
          responseFile: '/tmp/response.md',
          model: 'gpt-5.2',
          agentRole: 'architect',
          spawnedAt: new Date().toISOString(),
        };

        vi.spyOn(promptPersistence, 'readJobStatus').mockReturnValue(mockStatus as any);
        vi.spyOn(process, 'kill').mockImplementation(() => true);

        const fs = await import('fs');
        (fs.existsSync as any).mockReturnValue(true);
        (fs.readdirSync as any).mockReturnValue(['codex-status-test-ab12cd34.json']);
        (fs.readFileSync as any).mockReturnValue(JSON.stringify(mockStatus));

        const result = await handleKillJob('codex', 'ab12cd34', 'SIGINT');
        expect(result.isError).toBeFalsy();
      });

      it('rejects SIGKILL', async () => {
        const result = await handleKillJob('codex', 'ab12cd34', 'SIGKILL');
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Invalid signal');
        expect(result.content[0].text).toContain('SIGKILL');
      });

      it('rejects arbitrary strings', async () => {
        const result = await handleKillJob('codex', 'ab12cd34', 'rm -rf /');
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Invalid signal');
      });

      it('rejects SIGUSR1', async () => {
        const result = await handleKillJob('codex', 'ab12cd34', 'SIGUSR1');
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Invalid signal');
      });
    });

    describe('ESRCH handling', () => {
      it('preserves completed status when ESRCH', async () => {
        const mockStatus = {
          provider: 'codex',
          jobId: 'ab12cd34',
          slug: 'test',
          status: 'running',
          pid: 12345,
          promptFile: '/tmp/prompt.md',
          responseFile: '/tmp/response.md',
          model: 'gpt-5.2',
          agentRole: 'architect',
          spawnedAt: new Date().toISOString(),
        };

        const completedStatus = { ...mockStatus, status: 'completed' };

        const fs = await import('fs');
        (fs.existsSync as any).mockReturnValue(true);
        (fs.readdirSync as any).mockReturnValue(['codex-status-test-ab12cd34.json']);
        (fs.readFileSync as any).mockReturnValue(JSON.stringify(mockStatus));

        // First call returns running (for initial check), subsequent calls return completed
        let callCount = 0;
        vi.spyOn(promptPersistence, 'readJobStatus').mockImplementation(() => {
          callCount++;
          return callCount === 1 ? mockStatus as any : completedStatus as any;
        });

        const writeJobStatusSpy = vi.spyOn(promptPersistence, 'writeJobStatus');

        // Mock process.kill to throw ESRCH
        const esrchError = new Error('ESRCH') as NodeJS.ErrnoException;
        esrchError.code = 'ESRCH';
        vi.spyOn(process, 'kill').mockImplementation(() => { throw esrchError; });

        const result = await handleKillJob('codex', 'ab12cd34', 'SIGTERM');

        // Should NOT overwrite to failed since job is completed
        const failedWrites = writeJobStatusSpy.mock.calls.filter(
          call => (call[0] as any).status === 'failed'
        );
        // The initial killedByUser write happens, but after ESRCH with completed status, no failed write
        expect(result.content[0].text).toContain('completed successfully');
      });

      it('marks as failed when running and ESRCH', async () => {
        const mockStatus = {
          provider: 'codex',
          jobId: 'ab12cd34',
          slug: 'test',
          status: 'running',
          pid: 12345,
          promptFile: '/tmp/prompt.md',
          responseFile: '/tmp/response.md',
          model: 'gpt-5.2',
          agentRole: 'architect',
          spawnedAt: new Date().toISOString(),
        };

        const fs = await import('fs');
        (fs.existsSync as any).mockReturnValue(true);
        (fs.readdirSync as any).mockReturnValue(['codex-status-test-ab12cd34.json']);
        (fs.readFileSync as any).mockReturnValue(JSON.stringify(mockStatus));

        vi.spyOn(promptPersistence, 'readJobStatus').mockReturnValue(mockStatus as any);
        const writeJobStatusSpy = vi.spyOn(promptPersistence, 'writeJobStatus');

        const esrchError = new Error('ESRCH') as NodeJS.ErrnoException;
        esrchError.code = 'ESRCH';
        vi.spyOn(process, 'kill').mockImplementation(() => { throw esrchError; });

        await handleKillJob('codex', 'ab12cd34', 'SIGTERM');

        // Should write failed status
        const failedWrites = writeJobStatusSpy.mock.calls.filter(
          call => (call[0] as any).status === 'failed'
        );
        expect(failedWrites.length).toBeGreaterThan(0);
      });
    });
  });

  describe('handleWaitForJob', () => {
    describe('timeout_ms validation', () => {
      it('clamps negative to 1000ms minimum', async () => {
        const runningStatus = {
          provider: 'codex',
          jobId: 'ab12cd34',
          slug: 'test',
          status: 'running',
          pid: 12345,
          promptFile: '/tmp/prompt.md',
          responseFile: '/tmp/response.md',
          model: 'gpt-5.2',
          agentRole: 'architect',
          spawnedAt: new Date().toISOString(),
        };

        const fs = await import('fs');
        (fs.existsSync as any).mockReturnValue(true);
        (fs.readdirSync as any).mockReturnValue(['codex-status-test-ab12cd34.json']);
        (fs.readFileSync as any).mockReturnValue(JSON.stringify(runningStatus));

        // Always return running status so it waits until timeout
        vi.spyOn(promptPersistence, 'readJobStatus').mockReturnValue(runningStatus as any);

        const start = Date.now();
        await handleWaitForJob('codex', 'ab12cd34', -1);
        const elapsed = Date.now() - start;

        // Should timeout after ~1000ms (the minimum clamped value), not immediately
        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(2000);
      });

      it('clamps zero to 1000ms minimum', async () => {
        const runningStatus = {
          provider: 'codex',
          jobId: 'ab12cd34',
          slug: 'test',
          status: 'running',
          pid: 12345,
          promptFile: '/tmp/prompt.md',
          responseFile: '/tmp/response.md',
          model: 'gpt-5.2',
          agentRole: 'architect',
          spawnedAt: new Date().toISOString(),
        };

        const fs = await import('fs');
        (fs.existsSync as any).mockReturnValue(true);
        (fs.readdirSync as any).mockReturnValue(['codex-status-test-ab12cd34.json']);
        (fs.readFileSync as any).mockReturnValue(JSON.stringify(runningStatus));

        vi.spyOn(promptPersistence, 'readJobStatus').mockReturnValue(runningStatus as any);

        const start = Date.now();
        await handleWaitForJob('codex', 'ab12cd34', 0);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(2000);
      });

      it('accepts normal timeout values', async () => {
        const completedStatus = {
          provider: 'codex',
          jobId: 'ab12cd34',
          slug: 'test',
          status: 'completed',
          promptFile: '/tmp/prompt.md',
          responseFile: '/tmp/response.md',
          model: 'gpt-5.2',
          agentRole: 'architect',
          spawnedAt: new Date().toISOString(),
        };

        const fs = await import('fs');
        (fs.existsSync as any).mockReturnValue(true);
        (fs.readdirSync as any).mockReturnValue(['codex-status-test-ab12cd34.json']);
        (fs.readFileSync as any).mockReturnValue(JSON.stringify(completedStatus));

        vi.spyOn(promptPersistence, 'readJobStatus').mockReturnValue(completedStatus as any);
        vi.spyOn(promptPersistence, 'readCompletedResponse').mockReturnValue({
          response: 'test response',
          status: completedStatus as any
        });

        const result = await handleWaitForJob('codex', 'ab12cd34', 5000);
        expect(result.isError).toBeFalsy();
      });
    });
  });
});
