import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Lets a test run another writer right after an owner-fenced call reads the
// revision it will CAS against, and count how often the manifest is read.
const manifestReads: { sessionFile?: string; count: number; afterRead?: () => void } = { count: 0 };
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const result = actual.readFileSync(...args);
      if (manifestReads.sessionFile && String(args[0]).endsWith(manifestReads.sessionFile)) {
        manifestReads.count++;
        const afterRead = manifestReads.afterRead;
        manifestReads.afterRead = undefined;
        afterRead?.();
      }
      return result;
    }) as typeof actual.readFileSync,
  };
});

const manifest = await import('../cleanup-manifest.js');

const directories: string[] = [];
beforeEach(() => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'omc-lease-cas-state-'));
  directories.push(stateRoot);
  vi.stubEnv('OMC_STATE_DIR', stateRoot);
});
afterEach(() => {
  Object.assign(manifestReads, { sessionFile: undefined, count: 0, afterRead: undefined });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function claimedJob(sessionId: string) {
  const directory = mkdtempSync(join(tmpdir(), 'omc-lease-cas-'));
  directories.push(directory);
  expect(manifest.prepareCoreManifest(directory, sessionId, { transcriptPath: '/tmp/transcript' })).not.toBeNull();
  expect(manifest.sealCoreManifest(directory, sessionId)).not.toBeNull();
  expect(manifest.sealWikiManifest(directory, sessionId)).not.toBeNull();
  const claimed = manifest.claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000)!;
  expect(claimed.owner?.leaseGeneration).toBe(1);
  manifestReads.sessionFile = `${sessionId}.json`;
  return { directory, claimed };
}

/** An unrelated write that leaves the owner fence (nonce + generation) intact. */
function unrelatedWrite(directory: string, sessionId: string): void {
  const current = manifest.readSessionEndJob(directory, sessionId)!;
  const written = manifest.mutateSessionEndJob(directory, sessionId, current.revision, (job) => {
    job.actions.callback.payload = { ...job.actions.callback.payload, unrelated: true };
  });
  expect(written?.owner).toMatchObject({ nonce: 'owner', leaseGeneration: 1 });
}

describe('owner-fenced SessionEnd writes under revision drift', () => {
  it('renewSessionEndLease survives an unrelated write between its revision read and its lock', () => {
    const sessionId = 'renew-drift';
    const { directory } = claimedJob(sessionId);
    manifestReads.afterRead = () => unrelatedWrite(directory, sessionId);

    const renewed = manifest.renewSessionEndLease(directory, sessionId, 'owner', 1, Date.now() + 5_000);

    expect(manifestReads.afterRead).toBeUndefined();
    expect(renewed?.owner).toMatchObject({ nonce: 'owner', leaseGeneration: 2 });
  });

  it('updateSessionEndJob survives an unrelated write between its revision read and its lock', () => {
    const sessionId = 'update-drift';
    const { directory } = claimedJob(sessionId);
    manifestReads.afterRead = () => unrelatedWrite(directory, sessionId);

    const claimed = manifest.claimSessionEndAction(directory, sessionId, 'owner', 'team-cleanup', Date.now() + 5_000);

    expect(claimed?.actions['team-cleanup']).toMatchObject({ status: 'claimed', claimantNonce: 'owner' });
    expect(claimed?.actions.callback.payload).toMatchObject({ unrelated: true });
  });

  it('releaseSessionEndJob survives an unrelated write between its revision read and its lock', () => {
    const sessionId = 'release-drift';
    const { directory } = claimedJob(sessionId);
    manifestReads.afterRead = () => unrelatedWrite(directory, sessionId);

    const released = manifest.releaseSessionEndJob(directory, sessionId, 'owner', 1, 'run-deadline-reached');

    expect(released).toMatchObject({ owner: null, phase: 'recoverable-failure', recoverableFailure: { reason: 'run-deadline-reached' } });
  });

  it('does not retry when the owner fence itself rejects the write', () => {
    const sessionId = 'fence-conflict';
    const { directory, claimed } = claimedJob(sessionId);
    manifestReads.count = 0;

    expect(manifest.renewSessionEndLease(directory, sessionId, 'owner', 99, Date.now() + 5_000)).toBeNull();
    expect(manifest.releaseSessionEndJob(directory, sessionId, 'other-owner', 1)).toBeNull();

    // One unlocked read plus one locked read per call: a fence conflict is final.
    expect(manifestReads.count).toBe(4);
    expect(manifest.readSessionEndJob(directory, sessionId)).toMatchObject({ revision: claimed.revision, owner: { nonce: 'owner', leaseGeneration: 1 } });
  });

  it('does not retry when the manifest lock times out', () => {
    const sessionId = 'lock-timeout';
    const { directory } = claimedJob(sessionId);
    // A live holder (this process) keeps the lock unreclaimable for the whole call.
    writeFileSync(`${manifest.sessionEndJobPath(directory, sessionId)}.lock`, JSON.stringify({ pid: process.pid, processStartIdentity: null, nonce: 'holder', createdAt: new Date().toISOString() }));
    manifestReads.count = 0;

    expect(manifest.renewSessionEndLease(directory, sessionId, 'owner', 1, Date.now() + 5_000)).toBeNull();

    // One unlocked read, then a lock timeout: the timeout is final, not drift.
    expect(manifestReads.count).toBe(1);
  }, 20_000);
});
