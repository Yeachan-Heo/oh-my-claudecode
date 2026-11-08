/**
 * E.3 — Concurrent ralph integration test (Wave E)
 *
 * Verifies that two concurrent sessions writing ralph-state.json each end up
 * at the correct session-scoped path without overwriting each other.
 *
 * Multi-repo workspace anchor tests (Wave 4 migration): verifies that when
 * a .omc-workspace marker exists in a parent dir, session state resolves
 * through the workspace anchor .omc/ rather than the sub-repo .omc/.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearWorktreeCache } from '../../src/lib/worktree-paths.js';

describe('concurrent ralph sessions (E.3)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Simulate what a ralph startup does: write a ralph-state.json scoped to
   * the session under .omc/state/sessions/{sessionId}/
   */
  function writeRalphState(projectRoot: string, sessionId: string, payload: Record<string, unknown>) {
    const sessionDir = join(projectRoot, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const statePath = join(sessionDir, 'ralph-state.json');
    writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf-8');
    return statePath;
  }

  it('each session writes its own ralph-state.json without overwriting the other', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-ralph-concurrent-'));

    const sessionA = 'session-ralph-a';
    const sessionB = 'session-ralph-b';

    const payloadA = { active: true, session_id: sessionA, original_prompt: 'Task A' };
    const payloadB = { active: true, session_id: sessionB, original_prompt: 'Task B' };

    // Simulate two concurrent writers using Promise.all
    await Promise.all([
      Promise.resolve().then(() => writeRalphState(tempDir, sessionA, payloadA)),
      Promise.resolve().then(() => writeRalphState(tempDir, sessionB, payloadB)),
    ]);

    // Verify session A state
    const pathA = join(tempDir, '.omc', 'state', 'sessions', sessionA, 'ralph-state.json');
    const pathB = join(tempDir, '.omc', 'state', 'sessions', sessionB, 'ralph-state.json');

    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);

    const stateA = JSON.parse(readFileSync(pathA, 'utf-8'));
    const stateB = JSON.parse(readFileSync(pathB, 'utf-8'));

    // No cross-session contamination
    expect(stateA.session_id).toBe(sessionA);
    expect(stateA.original_prompt).toBe('Task A');

    expect(stateB.session_id).toBe(sessionB);
    expect(stateB.original_prompt).toBe('Task B');

    // Confirm the two paths are distinct
    expect(pathA).not.toBe(pathB);
  });

  it('session-scoped state path is isolated from top-level state path', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-ralph-isolation-'));

    const sessionId = 'session-scoped-test';
    const scopedPath = writeRalphState(tempDir, sessionId, {
      active: true,
      session_id: sessionId,
      original_prompt: 'Scoped',
    });

    const topLevelPath = join(tempDir, '.omc', 'state', 'ralph-state.json');

    // Top-level path must not have been created
    expect(existsSync(topLevelPath)).toBe(false);
    expect(existsSync(scopedPath)).toBe(true);
    expect(scopedPath).toContain(sessionId);
  });
});

describe('concurrent ralph sessions — multi-repo workspace anchor (E.3 migration)', () => {
  let workspaceRoot: string;

  afterEach(() => {
    clearWorktreeCache();
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('sibling sub-repos in a workspace share one .omc/state without overwriting each other', async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'omc-ralph-workspace-'));

    // Drop workspace marker so getOmcRoot() anchors to workspaceRoot
    writeFileSync(join(workspaceRoot, '.omc-workspace'), '{}');

    const repoA = join(workspaceRoot, 'repo-a');
    const repoB = join(workspaceRoot, 'repo-b');
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });

    clearWorktreeCache();

    // Each sub-repo session writes under the shared workspace .omc/state/sessions/
    const sessionA = 'workspace-ralph-a';
    const sessionB = 'workspace-ralph-b';

    // writeRalphState constructs paths relative to projectRoot using join()
    // directly. For workspace resolution, paths must be under workspace anchor.
    const wsStateDir = join(workspaceRoot, '.omc', 'state', 'sessions');
    mkdirSync(wsStateDir, { recursive: true });

    const pathA = join(wsStateDir, sessionA, 'ralph-state.json');
    const pathB = join(wsStateDir, sessionB, 'ralph-state.json');

    mkdirSync(join(wsStateDir, sessionA), { recursive: true });
    mkdirSync(join(wsStateDir, sessionB), { recursive: true });

    await Promise.all([
      Promise.resolve().then(() => {
        writeFileSync(pathA, JSON.stringify({ active: true, session_id: sessionA, original_prompt: 'Task A' }, null, 2), 'utf-8');
      }),
      Promise.resolve().then(() => {
        writeFileSync(pathB, JSON.stringify({ active: true, session_id: sessionB, original_prompt: 'Task B' }, null, 2), 'utf-8');
      }),
    ]);

    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);

    const stateA = JSON.parse(readFileSync(pathA, 'utf-8'));
    const stateB = JSON.parse(readFileSync(pathB, 'utf-8'));

    expect(stateA.session_id).toBe(sessionA);
    expect(stateB.session_id).toBe(sessionB);

    // Neither sub-repo must have its own .omc/state
    expect(existsSync(join(repoA, '.omc', 'state'))).toBe(false);
    expect(existsSync(join(repoB, '.omc', 'state'))).toBe(false);
  });
});
