/**
 * Regression test for the Ralph iteration counter stuck-at-1 bug.
 *
 * Symptom: HUD shows `ralph:1/100` permanently for the entire duration of
 * a long Ralph session, even though the Stop hook fires many times. The
 * iteration counter never increments past 1.
 *
 * Root cause: `checkRalphLoop` and `checkUltrawork` in
 * `src/hooks/persistent-mode/index.ts` re-applied a strict session-id
 * check on top of the lenient check already done by `readRalphState` /
 * `readUltraworkState`. The strict check `state.session_id !== sessionId`
 * rejected the legitimate case where ONE side is undefined and the other
 * is a UUID, causing the entire ralph/ultrawork loop to bail out before
 * `incrementRalphIteration()` could fire.
 *
 * Two scenarios that trigger the bug:
 *   - Ralph state file written with `session_id: undefined`, Stop hook
 *     fires with a UUID extracted from the transcript path.
 *   - Ralph state file written with a UUID, Stop hook fires with
 *     `sessionId: undefined` (transcript path lookup failed).
 *
 * Either scenario silently breaks Ralph for the entire session.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function createGitProject(): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'ralph-session-mismatch-'));
  tempDirs.push(tempDir);
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
  return tempDir;
}

function writeRalphStateFile(
  tempDir: string,
  sessionId: string | undefined,
  storedSessionId: string | undefined,
  iteration = 1,
): void {
  // Write to the legacy unscoped path when sessionId is undefined,
  // session-scoped path when defined.
  const stateDir = sessionId
    ? join(tempDir, '.omc', 'state', 'sessions', sessionId)
    : join(tempDir, '.omc', 'state');
  mkdirSync(stateDir, { recursive: true });

  const state: Record<string, unknown> = {
    active: true,
    iteration,
    max_iterations: 100,
    started_at: new Date().toISOString(),
    prompt: 'Long-running ralph session',
    project_path: tempDir,
  };
  if (storedSessionId !== undefined) {
    state.session_id = storedSessionId;
  }

  writeFileSync(join(stateDir, 'ralph-state.json'), JSON.stringify(state, null, 2));
}

describe('persistent-mode ralph session-id mismatch (stuck counter regression)', () => {
  it('increments the counter when state file has no session_id but Stop hook supplies one', async () => {
    const tempDir = createGitProject();
    const sessionId = 'fresh-session-uuid-1';

    // Simulate the bug: state file written without a session_id (e.g. ralph
    // started before the session_id was known, or an older state schema).
    // Place it at the SESSION-SCOPED path so readRalphState finds it.
    const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'ralph-state.json'),
      JSON.stringify({
        active: true,
        iteration: 5,
        max_iterations: 100,
        started_at: new Date().toISOString(),
        prompt: 'Test prompt',
        project_path: tempDir,
        // No session_id field
      }),
    );

    const result = await checkPersistentModes(sessionId, tempDir);

    expect(result.mode).toBe('ralph');
    expect(result.shouldBlock).toBe(true);

    const updated = JSON.parse(
      readFileSync(join(stateDir, 'ralph-state.json'), 'utf-8'),
    ) as { iteration: number };
    expect(updated.iteration).toBe(6);
  });

  it('still rejects state files that explicitly belong to a different session', async () => {
    const tempDir = createGitProject();
    const sessionA = 'session-a';
    const sessionB = 'session-b';

    // Write state under session A's directory with session A's id
    writeRalphStateFile(tempDir, sessionA, sessionA, 5);

    // Now invoke as session B — should not pick up session A's state
    const result = await checkPersistentModes(sessionB, tempDir);
    expect(result.mode).not.toBe('ralph');

    // Session A's state should be unchanged
    const stateFile = join(tempDir, '.omc', 'state', 'sessions', sessionA, 'ralph-state.json');
    const unchanged = JSON.parse(readFileSync(stateFile, 'utf-8')) as { iteration: number };
    expect(unchanged.iteration).toBe(5);
  });

  it('correctly increments when both stored and incoming session_ids match', async () => {
    // Sanity check: the existing happy path still works after the fix.
    const tempDir = createGitProject();
    const sessionId = 'session-happy-path';

    writeRalphStateFile(tempDir, sessionId, sessionId, 3);

    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.mode).toBe('ralph');

    const stateFile = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');
    const updated = JSON.parse(readFileSync(stateFile, 'utf-8')) as { iteration: number };
    expect(updated.iteration).toBe(4);
  });
});
