/**
 * Tests for the plugin-path SessionEnd bootstrap chain wiring (defect: plugin
 * installs register hooks/hooks.json → scripts/session-end.mjs →
 * publishSessionEndBootstrap, which is the ONLY SessionEnd entry when plugin
 * hooks are enabled — the standalone settings.json forwarder is skipped).
 * The bootstrap must therefore plan the chain enqueue and merge it into the
 * durable manifest payload exactly like processSessionEnd does.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

vi.mock('../worker.js', () => ({ spawnSessionEndWorker: vi.fn(() => true) }));

import { publishSessionEndBootstrap } from '../foreground-bootstrap.js';
import { readSessionEndJob } from '../cleanup-manifest.js';
import { factoryStateDir } from '../chain-enqueuer.js';
import { spawnSessionEndWorker } from '../worker.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-foreground-bootstrap-'));
  tempRoots.push(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
  vi.clearAllMocks();
});

function writeLedger(directory: string, sessionId: string, ledger: Record<string, unknown>): void {
  mkdirSync(factoryStateDir(directory), { recursive: true });
  writeFileSync(join(factoryStateDir(directory), `chain-${sessionId}.json`), JSON.stringify(ledger), 'utf8');
}

function bootstrapInput(directory: string, sessionId: string) {
  return {
    session_id: sessionId,
    transcript_path: '',
    cwd: directory,
    permission_mode: '',
    hook_event_name: 'SessionEnd' as const,
    reason: 'prompt_input_exit' as const,
  };
}

describe('publishSessionEndBootstrap chain wiring (plugin session-end path)', () => {
  it('merges the planned chain into the durable manifest payload when a ledger exists', async () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    mkdirSync(join(dir, '.omc'), { recursive: true });
    writeFileSync(join(dir, '.omc', 'factory-routes.json'), JSON.stringify({
      'success:*': { stage: 'review', skill: 'code-review' },
    }), 'utf8');

    const result = await publishSessionEndBootstrap(bootstrapInput(dir, 'sess-a'));

    expect(result).toEqual({ continue: true });
    const manifest = readSessionEndJob(dir, 'sess-a');
    expect(manifest).not.toBeNull();
    const chain = manifest?.actions['spawn-next']?.payload?.chain as Record<string, unknown> | undefined;
    expect(chain).toBeDefined();
    expect(chain?.outcome).toBe('success');
    expect(chain?.intentId).toBe('intent-a');
    // The detached worker must be launched so the spawn-next action executes.
    expect(spawnSessionEndWorker).toHaveBeenCalled();
  });

  it('records no chain payload when the session has no factory ledger', async () => {
    const dir = tempDir();
    await publishSessionEndBootstrap(bootstrapInput(dir, 'sess-b'));
    const manifest = readSessionEndJob(dir, 'sess-b');
    expect(manifest).not.toBeNull();
    expect(manifest?.actions['spawn-next']?.payload?.chain).toBeUndefined();
    expect(spawnSessionEndWorker).toHaveBeenCalled();
  });
});
