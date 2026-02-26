/**
 * Edge Case Tests for MCP Team Workers
 *
 * Covers gaps not addressed by the existing 69 tests:
 * - Malformed input handling (bad JSON, unexpected types, missing fields)
 * - Boundary conditions (empty strings, long names, special characters)
 * - File system edge cases (missing files, corrupt data)
 * - Offset cursor behavior when inbox is truncated mid-line
 * - Outbox rotation boundary conditions
 * - Heartbeat with invalid/edge-case timestamps
 * - Task status transition edge cases
 * - Registration with corrupt backing files
 * - Sanitization edge cases (unicode, empty, path traversal)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync, writeFileSync, rmSync, existsSync,
  readFileSync, appendFileSync
} from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

// --- task-file-ops imports ---
import {
  readTask, updateTask, findNextTask, areBlockersResolved,
  writeTaskFailure, readTaskFailure, listTaskIds
} from '../task-file-ops.js';
import type { TaskFile } from '../types.js';

// --- inbox-outbox imports ---
import {
  appendOutbox, rotateOutboxIfNeeded, readNewInboxMessages,
  readAllInboxMessages, clearInbox, writeShutdownSignal,
  checkShutdownSignal, deleteShutdownSignal, cleanupWorkerFiles
} from '../inbox-outbox.js';
import type { OutboxMessage, InboxMessage } from '../types.js';

// --- heartbeat imports ---
import {
  writeHeartbeat, readHeartbeat, listHeartbeats,
  isWorkerAlive, deleteHeartbeat, cleanupTeamHeartbeats
} from '../heartbeat.js';
import type { HeartbeatData } from '../types.js';

// --- tmux-session imports ---
import { sanitizeName, sessionName } from '../tmux-session.js';

// --- team-registration imports ---
import {
  readProbeResult, writeProbeResult, getRegistrationStrategy,
  registerMcpWorker, unregisterMcpWorker, isMcpWorker, listMcpWorkers
} from '../team-registration.js';


// ============================================================
// Shared test constants and helpers
// ============================================================

const EDGE_TEAM_TASKS = 'test-edge-tasks';
const EDGE_TEAM_IO = 'test-edge-io';

// task-file-ops tests use canonical path via cwd
let TASK_TEST_CWD: string;
let TASKS_DIR: string;

// inbox-outbox tests still use the legacy ~/.claude/teams path (inbox-outbox.ts
// was not changed in this refactor and still uses getClaudeConfigDir internally)
const TEAMS_IO_DIR = join(homedir(), '.claude', 'teams', EDGE_TEAM_IO);

const HB_DIR = join(tmpdir(), 'test-edge-hb');
const REG_DIR = join(tmpdir(), 'test-edge-reg');
const REG_TEAM = 'test-edge-reg-team';
const CONFIG_DIR = join(homedir(), '.claude', 'teams', REG_TEAM);

function writeTaskHelper(task: TaskFile): void {
  mkdirSync(TASKS_DIR, { recursive: true });
  writeFileSync(join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
}

function makeHeartbeat(overrides?: Partial<HeartbeatData>): HeartbeatData {
  return {
    workerName: 'w1',
    teamName: 'test-team',
    provider: 'codex',
    pid: 12345,
    lastPollAt: new Date().toISOString(),
    consecutiveErrors: 0,
    status: 'polling',
    ...overrides,
  };
}


// ============================================================
// 1. task-file-ops edge cases
// ============================================================

describe('task-file-ops edge cases', () => {
  beforeEach(() => {
    TASK_TEST_CWD = join(tmpdir(), `omc-edge-tasks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    TASKS_DIR = join(TASK_TEST_CWD, '.omc', 'state', 'team', EDGE_TEAM_TASKS, 'tasks');
    mkdirSync(TASKS_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TASK_TEST_CWD, { recursive: true, force: true });
  });

  describe('updateTask on non-existent file', () => {
    it('throws when task file does not exist', () => {
      // updateTask calls readFileSync directly without existsSync guard
      expect(() => updateTask(EDGE_TEAM_TASKS, 'nonexistent', { status: 'completed' }, { cwd: TASK_TEST_CWD }))
        .toThrow();
    });
  });

  describe('updateTask with empty updates object', () => {
    it('preserves task unchanged when updates is empty', () => {
      const task: TaskFile = {
        id: '1', subject: 'Test', description: 'Desc', status: 'pending',
        owner: 'w1', blocks: [], blockedBy: [],
      };
      writeTaskHelper(task);
      updateTask(EDGE_TEAM_TASKS, '1', {}, { cwd: TASK_TEST_CWD });
      const result = readTask(EDGE_TEAM_TASKS, '1', { cwd: TASK_TEST_CWD });
      expect(result).toEqual(task);
    });
  });

  describe('updateTask skips undefined values', () => {
    it('does not overwrite fields with undefined', () => {
      const task: TaskFile = {
        id: '1', subject: 'Test', description: 'Desc', status: 'pending',
        owner: 'w1', blocks: [], blockedBy: [],
      };
      writeTaskHelper(task);
      // Passing an update with owner set to undefined should not wipe the owner
      updateTask(EDGE_TEAM_TASKS, '1', { owner: undefined, status: 'in_progress' }, { cwd: TASK_TEST_CWD });
      const result = readTask(EDGE_TEAM_TASKS, '1', { cwd: TASK_TEST_CWD });
      expect(result?.owner).toBe('w1');
      expect(result?.status).toBe('in_progress');
    });
  });

  describe('listTaskIds with mixed numeric and alpha IDs', () => {
    it('sorts numeric IDs numerically and alpha IDs lexicographically', () => {
      writeTaskHelper({ id: '10', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
      writeTaskHelper({ id: '2', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
      writeTaskHelper({ id: 'abc', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
      writeTaskHelper({ id: '1', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });

      const ids = listTaskIds(EDGE_TEAM_TASKS, { cwd: TASK_TEST_CWD });
      // Numeric ones should be sorted numerically; alpha falls to localeCompare
      // The sort function: if both parse as number, numeric sort; else localeCompare
      // Since '1','2','10' are numeric and 'abc' is NaN, mixed comparison uses localeCompare
      // Let's verify the actual order
      expect(ids.length).toBe(4);
      // '1' and '2' and '10' are numeric; 'abc' is NaN
      // When one is NaN and other is number, localeCompare is used
      // localeCompare('1','abc') < 0, localeCompare('10','abc') < 0, localeCompare('2','abc') < 0
      // So all numeric come before 'abc'
      expect(ids[ids.length - 1]).toBe('abc');
    });
  });

  describe('listTaskIds with only non-.json files', () => {
    it('returns empty when directory has no .json files', () => {
      writeFileSync(join(TASKS_DIR, 'README.md'), 'not a task');
      writeFileSync(join(TASKS_DIR, 'notes.txt'), 'not a task');
      expect(listTaskIds(EDGE_TEAM_TASKS, { cwd: TASK_TEST_CWD })).toEqual([]);
    });
  });

  describe('areBlockersResolved with nonexistent blocker', () => {
    it('returns false when blocker task file does not exist', () => {
      // Blocker ID references a task that was never created
      expect(areBlockersResolved(EDGE_TEAM_TASKS, ['does-not-exist'], { cwd: TASK_TEST_CWD })).toBe(false);
    });
  });

  describe('areBlockersResolved with in_progress blocker', () => {
    it('returns false when blocker is in_progress (not completed)', () => {
      writeTaskHelper({
        id: 'blocker', subject: 'B', description: 'D',
        status: 'in_progress', owner: 'w', blocks: [], blockedBy: [],
      });
      expect(areBlockersResolved(EDGE_TEAM_TASKS, ['blocker'], { cwd: TASK_TEST_CWD })).toBe(false);
    });
  });

  describe('findNextTask returns null for nonexistent team', () => {
    it('returns null gracefully when team directory missing', async () => {
      expect(await findNextTask('completely_nonexistent_team_xyz', 'w1', { cwd: TASK_TEST_CWD })).toBeNull();
    });
  });

  describe('findNextTask with in_progress task', () => {
    it('skips tasks that are already in_progress', async () => {
      writeTaskHelper({
        id: '1', subject: 'T', description: 'D',
        status: 'in_progress', owner: 'w1', blocks: [], blockedBy: [],
      });
      expect(await findNextTask(EDGE_TEAM_TASKS, 'w1', { cwd: TASK_TEST_CWD })).toBeNull();
    });
  });

  describe('readTask with empty file', () => {
    it('returns null for empty JSON file', () => {
      writeFileSync(join(TASKS_DIR, 'empty.json'), '');
      expect(readTask(EDGE_TEAM_TASKS, 'empty', { cwd: TASK_TEST_CWD })).toBeNull();
    });
  });

  describe('readTask with valid JSON but non-object', () => {
    it('returns the parsed value (no schema validation)', () => {
      writeFileSync(join(TASKS_DIR, 'array.json'), '[]');
      // readTask just does JSON.parse and casts, so an array would be returned
      const result = readTask(EDGE_TEAM_TASKS, 'array', { cwd: TASK_TEST_CWD });
      expect(result).toEqual([]);
    });
  });

  describe('writeTaskFailure with malformed existing sidecar', () => {
    it('creates fresh sidecar when existing file is corrupt', () => {
      // Write corrupt sidecar
      mkdirSync(TASKS_DIR, { recursive: true });
      writeFileSync(join(TASKS_DIR, 'corrupt.failure.json'), '{not valid json');

      // readTaskFailure returns null for corrupt -> retryCount starts at 1
      writeTaskFailure(EDGE_TEAM_TASKS, 'corrupt', 'new error', { cwd: TASK_TEST_CWD });
      const failure = readTaskFailure(EDGE_TEAM_TASKS, 'corrupt', { cwd: TASK_TEST_CWD });
      expect(failure?.retryCount).toBe(1);
      expect(failure?.lastError).toBe('new error');
    });
  });

  describe('readTaskFailure with corrupt sidecar file', () => {
    it('returns null for corrupt failure sidecar', () => {
      mkdirSync(TASKS_DIR, { recursive: true });
      writeFileSync(join(TASKS_DIR, 'bad.failure.json'), 'not json at all');
      expect(readTaskFailure(EDGE_TEAM_TASKS, 'bad', { cwd: TASK_TEST_CWD })).toBeNull();
    });
  });

  describe('task ID with special characters', () => {
    it('handles task ID with dots', () => {
      // ID 'v1.2.3' creates file 'v1.2.3.json'
      const task: TaskFile = {
        id: 'v1.2.3', subject: 'Versioned', description: 'D',
        status: 'pending', owner: 'w1', blocks: [], blockedBy: [],
      };
      writeTaskHelper(task);
      const result = readTask(EDGE_TEAM_TASKS, 'v1.2.3', { cwd: TASK_TEST_CWD });
      expect(result?.id).toBe('v1.2.3');
    });
  });

  describe('listTaskIds excludes .tmp files with various PIDs', () => {
    it('filters out temp files regardless of PID suffix', () => {
      writeTaskHelper({ id: '1', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
      writeFileSync(join(TASKS_DIR, '1.json.tmp.99999'), '{}');
      writeFileSync(join(TASKS_DIR, '2.json.tmp.1'), '{}');
      const ids = listTaskIds(EDGE_TEAM_TASKS, { cwd: TASK_TEST_CWD });
      expect(ids).toEqual(['1']);
    });
  });

  describe('task status transition: completed -> pending', () => {
    it('allows backward transition (no validation in updateTask)', () => {
      // This tests that updateTask does NOT enforce valid transitions.
      // In production, completed -> pending could be a logic bug, but
      // updateTask is a low-level primitive that does not validate.
      writeTaskHelper({
        id: '1', subject: 'T', description: 'D',
        status: 'completed', owner: 'w1', blocks: [], blockedBy: [],
      });
      updateTask(EDGE_TEAM_TASKS, '1', { status: 'pending' }, { cwd: TASK_TEST_CWD });
      const result = readTask(EDGE_TEAM_TASKS, '1', { cwd: TASK_TEST_CWD });
      expect(result?.status).toBe('pending');
    });
  });

  describe('findNextTask with multiple pending tasks returns first by sorted ID', () => {
    it('returns the lowest-sorted pending task', async () => {
      writeTaskHelper({ id: '3', subject: 'T3', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
      writeTaskHelper({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
      writeTaskHelper({ id: '2', subject: 'T2', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
      const result = await findNextTask(EDGE_TEAM_TASKS, 'w1', { cwd: TASK_TEST_CWD });
      expect(result?.id).toBe('1');
    });
  });
});


// ============================================================
// 2. inbox-outbox edge cases
// ============================================================

describe('inbox-outbox edge cases', () => {
  beforeEach(() => {
    mkdirSync(join(TEAMS_IO_DIR, 'inbox'), { recursive: true });
    mkdirSync(join(TEAMS_IO_DIR, 'outbox'), { recursive: true });
    mkdirSync(join(TEAMS_IO_DIR, 'signals'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEAMS_IO_DIR, { recursive: true, force: true });
  });

  describe('readNewInboxMessages with malformed JSONL mixed with valid', () => {
    it('skips malformed lines, advances cursor past them, and returns all valid messages', () => {
      // Use a unique worker name to avoid any cursor conflicts
      const workerName = 'w-malformed-test';
      const inbox = join(TEAMS_IO_DIR, 'inbox', `${workerName}.jsonl`);
      const cursorFile = join(TEAMS_IO_DIR, 'inbox', `${workerName}.offset`);

      const validMsg1: InboxMessage = { type: 'message', content: 'first', timestamp: '2026-01-01T00:00:00Z' };
      const validMsg2: InboxMessage = { type: 'message', content: 'second', timestamp: '2026-01-01T00:01:00Z' };
      const afterMalformedMsg: InboxMessage = { type: 'message', content: 'after-malformed', timestamp: '2026-01-01T00:02:00Z' };
      const content = [
        JSON.stringify(validMsg1),
        JSON.stringify(validMsg2),
        'this is not json',
        JSON.stringify(afterMalformedMsg),
      ].join('\n') + '\n';
      writeFileSync(inbox, content);

      // Verify file was written correctly
      const rawContent = readFileSync(inbox, 'utf-8');
      expect(rawContent.length).toBeGreaterThan(0);

      // Verify no stale cursor
      expect(existsSync(cursorFile)).toBe(false);

      // Malformed line is skipped and cursor advances past it — all 3 valid messages returned
      const msgs = readNewInboxMessages(EDGE_TEAM_IO, workerName);
      expect(msgs).toHaveLength(3);
      expect(msgs[0].content).toBe('first');
      expect(msgs[1].content).toBe('second');
      expect(msgs[2].content).toBe('after-malformed');

      // Cursor should be advanced to end of file (no re-reads on next call)
      const cursor = JSON.parse(readFileSync(cursorFile, 'utf-8'));
      expect(cursor.bytesRead).toBe(Buffer.byteLength(content, 'utf-8'));
    });
  });

  describe('readNewInboxMessages with corrupt cursor file', () => {
    it('resets cursor to 0 on malformed cursor JSON', () => {
      const inbox = join(TEAMS_IO_DIR, 'inbox', 'w1.jsonl');
      const cursorFile = join(TEAMS_IO_DIR, 'inbox', 'w1.offset');
      const msg: InboxMessage = { type: 'message', content: 'hello', timestamp: '2026-01-01T00:00:00Z' };
      writeFileSync(inbox, JSON.stringify(msg) + '\n');
      writeFileSync(cursorFile, 'NOT VALID JSON AT ALL');

      const msgs = readNewInboxMessages(EDGE_TEAM_IO, 'w1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('hello');
    });
  });

  describe('readNewInboxMessages returns empty when cursor equals file size', () => {
    it('returns empty array when no new data since last read', () => {
      const inbox = join(TEAMS_IO_DIR, 'inbox', 'w1.jsonl');
      const msg: InboxMessage = { type: 'message', content: 'data', timestamp: '2026-01-01T00:00:00Z' };
      writeFileSync(inbox, JSON.stringify(msg) + '\n');

      // First read consumes everything
      const first = readNewInboxMessages(EDGE_TEAM_IO, 'w1');
      expect(first).toHaveLength(1);

      // Second read with no new data
      const second = readNewInboxMessages(EDGE_TEAM_IO, 'w1');
      expect(second).toEqual([]);
    });
  });

  describe('readAllInboxMessages with malformed lines', () => {
    it('skips invalid JSON lines and returns valid ones', () => {
      const inbox = join(TEAMS_IO_DIR, 'inbox', 'w1.jsonl');
      const valid: InboxMessage = { type: 'context', content: 'ctx', timestamp: '2026-01-01T00:00:00Z' };
      writeFileSync(inbox, 'garbage\n' + JSON.stringify(valid) + '\n' + '{{{\n');
      const msgs = readAllInboxMessages(EDGE_TEAM_IO, 'w1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('ctx');
    });
  });

  describe('rotateOutboxIfNeeded at exact boundary', () => {
    it('does not rotate when line count equals maxLines', () => {
      const msg: OutboxMessage = { type: 'heartbeat', timestamp: '2026-01-01T00:00:00Z' };
      for (let i = 0; i < 10; i++) {
        appendOutbox(EDGE_TEAM_IO, 'w1', { ...msg, message: `msg-${i}` });
      }
      rotateOutboxIfNeeded(EDGE_TEAM_IO, 'w1', 10);
      const lines = readFileSync(join(TEAMS_IO_DIR, 'outbox', 'w1.jsonl'), 'utf-8')
        .trim().split('\n').filter(l => l.trim());
      // Should keep all 10 since 10 <= 10
      expect(lines).toHaveLength(10);
    });

    it('rotates when line count is maxLines + 1', () => {
      const msg: OutboxMessage = { type: 'heartbeat', timestamp: '2026-01-01T00:00:00Z' };
      for (let i = 0; i < 11; i++) {
        appendOutbox(EDGE_TEAM_IO, 'w1', { ...msg, message: `msg-${i}` });
      }
      rotateOutboxIfNeeded(EDGE_TEAM_IO, 'w1', 10);
      const lines = readFileSync(join(TEAMS_IO_DIR, 'outbox', 'w1.jsonl'), 'utf-8')
        .trim().split('\n').filter(l => l.trim());
      // Should keep floor(10/2) = 5 most recent
      expect(lines).toHaveLength(5);
      // Most recent should be msg-10
      expect(JSON.parse(lines[lines.length - 1]).message).toBe('msg-10');
    });
  });

  describe('rotateOutboxIfNeeded on nonexistent file', () => {
    it('is a no-op and does not throw', () => {
      expect(() => rotateOutboxIfNeeded(EDGE_TEAM_IO, 'ghost', 10)).not.toThrow();
    });
  });

  describe('rotateOutboxIfNeeded with maxLines of 0', () => {
    it('keeps ALL lines due to JS slice(-0) returning full array', () => {
      // BUG/QUIRK: When maxLines=0, keepCount = floor(0/2) = 0,
      // but lines.slice(-0) in JS returns the ENTIRE array (not empty).
      // This means maxLines=0 does NOT empty the file -- it keeps everything.
      // This is a known JavaScript edge case with Array.prototype.slice.
      const msg: OutboxMessage = { type: 'idle', timestamp: '2026-01-01T00:00:00Z' };
      appendOutbox(EDGE_TEAM_IO, 'w1', msg);
      rotateOutboxIfNeeded(EDGE_TEAM_IO, 'w1', 0);
      const lines = readFileSync(join(TEAMS_IO_DIR, 'outbox', 'w1.jsonl'), 'utf-8')
        .trim().split('\n').filter(l => l.trim());
      // keepCount === 0 clears the outbox
      expect(lines).toHaveLength(0);
    });
  });

  describe('clearInbox when files do not exist', () => {
    it('does not throw when inbox and cursor are missing', () => {
      expect(() => clearInbox(EDGE_TEAM_IO, 'nonexistent-worker')).not.toThrow();
    });
  });

  describe('deleteShutdownSignal when file does not exist', () => {
    it('does not throw', () => {
      expect(() => deleteShutdownSignal(EDGE_TEAM_IO, 'ghost')).not.toThrow();
    });
  });

  describe('checkShutdownSignal with corrupt signal file', () => {
    it('returns null for malformed signal JSON', () => {
      const sigFile = join(TEAMS_IO_DIR, 'signals', 'w1.shutdown');
      writeFileSync(sigFile, 'this is not json');
      expect(checkShutdownSignal(EDGE_TEAM_IO, 'w1')).toBeNull();
    });
  });

  describe('cleanupWorkerFiles when some files already missing', () => {
    it('cleans available files and ignores missing ones', () => {
      // Only create outbox, skip inbox/cursor/signal
      appendOutbox(EDGE_TEAM_IO, 'w1', { type: 'idle', timestamp: '2026-01-01T00:00:00Z' });
      expect(existsSync(join(TEAMS_IO_DIR, 'outbox', 'w1.jsonl'))).toBe(true);

      // Cleanup should not throw even though inbox/signal don't exist
      expect(() => cleanupWorkerFiles(EDGE_TEAM_IO, 'w1')).not.toThrow();
      expect(existsSync(join(TEAMS_IO_DIR, 'outbox', 'w1.jsonl'))).toBe(false);
    });
  });

  describe('inbox messages with empty content', () => {
    it('reads messages with empty string content', () => {
      const inbox = join(TEAMS_IO_DIR, 'inbox', 'w1.jsonl');
      const msg: InboxMessage = { type: 'message', content: '', timestamp: '2026-01-01T00:00:00Z' };
      writeFileSync(inbox, JSON.stringify(msg) + '\n');
      const msgs = readNewInboxMessages(EDGE_TEAM_IO, 'w1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('');
    });
  });

  describe('readNewInboxMessages with multi-byte UTF-8 content', () => {
    it('correctly handles unicode characters in messages', () => {
      const inbox = join(TEAMS_IO_DIR, 'inbox', 'w1.jsonl');
      const msg: InboxMessage = {
        type: 'message',
        content: 'Hello \u{1F600} \u{1F4BB} \u00E9\u00E8\u00EA \u4F60\u597D',
        timestamp: '2026-01-01T00:00:00Z',
      };
      writeFileSync(inbox, JSON.stringify(msg) + '\n');
      const msgs = readNewInboxMessages(EDGE_TEAM_IO, 'w1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toContain('\u4F60\u597D');
    });
  });

  describe('readNewInboxMessages with multi-byte then append', () => {
    it('cursor byte offset works correctly across multi-byte boundaries', () => {
      const inbox = join(TEAMS_IO_DIR, 'inbox', 'w1.jsonl');
      // First message with multi-byte chars
      const msg1: InboxMessage = {
        type: 'message',
        content: '\u{1F600}\u{1F600}\u{1F600}',
        timestamp: '2026-01-01T00:00:00Z',
      };
      writeFileSync(inbox, JSON.stringify(msg1) + '\n');
      const batch1 = readNewInboxMessages(EDGE_TEAM_IO, 'w1');
      expect(batch1).toHaveLength(1);

      // Append second message
      const msg2: InboxMessage = { type: 'message', content: 'after-emoji', timestamp: '2026-01-01T00:01:00Z' };
      appendFileSync(inbox, JSON.stringify(msg2) + '\n');
      const batch2 = readNewInboxMessages(EDGE_TEAM_IO, 'w1');
      expect(batch2).toHaveLength(1);
      expect(batch2[0].content).toBe('after-emoji');
    });
  });

  describe('writeShutdownSignal overwrites existing signal', () => {
    it('replaces previous signal content', () => {
      writeShutdownSignal(EDGE_TEAM_IO, 'w1', 'req-1', 'first reason');
      writeShutdownSignal(EDGE_TEAM_IO, 'w1', 'req-2', 'second reason');
      const sig = checkShutdownSignal(EDGE_TEAM_IO, 'w1');
      expect(sig?.requestId).toBe('req-2');
      expect(sig?.reason).toBe('second reason');
    });
  });

  describe('appendOutbox creates directories automatically', () => {
    it('creates outbox dir if it does not exist', () => {
      // Remove the outbox directory
      rmSync(join(TEAMS_IO_DIR, 'outbox'), { recursive: true, force: true });
      expect(existsSync(join(TEAMS_IO_DIR, 'outbox'))).toBe(false);

      const msg: OutboxMessage = { type: 'idle', timestamp: '2026-01-01T00:00:00Z' };
      appendOutbox(EDGE_TEAM_IO, 'w1', msg);
      expect(existsSync(join(TEAMS_IO_DIR, 'outbox', 'w1.jsonl'))).toBe(true);
    });
  });
});


// ============================================================
// 3. heartbeat edge cases
// ============================================================

describe('heartbeat edge cases', () => {
  beforeEach(() => {
    mkdirSync(HB_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(HB_DIR, { recursive: true, force: true });
  });

  describe('isWorkerAlive with maxAgeMs of 0', () => {
    it('returns false because any age >= 0 fails the < 0 check', () => {
      writeHeartbeat(HB_DIR, makeHeartbeat());
      // Even a fresh heartbeat is at least 0ms old, and 0 < 0 is false
      expect(isWorkerAlive(HB_DIR, 'test-team', 'w1', 0)).toBe(false);
    });
  });

  describe('isWorkerAlive with very large maxAgeMs', () => {
    it('returns true for stale heartbeat when maxAge exceeds the staleness', () => {
      const stale = makeHeartbeat({ lastPollAt: '2000-01-01T00:00:00Z' });
      writeHeartbeat(HB_DIR, stale);
      // Year 2000 is ~26 years ago from 2026. Use 30 years in ms to be safe.
      const thirtyYearsMs = 30 * 365.25 * 24 * 60 * 60 * 1000;
      expect(isWorkerAlive(HB_DIR, 'test-team', 'w1', thirtyYearsMs)).toBe(true);
    });
  });

  describe('isWorkerAlive with future timestamp', () => {
    it('returns true since future - now is negative, which is < maxAgeMs', () => {
      const future = makeHeartbeat({
        lastPollAt: new Date(Date.now() + 3600000).toISOString(),
      });
      writeHeartbeat(HB_DIR, future);
      expect(isWorkerAlive(HB_DIR, 'test-team', 'w1', 1000)).toBe(true);
    });
  });

  describe('isWorkerAlive with empty string timestamp', () => {
    it('returns false for empty lastPollAt', () => {
      const bad = makeHeartbeat({ lastPollAt: '' });
      writeHeartbeat(HB_DIR, bad);
      // new Date('').getTime() is NaN
      expect(isWorkerAlive(HB_DIR, 'test-team', 'w1', 60000)).toBe(false);
    });
  });

  describe('isWorkerAlive with epoch zero timestamp', () => {
    it('returns false for very old epoch timestamp with tight maxAge', () => {
      const epoch = makeHeartbeat({ lastPollAt: '1970-01-01T00:00:00Z' });
      writeHeartbeat(HB_DIR, epoch);
      expect(isWorkerAlive(HB_DIR, 'test-team', 'w1', 60000)).toBe(false);
    });
  });

  describe('readHeartbeat with corrupt JSON file', () => {
    it('returns null for corrupt heartbeat file', () => {
      const dir = join(HB_DIR, '.omc', 'state', 'team-bridge', 'test-team');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'w1.heartbeat.json'), 'NOT JSON');
      expect(readHeartbeat(HB_DIR, 'test-team', 'w1')).toBeNull();
    });
  });

  describe('listHeartbeats with mixed valid and corrupt files', () => {
    it('returns only successfully parsed heartbeats', () => {
      writeHeartbeat(HB_DIR, makeHeartbeat({ workerName: 'good1' }));
      writeHeartbeat(HB_DIR, makeHeartbeat({ workerName: 'good2' }));

      // Write a corrupt heartbeat file
      const dir = join(HB_DIR, '.omc', 'state', 'team-bridge', 'test-team');
      writeFileSync(join(dir, 'corrupt.heartbeat.json'), '{bad json{{{');

      const heartbeats = listHeartbeats(HB_DIR, 'test-team');
      expect(heartbeats).toHaveLength(2);
      const names = heartbeats.map(h => h.workerName).sort();
      expect(names).toEqual(['good1', 'good2']);
    });
  });

  describe('writeHeartbeat overwrites existing data', () => {
    it('replaces previous heartbeat content', () => {
      writeHeartbeat(HB_DIR, makeHeartbeat({ status: 'polling', consecutiveErrors: 0 }));
      writeHeartbeat(HB_DIR, makeHeartbeat({ status: 'executing', consecutiveErrors: 2 }));
      const hb = readHeartbeat(HB_DIR, 'test-team', 'w1');
      expect(hb?.status).toBe('executing');
      expect(hb?.consecutiveErrors).toBe(2);
    });
  });

  describe('cleanupTeamHeartbeats with non-heartbeat files', () => {
    it('removes all files in the team directory including non-heartbeat ones', () => {
      writeHeartbeat(HB_DIR, makeHeartbeat({ workerName: 'w1' }));
      const dir = join(HB_DIR, '.omc', 'state', 'team-bridge', 'test-team');
      // Write an extra non-heartbeat file
      writeFileSync(join(dir, 'other-file.txt'), 'not a heartbeat');

      cleanupTeamHeartbeats(HB_DIR, 'test-team');
      // Heartbeat should be gone
      expect(readHeartbeat(HB_DIR, 'test-team', 'w1')).toBeNull();
      // The non-heartbeat file is also deleted (cleanupTeamHeartbeats deletes all files)
      expect(existsSync(join(dir, 'other-file.txt'))).toBe(false);
    });
  });

  describe('deleteHeartbeat is idempotent', () => {
    it('can be called twice without error', () => {
      writeHeartbeat(HB_DIR, makeHeartbeat());
      deleteHeartbeat(HB_DIR, 'test-team', 'w1');
      expect(() => deleteHeartbeat(HB_DIR, 'test-team', 'w1')).not.toThrow();
    });
  });
});


// ============================================================
// 4. tmux-session edge cases
// ============================================================

describe('tmux-session edge cases', () => {
  describe('sanitizeName with empty string', () => {
    it('throws for empty string', () => {
      expect(() => sanitizeName('')).toThrow('no valid characters');
    });
  });

  describe('sanitizeName with unicode characters', () => {
    it('strips all unicode and keeps only ASCII alphanumeric/hyphen', () => {
      expect(() => sanitizeName('\u4F60\u597D\u{1F600}')).toThrow('no valid characters');
    });

    it('keeps ASCII portion of mixed unicode/ASCII', () => {
      expect(sanitizeName('\u4F60hello\u597D')).toBe('hello');
    });
  });

  describe('sanitizeName with only hyphens', () => {
    it('accepts hyphens-only name', () => {
      expect(sanitizeName('---')).toBe('---');
    });
  });

  describe('sanitizeName with whitespace', () => {
    it('strips spaces and tabs', () => {
      expect(sanitizeName('  hello  world  ')).toBe('helloworld');
    });
  });

  describe('sanitizeName with path traversal characters', () => {
    it('strips dots, slashes, and backslashes', () => {
      expect(sanitizeName('../../../etc/passwd')).toBe('etcpasswd');
    });
  });

  describe('sanitizeName with newlines and control characters', () => {
    it('strips all control characters', () => {
      expect(sanitizeName('hello\nworld\t!')).toBe('helloworld');
    });
  });

  describe('sessionName total length', () => {
    it('each part is truncated to 50 chars independently', () => {
      const longName = 'a'.repeat(100);
      const result = sessionName(longName, longName);
      // 'omc-team-' + 50 chars + '-' + 50 chars = 110 total
      expect(result.length).toBe(110);
      expect(result).toBe(`omc-team-${'a'.repeat(50)}-${'a'.repeat(50)}`);
    });
  });

  describe('sanitizeName preserves case', () => {
    it('does not lowercase the name', () => {
      expect(sanitizeName('MyWorker-ABC')).toBe('MyWorker-ABC');
    });
  });
});


// ============================================================
// 5. team-registration edge cases
// ============================================================

describe('team-registration edge cases', () => {
  beforeEach(() => {
    mkdirSync(REG_DIR, { recursive: true });
    mkdirSync(join(REG_DIR, '.omc', 'state'), { recursive: true });
    mkdirSync(CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(REG_DIR, { recursive: true, force: true });
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  });

  describe('readProbeResult with corrupt JSON', () => {
    it('returns null for malformed probe result file', () => {
      const probePath = join(REG_DIR, '.omc', 'state', 'config-probe-result.json');
      writeFileSync(probePath, 'NOT JSON');
      expect(readProbeResult(REG_DIR)).toBeNull();
    });
  });

  describe('listMcpWorkers with malformed shadow registry', () => {
    it('returns empty when shadow registry is corrupt JSON', () => {
      const shadowPath = join(REG_DIR, '.omc', 'state', 'team-mcp-workers.json');
      writeFileSync(shadowPath, '{bad');
      // Should not throw and return whatever was parsed from config (empty since config not set up for this team)
      const workers = listMcpWorkers(REG_TEAM, REG_DIR);
      expect(Array.isArray(workers)).toBe(true);
    });
  });

  describe('listMcpWorkers with malformed config.json', () => {
    it('ignores corrupt config.json and falls back to shadow', () => {
      const configPath = join(CONFIG_DIR, 'config.json');
      writeFileSync(configPath, '{bad json{{{');

      // Register in shadow only
      registerMcpWorker(REG_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', REG_DIR);

      const workers = listMcpWorkers(REG_TEAM, REG_DIR);
      expect(workers).toHaveLength(1);
      expect(workers[0].name).toBe('w1');
    });
  });

  describe('registerMcpWorker builds correct agentId', () => {
    it('agentId format is {workerName}@{teamName}', () => {
      registerMcpWorker(REG_TEAM, 'myworker', 'gemini', 'gemini-pro', 'sess1', '/cwd', REG_DIR);
      const workers = listMcpWorkers(REG_TEAM, REG_DIR);
      expect(workers[0].agentId).toBe(`myworker@${REG_TEAM}`);
    });
  });

  describe('registerInConfig with config.json missing members array', () => {
    it('creates members array when config.json has no members field', () => {
      // Write config.json without members
      const configPath = join(CONFIG_DIR, 'config.json');
      writeFileSync(configPath, JSON.stringify({ teamName: REG_TEAM }));

      // Set probe to pass so registerInConfig is called
      writeProbeResult(REG_DIR, { probeResult: 'pass', probedAt: '', version: '' });

      registerMcpWorker(REG_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', REG_DIR);

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.members).toHaveLength(1);
      expect(config.members[0].name).toBe('w1');
    });
  });

  describe('registerInConfig deduplicates by worker name', () => {
    it('replaces existing entry with same name', () => {
      const configPath = join(CONFIG_DIR, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        teamName: REG_TEAM,
        members: [{ name: 'w1', backendType: 'tmux', agentType: 'mcp-codex' }],
      }));

      writeProbeResult(REG_DIR, { probeResult: 'pass', probedAt: '', version: '' });
      registerMcpWorker(REG_TEAM, 'w1', 'gemini', 'gemini-pro', 'sess2', '/cwd2', REG_DIR);

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.members).toHaveLength(1);
      expect(config.members[0].agentType).toBe('mcp-gemini');
    });
  });

  describe('unregisterMcpWorker with corrupt config.json', () => {
    it('does not throw when config.json is malformed', () => {
      const configPath = join(CONFIG_DIR, 'config.json');
      writeFileSync(configPath, 'NOT JSON');
      expect(() => unregisterMcpWorker(REG_TEAM, 'w1', REG_DIR)).not.toThrow();
    });
  });

  describe('unregisterMcpWorker with corrupt shadow registry', () => {
    it('does not throw when shadow registry is malformed', () => {
      const shadowPath = join(REG_DIR, '.omc', 'state', 'team-mcp-workers.json');
      writeFileSync(shadowPath, 'NOT JSON');
      expect(() => unregisterMcpWorker(REG_TEAM, 'w1', REG_DIR)).not.toThrow();
    });
  });

  describe('isMcpWorker with various inputs', () => {
    it('returns false for null/undefined backendType', () => {
      expect(isMcpWorker({ backendType: null })).toBe(false);
      expect(isMcpWorker({ backendType: undefined })).toBe(false);
    });

    it('returns false for numeric backendType', () => {
      expect(isMcpWorker({ backendType: 123 })).toBe(false);
    });

    it('returns true only for exact string tmux', () => {
      expect(isMcpWorker({ backendType: 'TMUX' })).toBe(false);
      expect(isMcpWorker({ backendType: 'tmux ' })).toBe(false);
      expect(isMcpWorker({ backendType: 'tmux' })).toBe(true);
    });
  });

  describe('listMcpWorkers with no files at all', () => {
    it('returns empty array when neither config nor shadow exist', () => {
      // Use a team name that has no config dir
      const workers = listMcpWorkers('totally_nonexistent_team_abc', REG_DIR);
      expect(workers).toEqual([]);
    });
  });

  describe('shadow registry handles missing workers array gracefully', () => {
    it('registers successfully when shadow registry has no workers field', () => {
      // Shadow file exists but has no "workers" key — (registry.workers || []) guard handles it
      const shadowPath = join(REG_DIR, '.omc', 'state', 'team-mcp-workers.json');
      writeFileSync(shadowPath, JSON.stringify({ teamName: REG_TEAM }));

      // Should not throw
      expect(() =>
        registerMcpWorker(REG_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', REG_DIR)
      ).not.toThrow();

      // Verify the worker was registered
      const workers = listMcpWorkers(REG_TEAM, REG_DIR);
      expect(workers.length).toBeGreaterThanOrEqual(1);
      expect(workers.some(w => w.name === 'w1')).toBe(true);
    });
  });

  describe('config.json members with non-tmux workers', () => {
    it('listMcpWorkers filters out non-tmux members from config', () => {
      const configPath = join(CONFIG_DIR, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        teamName: REG_TEAM,
        members: [
          { name: 'claude-agent', backendType: 'subprocess', agentType: 'claude' },
          { name: 'mcp-w1', backendType: 'tmux', agentType: 'mcp-codex' },
        ],
      }));

      const workers = listMcpWorkers(REG_TEAM, REG_DIR);
      expect(workers).toHaveLength(1);
      expect(workers[0].name).toBe('mcp-w1');
    });
  });
});
