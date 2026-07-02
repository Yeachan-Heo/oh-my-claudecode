import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';

/**
 * UltraDebug persistent-mode driver tests. Mirrors the ralph hook tests: write a
 * fake session state file (and, where completion is exercised, a fake JSONL
 * transcript), then invoke checkPersistentModes() and assert on the result.
 *
 * Contract-sensitive: the continuation header `[ULTRADEBUG - ITERATION n/max]`
 * and the promise string `ULTRADEBUG_COMPLETE` must stay byte-exact.
 */
describe('persistent-mode ultradebug driver', () => {
  function setup(sessionId: string, state: Record<string, unknown>): { tempDir: string; stateDir: string } {
    const tempDir = mkdtempSync(join(tmpdir(), 'ultradebug-'));
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
    const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'ultradebug-state.json'),
      JSON.stringify({ session_id: sessionId, project_path: tempDir, ...state }, null, 2),
    );
    return { tempDir, stateDir };
  }

  it('detects an active ultradebug session and re-injects the continuation prompt', async () => {
    const sessionId = 'ud-detect';
    const { tempDir, stateDir } = setup(sessionId, {
      active: true,
      iteration: 2,
      max_iterations: 8,
      status: 'investigating',
      started_at: new Date().toISOString(),
    });

    try {
      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe('ultradebug');
      // iteration incremented 2 -> 3
      expect(result.message).toContain('[ULTRADEBUG - ITERATION 3/8]');

      const updated = JSON.parse(readFileSync(join(stateDir, 'ultradebug-state.json'), 'utf-8')) as {
        iteration: number;
      };
      expect(updated.iteration).toBe(3);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('completes and clears state when an assistant turn prints ULTRADEBUG_COMPLETE', async () => {
    const sessionId = 'ud-complete';
    const { tempDir, stateDir } = setup(sessionId, {
      active: true,
      iteration: 3,
      max_iterations: 8,
      status: 'verifying',
      started_at: new Date().toISOString(),
    });

    // Fake transcript: an assistant turn that printed the completion promise.
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the bug' } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Repro passes, suite green. ULTRADEBUG_COMPLETE' }] },
        }),
      ].join('\n') + '\n',
    );

    try {
      const result = await checkPersistentModes(sessionId, tempDir, { transcript_path: transcriptPath });
      expect(result.shouldBlock).toBe(false);
      expect(result.message).toContain('[ULTRADEBUG COMPLETE]');
      // Genuine completion deletes the session state file.
      expect(existsSync(join(stateDir, 'ultradebug-state.json'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does NOT complete when the promise only appears in the injected (user) prompt', async () => {
    const sessionId = 'ud-nofalse';
    const { tempDir, stateDir } = setup(sessionId, {
      active: true,
      iteration: 1,
      max_iterations: 8,
      status: 'investigating',
      started_at: new Date().toISOString(),
    });

    // The continuation prompt (a user-role record) quotes the promise string.
    // Scanning it must NOT trigger completion.
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'did not output the completion promise `ULTRADEBUG_COMPLETE`' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        }),
      ].join('\n') + '\n',
    );

    try {
      const result = await checkPersistentModes(sessionId, tempDir, { transcript_path: transcriptPath });
      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe('ultradebug');
      expect(result.message).toContain('[ULTRADEBUG - ITERATION 2/8]');
      expect(existsSync(join(stateDir, 'ultradebug-state.json'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('stops at max_iterations and keeps state (active:false) for --resume', async () => {
    const sessionId = 'ud-max';
    const { tempDir, stateDir } = setup(sessionId, {
      active: true,
      iteration: 8,
      max_iterations: 8,
      status: 'investigating',
      started_at: new Date().toISOString(),
    });

    try {
      const result = await checkPersistentModes(sessionId, tempDir);
      // Unlike ralph, ultradebug stops (releases) at max_iterations.
      expect(result.shouldBlock).toBe(false);
      expect(result.message).toContain('[ULTRADEBUG - MAX ITERATIONS]');

      // State is KEPT for --resume, marked inactive.
      const statePath = join(stateDir, 'ultradebug-state.json');
      expect(existsSync(statePath)).toBe(true);
      const updated = JSON.parse(readFileSync(statePath, 'utf-8')) as { active: boolean; iteration: number };
      expect(updated.active).toBe(false);
      expect(updated.iteration).toBe(8);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does nothing when no ultradebug state exists', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ultradebug-none-'));
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
    try {
      const result = await checkPersistentModes('ud-absent', tempDir);
      expect(result.mode).not.toBe('ultradebug');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
