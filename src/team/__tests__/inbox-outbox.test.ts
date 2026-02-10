import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  appendOutbox, rotateOutboxIfNeeded, readNewInboxMessages,
  readAllInboxMessages, clearInbox, writeShutdownSignal,
  checkShutdownSignal, deleteShutdownSignal, writeDrainSignal,
  checkDrainSignal, deleteDrainSignal, cleanupWorkerFiles,
  rotateInboxIfNeeded
} from '../inbox-outbox.js';
import { sanitizeName } from '../tmux-session.js';
import { validateResolvedPath } from '../fs-utils.js';
import type { OutboxMessage, InboxMessage } from '../types.js';

const TEST_TEAM = 'test-team-io';
const TEAMS_DIR = join(homedir(), '.claude', 'teams', TEST_TEAM);

beforeEach(() => {
  mkdirSync(join(TEAMS_DIR, 'inbox'), { recursive: true });
  mkdirSync(join(TEAMS_DIR, 'outbox'), { recursive: true });
  mkdirSync(join(TEAMS_DIR, 'signals'), { recursive: true });
});

afterEach(() => {
  rmSync(TEAMS_DIR, { recursive: true, force: true });
});

describe('appendOutbox', () => {
  it('appends JSONL message', () => {
    const msg: OutboxMessage = { type: 'idle', message: 'standing by', timestamp: '2026-01-01T00:00:00Z' };
    appendOutbox(TEST_TEAM, 'w1', msg);
    appendOutbox(TEST_TEAM, 'w1', { ...msg, type: 'heartbeat' });
    const lines = readFileSync(join(TEAMS_DIR, 'outbox', 'w1.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe('idle');
  });
});

describe('rotateOutboxIfNeeded', () => {
  it('rotates when exceeding maxLines', () => {
    const msg: OutboxMessage = { type: 'heartbeat', timestamp: '2026-01-01T00:00:00Z' };
    for (let i = 0; i < 20; i++) {
      appendOutbox(TEST_TEAM, 'w1', { ...msg, message: `msg-${i}` });
    }
    rotateOutboxIfNeeded(TEST_TEAM, 'w1', 10);
    const lines = readFileSync(join(TEAMS_DIR, 'outbox', 'w1.jsonl'), 'utf-8').trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
    // Should keep recent messages
    expect(JSON.parse(lines[lines.length - 1]).message).toBe('msg-19');
  });

  it('no-op when under limit', () => {
    appendOutbox(TEST_TEAM, 'w1', { type: 'idle', timestamp: '2026-01-01T00:00:00Z' });
    rotateOutboxIfNeeded(TEST_TEAM, 'w1', 100);
    const lines = readFileSync(join(TEAMS_DIR, 'outbox', 'w1.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });
});

describe('readNewInboxMessages', () => {
  it('reads new messages with offset cursor', () => {
    const inbox = join(TEAMS_DIR, 'inbox', 'w1.jsonl');
    const msg1: InboxMessage = { type: 'message', content: 'hello', timestamp: '2026-01-01T00:00:00Z' };
    const msg2: InboxMessage = { type: 'context', content: 'ctx', timestamp: '2026-01-01T00:01:00Z' };

    writeFileSync(inbox, JSON.stringify(msg1) + '\n');
    const batch1 = readNewInboxMessages(TEST_TEAM, 'w1');
    expect(batch1).toHaveLength(1);
    expect(batch1[0].content).toBe('hello');

    // Append more - cursor should skip first message
    const content = readFileSync(inbox, 'utf-8');
    writeFileSync(inbox, content + JSON.stringify(msg2) + '\n');
    const batch2 = readNewInboxMessages(TEST_TEAM, 'w1');
    expect(batch2).toHaveLength(1);
    expect(batch2[0].content).toBe('ctx');
  });

  it('returns empty for no inbox file', () => {
    expect(readNewInboxMessages(TEST_TEAM, 'noworker')).toEqual([]);
  });

  it('handles file truncation (cursor reset)', () => {
    const inbox = join(TEAMS_DIR, 'inbox', 'w1.jsonl');
    const longMsg: InboxMessage = { type: 'message', content: 'a'.repeat(100), timestamp: '2026-01-01T00:00:00Z' };
    writeFileSync(inbox, JSON.stringify(longMsg) + '\n');
    readNewInboxMessages(TEST_TEAM, 'w1'); // sets cursor past EOF

    // Truncate file to something smaller
    const shortMsg: InboxMessage = { type: 'message', content: 'new', timestamp: '2026-01-01T00:01:00Z' };
    writeFileSync(inbox, JSON.stringify(shortMsg) + '\n');
    const msgs = readNewInboxMessages(TEST_TEAM, 'w1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('new');
  });
});

describe('readAllInboxMessages', () => {
  it('reads all messages regardless of cursor', () => {
    const inbox = join(TEAMS_DIR, 'inbox', 'w1.jsonl');
    const msg1: InboxMessage = { type: 'message', content: 'first', timestamp: '2026-01-01T00:00:00Z' };
    const msg2: InboxMessage = { type: 'message', content: 'second', timestamp: '2026-01-01T00:01:00Z' };
    writeFileSync(inbox, JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n');

    const all = readAllInboxMessages(TEST_TEAM, 'w1');
    expect(all).toHaveLength(2);
    expect(all[0].content).toBe('first');
    expect(all[1].content).toBe('second');
  });

  it('returns empty for missing inbox', () => {
    expect(readAllInboxMessages(TEST_TEAM, 'noworker')).toEqual([]);
  });
});

describe('clearInbox', () => {
  it('truncates inbox and resets cursor', () => {
    const inbox = join(TEAMS_DIR, 'inbox', 'w1.jsonl');
    const msg: InboxMessage = { type: 'message', content: 'hello', timestamp: '2026-01-01T00:00:00Z' };
    writeFileSync(inbox, JSON.stringify(msg) + '\n');
    readNewInboxMessages(TEST_TEAM, 'w1'); // advance cursor

    clearInbox(TEST_TEAM, 'w1');

    expect(readFileSync(inbox, 'utf-8')).toBe('');
    expect(readAllInboxMessages(TEST_TEAM, 'w1')).toEqual([]);
  });
});

describe('shutdown signals', () => {
  it('write, check, delete cycle', () => {
    writeShutdownSignal(TEST_TEAM, 'w1', 'req-123', 'done');
    const sig = checkShutdownSignal(TEST_TEAM, 'w1');
    expect(sig?.requestId).toBe('req-123');
    expect(sig?.reason).toBe('done');

    deleteShutdownSignal(TEST_TEAM, 'w1');
    expect(checkShutdownSignal(TEST_TEAM, 'w1')).toBeNull();
  });

  it('returns null when no signal exists', () => {
    expect(checkShutdownSignal(TEST_TEAM, 'nosignal')).toBeNull();
  });
});

describe('drain signals', () => {
  it('writes and reads drain signal', () => {
    writeDrainSignal(TEST_TEAM, 'w1', 'req-1', 'scaling down');
    const signal = checkDrainSignal(TEST_TEAM, 'w1');
    expect(signal).not.toBeNull();
    expect(signal!.requestId).toBe('req-1');
    expect(signal!.reason).toBe('scaling down');
    expect(signal!.timestamp).toBeTruthy();
  });

  it('returns null when no drain signal exists', () => {
    const signal = checkDrainSignal(TEST_TEAM, 'no-such-worker');
    expect(signal).toBeNull();
  });

  it('deletes drain signal', () => {
    writeDrainSignal(TEST_TEAM, 'w1', 'req-1', 'test');
    expect(checkDrainSignal(TEST_TEAM, 'w1')).not.toBeNull();
    deleteDrainSignal(TEST_TEAM, 'w1');
    expect(checkDrainSignal(TEST_TEAM, 'w1')).toBeNull();
  });

  it('delete does not throw for non-existent signal', () => {
    expect(() => deleteDrainSignal(TEST_TEAM, 'nonexistent')).not.toThrow();
  });
});

describe('cleanupWorkerFiles', () => {
  it('removes inbox, outbox, cursor, signal files', () => {
    appendOutbox(TEST_TEAM, 'w1', { type: 'idle', timestamp: '2026-01-01T00:00:00Z' });
    writeShutdownSignal(TEST_TEAM, 'w1', 'req', 'test');
    writeDrainSignal(TEST_TEAM, 'w1', 'req', 'test');
    writeFileSync(join(TEAMS_DIR, 'inbox', 'w1.jsonl'), '{}');
    writeFileSync(join(TEAMS_DIR, 'inbox', 'w1.offset'), '{}');

    cleanupWorkerFiles(TEST_TEAM, 'w1');
    expect(existsSync(join(TEAMS_DIR, 'outbox', 'w1.jsonl'))).toBe(false);
    expect(existsSync(join(TEAMS_DIR, 'inbox', 'w1.jsonl'))).toBe(false);
    expect(existsSync(join(TEAMS_DIR, 'inbox', 'w1.offset'))).toBe(false);
    expect(existsSync(join(TEAMS_DIR, 'signals', 'w1.shutdown'))).toBe(false);
    expect(existsSync(join(TEAMS_DIR, 'signals', 'w1.drain'))).toBe(false);
  });
});

describe('MAX_INBOX_READ_SIZE buffer cap', () => {
  it('caps buffer allocation on large inbox reads', () => {
    const inbox = join(TEAMS_DIR, 'inbox', 'w1.jsonl');
    // Write many messages to create a large file
    const msgs: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const msg: InboxMessage = { type: 'message', content: `msg-${i}-${'x'.repeat(100)}`, timestamp: '2026-01-01T00:00:00Z' };
      msgs.push(JSON.stringify(msg));
    }
    writeFileSync(inbox, msgs.join('\n') + '\n');
    // Should not throw OOM — reads are capped
    const result = readNewInboxMessages(TEST_TEAM, 'w1');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('rotateInboxIfNeeded', () => {
  it('rotates when inbox exceeds maxSizeBytes', () => {
    const inbox = join(TEAMS_DIR, 'inbox', 'w1.jsonl');
    // Write enough data to exceed a small threshold
    const msgs: string[] = [];
    for (let i = 0; i < 50; i++) {
      const msg: InboxMessage = { type: 'message', content: `msg-${i}`, timestamp: '2026-01-01T00:00:00Z' };
      msgs.push(JSON.stringify(msg));
    }
    writeFileSync(inbox, msgs.join('\n') + '\n');

    const { statSync } = require('fs');
    const sizeBefore = statSync(inbox).size;

    // Rotate with a threshold smaller than current size
    rotateInboxIfNeeded(TEST_TEAM, 'w1', 100);

    const sizeAfter = statSync(inbox).size;
    expect(sizeAfter).toBeLessThan(sizeBefore);
  });

  it('no-op when inbox is under maxSizeBytes', () => {
    const inbox = join(TEAMS_DIR, 'inbox', 'w1.jsonl');
    const msg: InboxMessage = { type: 'message', content: 'small', timestamp: '2026-01-01T00:00:00Z' };
    writeFileSync(inbox, JSON.stringify(msg) + '\n');

    const { statSync } = require('fs');
    const sizeBefore = statSync(inbox).size;

    rotateInboxIfNeeded(TEST_TEAM, 'w1', 10000);

    const sizeAfter = statSync(inbox).size;
    expect(sizeAfter).toBe(sizeBefore);
  });
});

describe('path traversal guard on teamsDir', () => {
  it('sanitizeName prevents traversal characters in team names', () => {
    // '../../../etc' gets sanitized to 'etc' — dots and slashes are stripped
    // This means the path traversal is blocked at the sanitization layer
    expect(sanitizeName('../../../etc')).toBe('etc');
    // No dots, no slashes survive sanitization
    expect(sanitizeName('foo/../bar')).toBe('foobar');
  });

  it('validateResolvedPath catches paths that escape base', () => {
    expect(() => validateResolvedPath('/home/user/../escape', '/home/user'))
      .toThrow('Path traversal');
  });

  it('all-special-char team name throws from sanitizeName', () => {
    // A name made entirely of special chars produces empty string → throws
    expect(() => appendOutbox('...///...', 'w1', { type: 'idle', timestamp: '2026-01-01T00:00:00Z' }))
      .toThrow();
  });
});
