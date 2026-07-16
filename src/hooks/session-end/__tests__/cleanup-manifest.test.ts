import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimSessionEndAction,
  claimSessionEndJob,
  finishSessionEndAction,
  isManifestTerminal,
  markSessionEndActionRunner,
  mutateSessionEndJob,
  prepareCoreManifest,
  readSessionEndJob,
  reapStaleSessionEndOwner,
  releaseSessionEndJob,
  renewSessionEndLease,
  sealCoreManifest,
  sealWikiManifest,
  sessionEndJobsDirectory,
  takeSessionEndDiscoveryPage,
} from '../cleanup-manifest.js';

const directories: string[] = [];

function project(): string {
  const directory = mkdtempSync(join(tmpdir(), 'omc-cleanup-manifest-'));
  directories.push(directory);
  return directory;
}

function preparedAndSealed(directory: string, sessionId = 'session-a') {
  expect(prepareCoreManifest(directory, sessionId, { transcriptPath: '/tmp/transcript' })).not.toBeNull();
  expect(sealCoreManifest(directory, sessionId)).not.toBeNull();
  expect(sealWikiManifest(directory, sessionId)).not.toBeNull();
  return sessionId;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('durable SessionEnd cleanup manifest', () => {
  it('serializes concurrent core/wiki producers and rejects a second worker claim', async () => {
    const directory = project();
    const sessionId = 'concurrent-producers';

    await Promise.all([
      Promise.resolve().then(() => prepareCoreManifest(directory, sessionId, { source: 'core', callback: true })),
      Promise.resolve().then(() => sealWikiManifest(directory, sessionId, { source: 'wiki', capture: true })),
    ]);
    expect(sealCoreManifest(directory, sessionId)).not.toBeNull();

    const before = readSessionEndJob(directory, sessionId);
    expect(before?.producers.core.state).toBe('sealed');
    expect(before?.producers.wiki.state).toBe('sealed');
    expect(before?.actions.callback.payload).toMatchObject({ source: 'core', callback: true });
    expect(before?.actions['wiki-capture'].payload).toMatchObject({ source: 'wiki', capture: true });

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => claimSessionEndJob(directory, sessionId, 'worker-one', 'identity-one', Date.now() + 5_000)),
      Promise.resolve().then(() => claimSessionEndJob(directory, sessionId, 'worker-two', 'identity-two', Date.now() + 5_000)),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(readSessionEndJob(directory, sessionId)?.owner?.nonce).toBe(first?.owner?.nonce ?? second?.owner?.nonce);
  });

  it('uses expected-revision CAS rather than accepting a stale mutation', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'revision-cas');
    const initial = readSessionEndJob(directory, sessionId);
    expect(initial).not.toBeNull();

    const current = mutateSessionEndJob(directory, sessionId, initial!.revision, (job) => {
      job.phase = 'recoverable-failure';
    });
    const stale = mutateSessionEndJob(directory, sessionId, initial!.revision, (job) => {
      job.phase = 'complete';
    });

    expect(current?.revision).toBe(initial!.revision + 1);
    expect(stale).toBeNull();
    expect(readSessionEndJob(directory, sessionId)?.phase).toBe('recoverable-failure');
  });

  it('renews leases and reaps only expired, positively dead or PID-reused owners', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'leases');
    const claimed = claimSessionEndJob(directory, sessionId, 'owner', 'old-start', Date.now() + 5_000);
    expect(claimed?.owner).toMatchObject({ nonce: 'owner', leaseGeneration: 1 });
    const renewed = renewSessionEndLease(directory, sessionId, 'owner', 1, Date.now() + 5_000);
    expect(renewed?.owner?.leaseGeneration).toBe(2);

    // A live owner is never a legal reap result, even after its lease is expired.
    const path = join(sessionEndJobsDirectory(directory), `${sessionId}.json`);
    const expired = JSON.parse(readFileSync(path, 'utf8')) as { owner: { leaseExpiresAt: string } };
    expired.owner.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    writeFileSync(path, JSON.stringify(expired));
    const reap = reapStaleSessionEndOwner as unknown as (
      directory: string, sessionId: string, nonce: string, generation: number, liveness: string,
    ) => unknown;
    expect(reap(directory, sessionId, 'owner', 2, 'live')).toBeNull();
    expect(reapStaleSessionEndOwner(directory, sessionId, 'owner', 2, 'dead')?.owner).toBeNull();

    const again = claimSessionEndJob(directory, sessionId, 'reused-owner', 'reused-start', Date.now() + 5_000);
    const expiresAgain = JSON.parse(readFileSync(path, 'utf8')) as { owner: { leaseExpiresAt: string } };
    expiresAgain.owner.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    writeFileSync(path, JSON.stringify(expiresAgain));
    expect(again?.owner).toBeTruthy();
    expect(reapStaleSessionEndOwner(directory, sessionId, 'reused-owner', 1, 'mismatch')?.owner).toBeNull();
  });

  it('persists action claim, runner arm, result, and terminality separately from discovery tickets', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'action-transitions');
    const owner = claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000)!;
    const claimed = claimSessionEndAction(directory, sessionId, 'owner', 'team-cleanup', Date.now() + 5_000)!;
    const runner = claimed.actions['team-cleanup'].runner!;
    expect(claimed.actions['team-cleanup']).toMatchObject({ status: 'claimed', attempts: 1, runner: { phase: 'reserved' } });
    expect(markSessionEndActionRunner(directory, sessionId, 'owner', 'team-cleanup', runner.runnerNonce, 'started')).not.toBeNull();
    expect(markSessionEndActionRunner(directory, sessionId, 'owner', 'team-cleanup', runner.runnerNonce, 'armed')).not.toBeNull();
    expect(finishSessionEndAction(directory, sessionId, 'owner', 'team-cleanup', runner.runnerNonce, true, 'completed')).not.toBeNull();

    let current = readSessionEndJob(directory, sessionId)!;
    for (const [name] of Object.entries(current.actions)) {
      if (name === 'team-cleanup') continue;
      current = mutateSessionEndJob(directory, sessionId, current.revision, (job) => {
        job.actions[name as keyof typeof job.actions].status = 'completed';
        job.actions[name as keyof typeof job.actions].runner = { attempt: 1, runnerNonce: `${name}-runner`, phase: 'terminal', deadlineAt: new Date().toISOString() };
      })!;
    }
    const released = releaseSessionEndJob(directory, sessionId, 'owner', owner.owner!.leaseGeneration);
    expect(released).not.toBeNull();
    const terminal = readSessionEndJob(directory, sessionId)!;
    expect(isManifestTerminal(terminal)).toBe(true);
    expect(terminal.phase).toBe('complete');

    // A stale ticket cannot make a terminal manifest non-terminal or runnable again.
    writeFileSync(join(sessionEndJobsDirectory(directory), 'discovery.json'), JSON.stringify({
      version: 2,
      cursor: 0,
      tickets: [{ sessionId, attempts: 0, retryAt: new Date(0).toISOString() }],
    }));
    expect(takeSessionEndDiscoveryPage(directory, 1)).toEqual([]);
    expect(isManifestTerminal(readSessionEndJob(directory, sessionId)!)).toBe(true);
  });

  it('keeps more than sixteen queued jobs discoverable through bounded rotating pages', () => {
    const directory = project();
    const sessionIds = Array.from({ length: 21 }, (_, index) => `queued-${index}`);
    for (const sessionId of sessionIds) {
      expect(prepareCoreManifest(directory, sessionId, { sequence: sessionId })).not.toBeNull();
      expect(sealCoreManifest(directory, sessionId)).not.toBeNull();
    }

    const discovered = new Set<string>();
    for (let page = 0; page < 6; page++) for (const sessionId of takeSessionEndDiscoveryPage(directory, 4)) discovered.add(sessionId);
    expect(discovered).toEqual(new Set(sessionIds));
  });

  it('leaves every simulated crash boundary recoverable instead of silently completing work', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'crash-boundaries');
    const owner = claimSessionEndJob(directory, sessionId, 'crashed-owner', 'identity', Date.now() + 5_000)!;
    const action = claimSessionEndAction(directory, sessionId, 'crashed-owner', 'python-cleanup', Date.now() + 5_000)!;
    const runner = action.actions['python-cleanup'].runner!;

    // These snapshots model crashes before/after claim, arm, result, release, completion, and ticket retirement.
    expect(readSessionEndJob(directory, sessionId)?.actions['python-cleanup'].runner?.phase).toBe('reserved');
    expect(markSessionEndActionRunner(directory, sessionId, 'crashed-owner', 'python-cleanup', runner.runnerNonce, 'armed')).not.toBeNull();
    expect(finishSessionEndAction(directory, sessionId, 'crashed-owner', 'python-cleanup', runner.runnerNonce, false, 'simulated-crash')).not.toBeNull();
    expect(readSessionEndJob(directory, sessionId)?.actions['python-cleanup']).toMatchObject({ status: 'retryable', lastOutcomeCode: 'simulated-crash', runner: { phase: 'terminal' } });
    expect(releaseSessionEndJob(directory, sessionId, 'crashed-owner', owner.owner!.leaseGeneration)).not.toBeNull();
    expect(readSessionEndJob(directory, sessionId)).toMatchObject({ owner: null, phase: 'recoverable-failure' });
    expect(takeSessionEndDiscoveryPage(directory, 1)).toEqual([sessionId]);
  });

  it('bounds required failures and never retries a failed remote delivery attempt', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'bounded-failures');
    let owner = claimSessionEndJob(directory, sessionId, 'owner-1', 'identity', Date.now() + 5_000)!;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = claimSessionEndAction(directory, sessionId, owner.owner!.nonce, 'team-cleanup', Date.now() + 5_000)!;
      const runner = claimed.actions['team-cleanup'].runner!;
      expect(finishSessionEndAction(directory, sessionId, owner.owner!.nonce, 'team-cleanup', runner.runnerNonce, false, `failure-${attempt}`)).not.toBeNull();
      expect(releaseSessionEndJob(directory, sessionId, owner.owner!.nonce, owner.owner!.leaseGeneration)).not.toBeNull();
      owner = claimSessionEndJob(directory, sessionId, `owner-${attempt + 1}`, 'identity', Date.now() + 5_000)!;
    }
    expect(claimSessionEndAction(directory, sessionId, owner.owner!.nonce, 'team-cleanup', Date.now() + 5_000)?.actions['team-cleanup']).toMatchObject({
      status: 'expired', attempts: 3, lastOutcomeCode: 'required-attempt-limit',
    });

    for (const name of ['callback', 'notification', 'openclaw'] as const) {
      const claimed = claimSessionEndAction(directory, sessionId, owner.owner!.nonce, name, Date.now() + 5_000)!;
      const runner = claimed.actions[name].runner!;
      expect(finishSessionEndAction(directory, sessionId, owner.owner!.nonce, name, runner.runnerNonce, false, 'response-lost')).not.toBeNull();
      expect(readSessionEndJob(directory, sessionId)?.actions[name]).toMatchObject({ status: 'expired', attempts: 1, lastOutcomeCode: 'response-lost' });
      expect(claimSessionEndAction(directory, sessionId, owner.owner!.nonce, name, Date.now() + 5_000)).toBeNull();
    }
  });

  it('does not requeue a best-effort action after its owner dies with delivery uncertain', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'reaped-delivery');
    const owner = claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000)!;
    expect(claimSessionEndAction(directory, sessionId, 'owner', 'callback', Date.now() - 1)).not.toBeNull();
    const manifestPath = join(sessionEndJobsDirectory(directory), `${sessionId}.json`);
    const expired = JSON.parse(readFileSync(manifestPath, 'utf8')) as { owner: { leaseExpiresAt: string } };
    expired.owner.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    writeFileSync(manifestPath, JSON.stringify(expired));

    expect(reapStaleSessionEndOwner(directory, sessionId, 'owner', owner.owner!.leaseGeneration, 'dead')?.actions.callback).toMatchObject({
      status: 'expired', lastOutcomeCode: 'delivery-uncertain-owner-reaped', runner: { phase: 'terminal' },
    });
    const replacement = claimSessionEndJob(directory, sessionId, 'replacement', 'identity', Date.now() + 5_000)!;
    expect(claimSessionEndAction(directory, sessionId, replacement.owner!.nonce, 'callback', Date.now() + 5_000)).toBeNull();
  });
});
