import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';
import type { StopContext } from '../../todo-continuation/index.js';

// Active-mode worktree so a Stop would normally block (and could loop). We use
// Ralph because it is the simplest always-reinforcing persistent mode.
function makeRalphWorktree(sessionId: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'thinking-only-streak-'));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
  const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'ralph-state.json'),
    JSON.stringify(
      {
        active: true,
        iteration: 1,
        max_iterations: 10,
        started_at: new Date().toISOString(),
        prompt: 'Finish the task',
        session_id: sessionId,
        project_path: tempDir,
        linked_ultrawork: false,
      },
      null,
      2,
    ),
  );
  return tempDir;
}

type ContentBlock = { type: string; [key: string]: unknown };

function writeAssistantTurn(transcriptPath: string, content: ContentBlock[] | string): void {
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the task' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } }),
    ].join('\n') + '\n',
  );
}

type TranscriptRecord = { type: string; message: { role: string; content: unknown } };

const userRecord = (content: unknown): TranscriptRecord => ({
  type: 'user',
  message: { role: 'user', content },
});
const assistantRecord = (content: unknown): TranscriptRecord => ({
  type: 'assistant',
  message: { role: 'assistant', content },
});

// Write an explicit list of transcript records (one JSON object per line) so a
// test can model a multi-record assistant turn (e.g. tool_use, tool_result, then
// trailing text) instead of the single-record turn writeAssistantTurn emits.
function writeRecords(transcriptPath: string, records: TranscriptRecord[]): void {
  writeFileSync(
    transcriptPath,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
}

const THINKING_ONLY: ContentBlock[] = [
  { type: 'thinking', thinking: 'Let me reason about this some more before acting.' },
];
const TOOL_USE: ContentBlock[] = [
  { type: 'thinking', thinking: 'Now I will run a command.' },
  { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
];

function ctx(transcriptPath?: string): StopContext {
  return { stop_reason: 'end_turn', ...(transcriptPath ? { transcript_path: transcriptPath } : {}) };
}

describe('thinking-only streak guard (issue #3280)', () => {
  it('increments the streak and bails out after 3 consecutive thinking-only turns', async () => {
    const sessionId = 'streak-bailout';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeAssistantTurn(transcriptPath, THINKING_ONLY);

    try {
      const first = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(first.shouldBlock).toBe(true);
      expect(first.mode).toBe('ralph');

      const second = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(second.shouldBlock).toBe(true);
      expect(second.mode).toBe('ralph');

      const third = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(third.shouldBlock).toBe(false);
      expect(third.mode).toBe('none');
      expect(third.message).toContain('NO TOOL PROGRESS');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('counts redacted_thinking turns toward the streak', async () => {
    const sessionId = 'streak-redacted';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeAssistantTurn(transcriptPath, [{ type: 'redacted_thinking', data: 'opaque' }]);

    try {
      await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      const third = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(third.shouldBlock).toBe(false);
      expect(third.mode).toBe('none');
      expect(third.message).toContain('NO TOOL PROGRESS');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resets the streak when a turn includes tool_use', async () => {
    const sessionId = 'streak-reset-tooluse';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'transcript.jsonl');

    try {
      // Two thinking-only turns: streak climbs to 2.
      writeAssistantTurn(transcriptPath, THINKING_ONLY);
      await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));

      // A tool_use turn resets the streak and keeps enforcing.
      writeAssistantTurn(transcriptPath, TOOL_USE);
      const afterTool = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(afterTool.shouldBlock).toBe(true);
      expect(afterTool.mode).toBe('ralph');

      // Two more thinking-only turns would have bailed without the reset, but
      // the streak restarts from zero, so both still block.
      writeAssistantTurn(transcriptPath, THINKING_ONLY);
      const t1 = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(t1.shouldBlock).toBe(true);
      expect(t1.mode).toBe('ralph');

      const t2 = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(t2.shouldBlock).toBe(true);
      expect(t2.mode).toBe('ralph');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resets the streak when a productive turn ends in trailing text after tool_use', async () => {
    const sessionId = 'streak-reset-trailing-text';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'transcript.jsonl');

    try {
      // Two thinking-only turns: streak climbs to 2.
      writeAssistantTurn(transcriptPath, THINKING_ONLY);
      await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));

      // A productive turn whose FINAL assistant record is plain text: the
      // tool_use lives in an earlier record, with its tool_result in between.
      // The whole-turn classifier must still see the progress and reset.
      writeRecords(transcriptPath, [
        userRecord('do the task'),
        assistantRecord([
          { type: 'thinking', thinking: 'I will run a command.' },
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
        ]),
        userRecord([{ type: 'tool_result', tool_use_id: 'tu-1', content: 'a\nb' }]),
        assistantRecord([{ type: 'text', text: 'Done — listed the directory.' }]),
      ]);
      const afterTool = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(afterTool.shouldBlock).toBe(true);
      expect(afterTool.mode).toBe('ralph');

      // Streak restarted from zero, so two more thinking-only turns still block
      // rather than bailing out on the second one.
      writeAssistantTurn(transcriptPath, THINKING_ONLY);
      const t1 = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(t1.shouldBlock).toBe(true);
      expect(t1.mode).toBe('ralph');

      const t2 = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(t2.shouldBlock).toBe(true);
      expect(t2.mode).toBe('ralph');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('classifies only the most recent turn (a prior turn\'s tool_use never leaks across the user boundary)', async () => {
    const sessionId = 'streak-turn-boundary';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'transcript.jsonl');

    try {
      // A completed productive turn, then a fresh continuation prompt that
      // begins the most-recent (thinking-only) turn. Classification must stop at
      // the continuation boundary and not reach back into the productive turn.
      writeRecords(transcriptPath, [
        userRecord('do the task'),
        assistantRecord([
          { type: 'thinking', thinking: 'running a tool' },
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
        ]),
        userRecord([{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }]),
        assistantRecord([{ type: 'text', text: 'finished the productive turn' }]),
        userRecord('continue'),
        assistantRecord(THINKING_ONLY),
      ]);

      // Same transcript each call: only the trailing thinking-only turn counts,
      // so the streak climbs and bails on the third stop.
      const first = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(first.shouldBlock).toBe(true);
      const second = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(second.shouldBlock).toBe(true);
      const third = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(third.shouldBlock).toBe(false);
      expect(third.mode).toBe('none');
      expect(third.message).toContain('NO TOOL PROGRESS');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('clears the streak after bail-out so the next thinking-only turn blocks again', async () => {
    const sessionId = 'streak-cleanup';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeAssistantTurn(transcriptPath, THINKING_ONLY);

    try {
      await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      const bail = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(bail.shouldBlock).toBe(false);

      // Streak was cleared on bail-out: the immediate next thinking-only stop
      // re-enters enforcement at streak 1 rather than bailing again.
      const afterBail = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
      expect(afterBail.shouldBlock).toBe(true);
      expect(afterBail.mode).toBe('ralph');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails open (keeps enforcing) when no transcript path is provided', async () => {
    const sessionId = 'streak-no-transcript';
    const tempDir = makeRalphWorktree(sessionId);

    try {
      for (let i = 0; i < 5; i += 1) {
        const result = await checkPersistentModes(sessionId, tempDir, ctx());
        expect(result.shouldBlock).toBe(true);
        expect(result.mode).toBe('ralph');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails open when the transcript file does not exist', async () => {
    const sessionId = 'streak-missing-file';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'does-not-exist.jsonl');

    try {
      for (let i = 0; i < 5; i += 1) {
        const result = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
        expect(result.shouldBlock).toBe(true);
        expect(result.mode).toBe('ralph');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails open on a malformed/unparseable transcript', async () => {
    const sessionId = 'streak-malformed';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeFileSync(transcriptPath, '{ this is : not valid json at all\n');

    try {
      for (let i = 0; i < 5; i += 1) {
        const result = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
        expect(result.shouldBlock).toBe(true);
        expect(result.mode).toBe('ralph');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('treats a text-only turn as indeterminate (no streak, keeps enforcing)', async () => {
    const sessionId = 'streak-text-only';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeAssistantTurn(transcriptPath, [{ type: 'text', text: 'Here is the answer.' }]);

    try {
      for (let i = 0; i < 5; i += 1) {
        const result = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
        expect(result.shouldBlock).toBe(true);
        expect(result.mode).toBe('ralph');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('treats string transcript content as indeterminate (no streak, keeps enforcing)', async () => {
    const sessionId = 'streak-string-content';
    const tempDir = makeRalphWorktree(sessionId);
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeAssistantTurn(transcriptPath, 'plain string assistant response');

    try {
      for (let i = 0; i < 5; i += 1) {
        const result = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
        expect(result.shouldBlock).toBe(true);
        expect(result.mode).toBe('ralph');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never bails out when no persistent mode is active (guard is a no-op)', async () => {
    const sessionId = 'streak-no-mode';
    const tempDir = mkdtempSync(join(tmpdir(), 'thinking-only-streak-nomode-'));
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeAssistantTurn(transcriptPath, THINKING_ONLY);

    try {
      for (let i = 0; i < 5; i += 1) {
        const result = await checkPersistentModes(sessionId, tempDir, ctx(transcriptPath));
        expect(result.shouldBlock).toBe(false);
        expect(result.mode).toBe('none');
        // Plain idle stop, not the streak bail-out message.
        expect(result.message).toBe('');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
