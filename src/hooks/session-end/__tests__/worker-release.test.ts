import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../platform/process-utils.js', () => ({
  getProcessStartIdentity: vi.fn(async () => 'test-process-start'),
  isProcessIdentityLive: vi.fn(async () => 'dead'),
}));

vi.mock('../action-runner.js', () => ({
  runSessionEndAction: vi.fn().mockResolvedValue({ completed: true, code: 'completed' })
}));

vi.mock('../action-watchdog.js', () => ({ armSessionEndActionWatchdog: () => () => undefined }));

import { prepareCoreManifest, readSessionEndJob, sealCoreManifest, sealWikiManifest } from '../cleanup-manifest.js';
import { runSessionEndAction } from '../action-runner.js';
import { processSessionEndWorker } from '../worker.js';

let directory: string;
beforeEach(() => {
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), 'omc-session-end-release-'));
  vi.stubEnv('HOME', directory);
  vi.stubEnv('USERPROFILE', directory);
  vi.mocked(runSessionEndAction).mockReset().mockResolvedValue({ completed: true, code: 'completed' });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('SessionEnd worker release handling', () => {
  it('handles release returning null by logging and rescheduling (issue c)', async () => {
    const sessionId = 'release-null-case';
    
    prepareCoreManifest(directory, sessionId, {});
    sealCoreManifest(directory, sessionId);
    sealWikiManifest(directory, sessionId);

    // Make first action jump past deadline while running
    vi.mocked(runSessionEndAction).mockImplementation(async (input) => {
      if (input.actionName === 'foreground-cleanup') {
        vi.setSystemTime(Date.now() + 20_000);
      }
      return { completed: true, code: 'completed' };
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const schedule = vi.spyOn(globalThis, 'setTimeout');

    await expect(processSessionEndWorker({ directory, sessionId })).resolves.toBeUndefined();

    // Should have hit run-deadline-reached
    const job = readSessionEndJob(directory, sessionId)!;
    expect(job.owner).toBeNull();
    expect(job.recoverableFailure?.reason).toBe('run-deadline-reached');

    // Should reschedule
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), expect.any(Number));

    warn.mockRestore();
    schedule.mockRestore();
  });

  it('only resets claimed actions in reserved phase on run-deadline-reached (issue b)', async () => {
    const sessionId = 'deadline-reserved-phase-only';
    
    prepareCoreManifest(directory, sessionId, {});
    sealCoreManifest(directory, sessionId);
    sealWikiManifest(directory, sessionId);

    // Mock to jump deadline after first action  
    vi.mocked(runSessionEndAction).mockImplementation(async (input) => {
      if (input.actionName === 'foreground-cleanup') {
        vi.setSystemTime(Date.now() + 20_000);
      }
      return { completed: true, code: 'completed' };
    });

    await expect(processSessionEndWorker({ directory, sessionId })).resolves.toBeUndefined();

    const job = readSessionEndJob(directory, sessionId)!;
    
    // Actions claimed but never started (reserved phase) should be reset to retryable
    expect(job.actions['team-cleanup']).toMatchObject({ status: 'retryable' });
    expect(job.actions['python-cleanup']).toMatchObject({ status: 'retryable' });
    
    // foreground-cleanup was completed
    expect(job.actions['foreground-cleanup'].status).toBe('completed');
    
    // callback was never claimed, stays pending
    expect(job.actions.callback.status).toBe('pending');
    
    expect(job.recoverableFailure?.reason).toBe('run-deadline-reached');
  });
});
