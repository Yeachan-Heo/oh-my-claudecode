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

import { claimSessionEndAction, claimSessionEndJob, markSessionEndActionRunner, prepareCoreManifest, readSessionEndJob, releaseSessionEndJob, renewSessionEndLease, sealCoreManifest, sealWikiManifest } from '../cleanup-manifest.js';
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
  it('logs and reschedules when release returns null (issue c)', async () => {
    const sessionId = 'release-null';
    
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

    // Should log that release returned null
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to release worker job: release returned null'));
    
    // Should still reschedule despite release failure
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), expect.any(Number));
    
    const job = readSessionEndJob(directory, sessionId)!;
    expect(job.owner).toBeNull();
    expect(job.recoverableFailure?.reason).toBe('run-deadline-reached');

    warn.mockRestore();
    schedule.mockRestore();
  });

  it('resets only claimed actions in reserved phase on run-deadline-reached (issue b)', async () => {
    const sessionId = 'deadline-reserved-only';
    
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
    
    // Actions that were claimed but never marked as started (still in reserved phase)
    // should be reset to retryable
    expect(job.actions['team-cleanup']).toMatchObject({ status: 'retryable' });
    expect(job.actions['python-cleanup']).toMatchObject({ status: 'retryable' });
    
    // foreground-cleanup was completed
    expect(job.actions['foreground-cleanup'].status).toBe('completed');
    
    // callback was never claimed, so stays pending
    expect(job.actions.callback.status).toBe('pending');
    
    expect(job.recoverableFailure?.reason).toBe('run-deadline-reached');
  });

  it('prevents claiming ownerless job while runner is still bounded (issue d)', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const sessionId = 'runner-still-bounded';

    prepareCoreManifest(directory, sessionId, {});
    sealCoreManifest(directory, sessionId);
    sealWikiManifest(directory, sessionId);

    // First owner claims job and starts an action
    const deadlineAt = Date.now() + 10_000;
    const first = claimSessionEndJob(directory, sessionId, 'owner-1', 'identity-1', deadlineAt)!;
    const actionClaimed = claimSessionEndAction(directory, sessionId, 'owner-1', 'team-cleanup', deadlineAt)!;
    const runner = actionClaimed.actions['team-cleanup'].runner!;
    
    // Mark it as started
    markSessionEndActionRunner(directory, sessionId, 'owner-1', 'team-cleanup', runner.runnerNonce, 'started');

    // Release the job (owner becomes null)
    releaseSessionEndJob(directory, sessionId, first.owner!.nonce, first.owner!.leaseGeneration)!;

    // Verify job is now ownerless but action is still claimed in started phase
    const ownerless = readSessionEndJob(directory, sessionId)!;
    expect(ownerless.owner).toBeNull();
    expect(ownerless.actions['team-cleanup']).toMatchObject({
      status: 'claimed',
      runner: { phase: 'started' }
    });

    // New owner should NOT be able to claim while runner is still bounded
    const attempt = claimSessionEndJob(directory, sessionId, 'owner-2', 'identity-2', Date.now() + 10_000);
    
    expect(attempt).toBeNull();
    
    // Job should still be ownerless with same action state
    const jobAfter = readSessionEndJob(directory, sessionId)!;
    expect(jobAfter.owner).toBeNull();
    expect(jobAfter.actions['team-cleanup']).toMatchObject({ status: 'claimed', claimantNonce: 'owner-1' });
  });

  it('allows claiming ownerless job after runner deadline has passed (issue d)', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const sessionId = 'runner-deadline-passed';

    prepareCoreManifest(directory, sessionId, {});
    sealCoreManifest(directory, sessionId);
    sealWikiManifest(directory, sessionId);

    // First owner claims job and starts an action with short deadline
    const shortDeadline = Date.now() + 5_000;
    const first = claimSessionEndJob(directory, sessionId, 'owner-1', 'identity-1', shortDeadline)!;
    const actionClaimed = claimSessionEndAction(directory, sessionId, 'owner-1', 'team-cleanup', shortDeadline)!;
    const runner = actionClaimed.actions['team-cleanup'].runner!;
    markSessionEndActionRunner(directory, sessionId, 'owner-1', 'team-cleanup', runner.runnerNonce, 'started');

    // Release the job
    releaseSessionEndJob(directory, sessionId, first.owner!.nonce, first.owner!.leaseGeneration)!;

    // Jump past the runner deadline
    vi.setSystemTime(shortDeadline + 1000);

    // Now new owner should be able to claim
    const recovered = claimSessionEndJob(directory, sessionId, 'owner-2', 'identity-2', Date.now() + 10_000);
    
    expect(recovered).not.toBeNull();
    expect(recovered!.owner?.nonce).toBe('owner-2');
    
    // Old action should be recovered as retryable (required action) or expired (best-effort)
    expect(recovered!.actions['team-cleanup']).toMatchObject({
      status: 'retryable',
      runner: { phase: 'terminal' }
    });
  });
});
