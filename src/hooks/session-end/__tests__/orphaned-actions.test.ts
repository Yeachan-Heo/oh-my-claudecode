import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimSessionEndAction,
  claimSessionEndJob,
  markSessionEndActionRunner,
  prepareCoreManifest,
  readSessionEndJob,
  releaseSessionEndJob,
  sealCoreManifest,
  sealWikiManifest,
} from '../cleanup-manifest.js';

let directory: string;
const sessionId = 'orphaned-actions';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  directory = mkdtempSync(join(tmpdir(), 'omc-orphaned-actions-'));
  vi.stubEnv('OMC_STATE_DIR', directory);
  prepareCoreManifest(directory, sessionId, {});
  sealCoreManifest(directory, sessionId);
  sealWikiManifest(directory, sessionId);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function startActions() {
  const owner = claimSessionEndJob(directory, sessionId, 'old-owner', 'old-identity', Date.now() + 5_000)!;
  for (const name of ['team-cleanup', 'callback'] as const) {
    const claimed = claimSessionEndAction(directory, sessionId, 'old-owner', name, Date.now() + 5_000)!;
    expect(markSessionEndActionRunner(directory, sessionId, 'old-owner', name, claimed.actions[name].runner!.runnerNonce, 'started')).not.toBeNull();
  }
  return owner.owner!;
}

describe('ownerless claimed SessionEnd actions', () => {
  it('recovers required actions and expires uncertain best-effort delivery when a new worker claims after runner deadline passes', () => {
    const owner = startActions();
    const released = releaseSessionEndJob(directory, sessionId, owner.nonce, owner.leaseGeneration)!;
    expect(released.owner).toBeNull();
    expect(released.actions['team-cleanup'].status).toBe('claimed');
    expect(released.actions.callback.status).toBe('claimed');

    // Advance time so runner deadline has passed. Runners were created with deadline of now+5s,
    // so we advance to 6 seconds later
    vi.setSystemTime(new Date('2026-01-01T00:00:06Z'));
    const recovered = claimSessionEndJob(directory, sessionId, 'new-owner', 'new-identity', Date.now() + 10_000)!
    expect(recovered.actions['team-cleanup']).toMatchObject({ status: 'retryable', attempts: 1, runner: { phase: 'terminal' } });
    expect(recovered.actions['team-cleanup'].claimantNonce).toBeUndefined();
    expect(recovered.actions.callback).toMatchObject({ status: 'expired', attempts: 1, runner: { phase: 'terminal' } });
    expect(recovered.actions.callback.claimantNonce).toBeUndefined();
    expect(recovered.actions['python-cleanup'].status).toBe('pending');
    expect(recovered.actions['wiki-capture'].status).toBe('completed');
    expect(readSessionEndJob(directory, sessionId)?.actions['team-cleanup'].status).toBe('retryable');
    expect(claimSessionEndAction(directory, sessionId, 'new-owner', 'team-cleanup', Date.now() + 5_000)?.actions['team-cleanup']).toMatchObject({ status: 'claimed', attempts: 2, claimantNonce: 'new-owner' });
    expect(claimSessionEndAction(directory, sessionId, 'new-owner', 'callback', Date.now() + 5_000)).toBeNull();
  });

  it('does not recover claims while another owner still holds the job', () => {
    startActions();
    expect(claimSessionEndJob(directory, sessionId, 'new-owner', 'new-identity', Date.now() + 5_000)).toBeNull();
    const job = readSessionEndJob(directory, sessionId)!;
    expect(job.owner?.nonce).toBe('old-owner');
    expect(job.actions['team-cleanup']).toMatchObject({ status: 'claimed', claimantNonce: 'old-owner' });
    expect(job.actions.callback).toMatchObject({ status: 'claimed', claimantNonce: 'old-owner' });
  });

  it('prevents new owner from claiming while runner is still bounded (runner-still-bounded guard)', () => {
    const owner = startActions();
    releaseSessionEndJob(directory, sessionId, owner.nonce, owner.leaseGeneration)!;
    const ownerless = readSessionEndJob(directory, sessionId)!;
    expect(ownerless.owner).toBeNull();
    expect(ownerless.actions['team-cleanup']).toMatchObject({ status: 'claimed', runner: { phase: 'started' } });

    // Try to claim while runner is still bounded (deadline not yet passed)
    // This should return null due to runner-still-bounded check
    const attempt = claimSessionEndJob(directory, sessionId, 'new-owner', 'new-identity', Date.now() + 5_000);
    expect(attempt).toBeNull();

    // Job state should not have changed
    const jobAfter = readSessionEndJob(directory, sessionId)!;
    expect(jobAfter.owner).toBeNull();
    expect(jobAfter.actions['team-cleanup']).toMatchObject({ status: 'claimed', claimantNonce: 'old-owner' });
  });
});
