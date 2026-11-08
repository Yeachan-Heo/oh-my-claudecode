/**
 * Regression tests for issue #2542
 *
 * The ralph stop-hook continuation message was echoing the full task prompt on
 * every stop event.  The fix applies truncatePromptForEcho so the echoed text
 * is capped regardless of how long the original task description is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { checkPersistentModes } from '../index.js';
import { DEFAULT_PROMPT_ECHO_MAX_CHARS } from '../../../lib/truncate-prompt.js';

function writeRalphState(
  tempDir: string,
  sessionId: string,
  prompt: string,
): void {
  const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'ralph-state.json'),
    JSON.stringify({
      active: true,
      iteration: 1,
      max_iterations: 100,
      started_at: new Date().toISOString(),
      prompt,
      session_id: sessionId,
      project_path: tempDir,
    }),
  );
}

describe('Ralph stop-hook continuation — prompt truncation (issue #2542)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralph-truncation-test-'));
    execSync('git init', { cwd: tempDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('short prompt is echoed verbatim in the continuation message', async () => {
    const sessionId = 'ralph-short-prompt';
    const short = 'Fix the login bug';
    writeRalphState(tempDir, sessionId, short);

    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.shouldBlock).toBe(true);
    expect(result.mode).toBe('ralph');
    expect(result.message).toContain(short);
  });

  it('long prompt is truncated in the continuation message', async () => {
    const sessionId = 'ralph-long-prompt';
    const long =
      'Fix issue #2542 in /home/user/project. Stop-hook feedback for ' +
      'ralph/ultrawork is reinjecting full task prompts and wasting context. ' +
      'Add a shared truncation helper so stop-hook task echoes are capped to ' +
      'a compact length, preserve enough task identity to stay useful, add ' +
      'regression tests for long prompts in the affected modes, run focused ' +
      'tests, commit, push, and open a PR against dev.';
    writeRalphState(tempDir, sessionId, long);

    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.shouldBlock).toBe(true);
    expect(result.mode).toBe('ralph');

    // The full prompt must NOT appear verbatim in the injected message
    expect(result.message).not.toContain(long);

    // The echoed portion should end with an ellipsis character
    expect(result.message).toContain('…');

    // Extract the echoed task line and verify its length is capped
    const match = result.message.match(/Original task: (.+)/);
    expect(match).not.toBeNull();
    const echoed = match![1];
    expect([...echoed].length).toBeLessThanOrEqual(DEFAULT_PROMPT_ECHO_MAX_CHARS + 1);
  });

  it('echoed task still starts with the beginning of the original prompt', async () => {
    const sessionId = 'ralph-identity-check';
    const long = 'Implement OAuth2 flow. ' + 'Details: '.repeat(50);
    writeRalphState(tempDir, sessionId, long);

    const result = await checkPersistentModes(sessionId, tempDir);
    expect(result.message).toContain('Implement OAuth2 flow.');
  });
});
