import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';
import { isOversizeToolResultRedirectStop, type StopContext } from '../../todo-continuation/index.js';

function makeRalphWorktree(sessionId: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'ralph-oversize-tool-result-'));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
  const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'ralph-state.json'),
    JSON.stringify({
      active: true,
      iteration: 1,
      max_iterations: 10,
      started_at: new Date().toISOString(),
      prompt: 'Finish the task',
      session_id: sessionId,
      project_path: tempDir,
      linked_ultrawork: false,
    }, null, 2)
  );
  return tempDir;
}

const redirectedToolResultMessage = [
  'Tool result was too large and has been redirected.',
  'Full output saved to tool-results/bash-20260511T095200Z.txt',
].join('\n');

describe('oversize tool-result redirect stop guard (issue #2988)', () => {
  it('classifies redirected tool-result file pointers from stop context text', () => {
    expect(isOversizeToolResultRedirectStop({
      message: redirectedToolResultMessage,
    })).toBe(true);
  });

  it('classifies redirected tool-result file pointers from transcript tail', async () => {
    const sessionId = 'session-2988-transcript';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'messages.jsonl');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: 'assistant', message: { content: 'ordinary work' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'text',
              text: 'Response exceeded the tool result size limit; output written to tool-results/grep-output.txt',
            }],
          },
        }),
      ].join('\n')
    );

    try {
      const result = await checkPersistentModes(sessionId, tempDir, {
        stop_reason: 'end_turn',
        transcript_path: transcriptPath,
      });

      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe('none');
      expect(result.message).toBe('');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not classify stale transcript redirect markers when the latest event is ordinary', async () => {
    const sessionId = 'session-2988-stale-transcript';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'messages.jsonl');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: 'Tool result was too large; full output written to tool-results/old-output.txt',
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: 'ordinary follow-up stop without redirected output' },
        }),
      ].join('\n')
    );

    try {
      const result = await checkPersistentModes(sessionId, tempDir, {
        stop_reason: 'end_turn',
        transcript_path: transcriptPath,
      });

      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe('ralph');
      expect(result.message).toContain('<ralph-continuation>');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('suppresses visible Ralph reinforcement for an oversize tool-result redirect stop', async () => {
    const sessionId = 'session-2988-suppress';
    const tempDir = makeRalphWorktree(sessionId);

    try {
      const result = await checkPersistentModes(sessionId, tempDir, {
        stop_reason: 'end_turn',
        message: redirectedToolResultMessage,
      });

      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe('none');
      expect(result.message).toBe('');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to normal Ralph reinforcement after repeated consecutive redirects', async () => {
    const sessionId = 'session-2988-consecutive';
    const tempDir = makeRalphWorktree(sessionId);
    const stopContext: StopContext = {
      stop_reason: 'end_turn',
      message: redirectedToolResultMessage,
    };

    try {
      await checkPersistentModes(sessionId, tempDir, stopContext);
      await checkPersistentModes(sessionId, tempDir, stopContext);
      await checkPersistentModes(sessionId, tempDir, stopContext);
      const result = await checkPersistentModes(sessionId, tempDir, stopContext);

      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe('ralph');
      expect(result.message).toContain('<ralph-continuation>');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not suppress a normal active Ralph stop without redirect markers', async () => {
    const sessionId = 'session-2988-normal-stop';
    const tempDir = makeRalphWorktree(sessionId);

    try {
      const result = await checkPersistentModes(sessionId, tempDir, {
        stop_reason: 'end_turn',
        message: 'ordinary assistant stop without redirected tool output',
      });

      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe('ralph');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves context-limit bypass precedence even when redirect markers are present', async () => {
    const sessionId = 'session-2988-context-limit';
    const tempDir = makeRalphWorktree(sessionId);

    try {
      const result = await checkPersistentModes(sessionId, tempDir, {
        stop_reason: 'context_limit',
        message: redirectedToolResultMessage,
      });

      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe('none');
      expect(result.message).toBe('');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves rate-limit bypass precedence even when redirect markers are present', async () => {
    const sessionId = 'session-2988-rate-limit';
    const tempDir = makeRalphWorktree(sessionId);

    try {
      const result = await checkPersistentModes(sessionId, tempDir, {
        stop_reason: 'rate_limit',
        message: redirectedToolResultMessage,
      });

      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe('none');
      expect(result.message).toMatch(/rate.limit/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves user-abort bypass precedence even when redirect markers are present', async () => {
    const sessionId = 'session-2988-user-abort';
    const tempDir = makeRalphWorktree(sessionId);

    try {
      const result = await checkPersistentModes(sessionId, tempDir, {
        stop_reason: 'user_cancel',
        message: redirectedToolResultMessage,
      });

      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe('none');
      expect(result.message).toBe('');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
