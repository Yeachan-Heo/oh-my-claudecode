import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../platform/process-utils.js', () => ({
  getProcessStartIdentity: vi.fn(async () => 'test-identity'),
  isProcessIdentityLive: vi.fn(async () => 'dead'),
}));

const mockRunAction = vi.hoisted(() => vi.fn());
vi.mock('../action-runner.js', () => ({
  runSessionEndAction: mockRunAction
}));
vi.mock('../action-watchdog.js', () => ({ armSessionEndActionWatchdog: () => () => undefined }));

import { prepareCoreManifest, readSessionEndJob, sealCoreManifest, sealWikiManifest } from '../cleanup-manifest.js';
import { processSessionEndWorker } from '../worker.js';

let directory: string;
beforeEach(() => {
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), 'omc-worker-release-fix-'));
  vi.stubEnv('HOME', directory);
  vi.stubEnv('USERPROFILE', directory);
  mockRunAction.mockReset().mockResolvedValue({ completed: true, code: 'completed' });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('SessionEnd worker release fix (issue c)', () => {
  it('handles release returning null by logging and rescheduling', async () => {
    const sessionId = 'release-null';
    
    prepareCoreManifest(directory, sessionId, {});
    sealCoreManifest(directory, sessionId);
    sealWikiManifest(directory, sessionId);

    // Make first action reach started, then jump past deadline
    mockRunAction.mockImplementation(async (input) => {
      if (input.actionName === 'foreground-cleanup') {
        vi.setSystemTime(Date.now() + 20_000);
      }
      return { completed: true, code: 'completed' };
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(processSessionEndWorker({ directory, sessionId })).resolves.toBeUndefined();

    const job = readSessionEndJob(directory, sessionId)!;
    
    // The job should have exited due to run-deadline-reached, with owner released
    expect(job.recoverableFailure?.reason).toBe('run-deadline-reached');
    expect(job.owner).toBeNull();
    
    // For actions that were claimed but never started (still in 'reserved' phase),
    // they should be reset to 'retryable'
    expect(job.actions['team-cleanup']).toMatchObject({ status: 'retryable' });
    expect(job.actions['python-cleanup']).toMatchObject({ status: 'retryable' });
    
    // foreground-cleanup was already completed
    expect(job.actions['foreground-cleanup'].status).toBe('completed');
    
    // callback was never claimed
    expect(job.actions.callback.status).toBe('pending');
    
    warn.mockRestore();
  });
});
