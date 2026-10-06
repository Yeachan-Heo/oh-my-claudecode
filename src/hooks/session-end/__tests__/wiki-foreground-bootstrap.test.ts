/**
 * The wiki SessionEnd producer runs inside run.cjs's fixed 300ms foreground
 * budget and is terminated (fail-open) when it overruns. The durable guarantee
 * is ordering: the capture intent is sealed before the worker module is
 * loaded, so a termination during the worker import/spawn cannot lose it — a
 * later worker pass still commits the session-log page.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

const observed = vi.hoisted(() => ({
  target: null as { directory: string; sessionId: string } | null,
  wikiAtWorkerLoad: undefined as unknown,
  spawnSessionEndWorker: vi.fn((_payload: { directory: string; sessionId: string }) => true),
}));

vi.mock('../worker.js', async () => {
  const actual = await vi.importActual<typeof import('../worker.js')>('../worker.js');
  const { readSessionEndJob } = await vi.importActual<typeof import('../cleanup-manifest.js')>('../cleanup-manifest.js');
  // Runs when the bootstrap first loads the worker module.
  observed.wikiAtWorkerLoad = observed.target
    ? readSessionEndJob(observed.target.directory, observed.target.sessionId)?.producers.wiki ?? null
    : null;
  return { ...actual, spawnSessionEndWorker: observed.spawnSessionEndWorker };
});
vi.mock('../../../platform/process-utils.js', () => ({
  getProcessStartIdentity: vi.fn(async () => 'test-process-start'),
  isProcessIdentityLive: vi.fn(async () => 'dead' as const),
}));
vi.mock('../action-runner.js', () => ({
  runSessionEndAction: vi.fn(async (_context: unknown, execute: () => Promise<void>) => {
    await execute();
    return { code: 'completed', completed: true };
  }),
}));

// No static import of '../worker.js' here: that would load the module before
// the bootstrap runs and defeat the ordering check.
import { publishWikiSessionEndBootstrap } from '../wiki-foreground-bootstrap.js';
import { mutateSessionEndJob, readSessionEndJob } from '../cleanup-manifest.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
  observed.spawnSessionEndWorker.mockClear();
});

function wikiProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-wiki-foreground-bootstrap-'));
  tempRoots.push(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
  mkdirSync(join(dir, '.omc', 'wiki'), { recursive: true });
  writeFileSync(join(dir, '.omc', '.omc-config.json'), JSON.stringify({ wiki: { autoCapture: true } }));
  return dir;
}

describe('publishWikiSessionEndBootstrap', () => {
  it('seals the wiki capture intent before the worker module is loaded', async () => {
    const dir = wikiProject();
    observed.target = { directory: dir, sessionId: 'wiki-order' };

    const result = await publishWikiSessionEndBootstrap({ session_id: 'wiki-order', cwd: dir });

    expect(result).toEqual({ continue: true });
    expect(observed.wikiAtWorkerLoad).toMatchObject({ state: 'sealed', sealedBy: 'wiki-producer' });
    expect(readSessionEndJob(dir, 'wiki-order')?.actions['wiki-capture'].payload)
      .toMatchObject({ kind: 'wiki-session-end-capture', sessionId: 'wiki-order' });
    expect(observed.spawnSessionEndWorker).toHaveBeenCalledWith({ directory: expect.any(String), sessionId: 'wiki-order' });
  });

  it('keeps the sealed intent when the hook is cut off before spawning, and a later worker pass writes the page', async () => {
    const dir = wikiProject();
    const sessionId = 'wiki-cut-off';
    // Stand-in for run.cjs terminating the hook between the seal and the spawn.
    observed.spawnSessionEndWorker.mockImplementationOnce(() => { throw new Error('terminated by foreground budget'); });

    await expect(publishWikiSessionEndBootstrap({ session_id: sessionId, cwd: dir })).rejects.toThrow('terminated by foreground budget');

    const sealed = readSessionEndJob(dir, sessionId)!;
    expect(sealed.producers.wiki).toMatchObject({ state: 'sealed', sealedBy: 'wiki-producer' });
    const filename = sealed.actions['wiki-capture'].payload.filename as string;
    expect(existsSync(join(dir, '.omc', 'wiki', filename))).toBe(false);

    // No worker was spawned; the next recovery pass (e.g. SessionStart reconcile) runs after producer grace.
    expect(mutateSessionEndJob(dir, sessionId, sealed.revision, (job) => {
      job.producerGraceExpiresAt = new Date(Date.now() - 1).toISOString();
    })).not.toBeNull();
    const { processSessionEndWorker } = await import('../worker.js');
    await processSessionEndWorker({ directory: dir, sessionId });

    expect(readSessionEndJob(dir, sessionId)?.actions['wiki-capture'].status).toBe('completed');
    expect(existsSync(join(dir, '.omc', 'wiki', filename))).toBe(true);
  });
});
