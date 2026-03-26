/**
 * @file agent-messages helper integration tests using PGlite in-memory.
 *
 * TDD RED→GREEN: these tests drive the creation of agent_messages table
 * and CRUD helper functions.
 *
 * sendMessage signature (v3):
 *   sendMessage(sender, recipient, channel, message, context?, messageType?, taskId?, roomId?, payload?, db?)
 */

import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema.js';
import {
  sendMessage,
  getMessages,
  markAsRead,
  getUnreadMessages,
  getMessagesByTaskId,
  getMessagesByType,
  getLatestHandoff,
  getMessagesByRoomId,
} from '../db/agent-messages.js';

// ─── DDL ─────────────────────────────────────────────────

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  channel TEXT NOT NULL,
  message TEXT NOT NULL,
  context JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_by JSONB NOT NULL DEFAULT '[]',
  message_type TEXT DEFAULT 'report',
  task_id TEXT,
  room_id TEXT,
  reply_to TEXT,
  payload JSONB,
  mentions JSONB DEFAULT '[]'
);
`;

// ─── Per-test DB factory ─────────────────────────────────

async function createTestDb() {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema });
  return { client, db };
}

// ─── Tests ───────────────────────────────────────────────

describe('sendMessage()', () => {
  it('saves a message and it exists in DB', async () => {
    const { db } = await createTestDb();
    const msg = await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'Hello team', undefined, undefined, undefined, undefined, undefined, db);

    expect(msg.id).toBeTruthy();
    expect(msg.sender).toBe('minjun-ceo');
    expect(msg.recipient).toBe('bini-beauty');
    expect(msg.channel).toBe('standup');
    expect(msg.message).toBe('Hello team');
  });
});

describe('getMessages()', () => {
  it('filters by channel', async () => {
    const { db } = await createTestDb();
    await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'standup msg', undefined, undefined, undefined, undefined, undefined, db);
    await sendMessage('minjun-ceo', 'bini-beauty', 'general', 'general msg', undefined, undefined, undefined, undefined, undefined, db);

    const msgs = await getMessages({ channel: 'standup' }, db);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channel).toBe('standup');
  });

  it('filters by sender', async () => {
    const { db } = await createTestDb();
    await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'from ceo', undefined, undefined, undefined, undefined, undefined, db);
    await sendMessage('bini-beauty', 'minjun-ceo', 'standup', 'from bini', undefined, undefined, undefined, undefined, undefined, db);

    const msgs = await getMessages({ sender: 'minjun-ceo' }, db);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].sender).toBe('minjun-ceo');
  });

  it('filters by date', async () => {
    const { db } = await createTestDb();
    await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'today msg', undefined, undefined, undefined, undefined, undefined, db);

    const today = new Date().toISOString().split('T')[0]; // e.g. '2026-03-23'
    const msgs = await getMessages({ date: today }, db);
    expect(msgs.length).toBeGreaterThan(0);
  });
});

describe('markAsRead()', () => {
  it('adds agentName to read_by array', async () => {
    const { db } = await createTestDb();
    const msg = await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'read me', undefined, undefined, undefined, undefined, undefined, db);

    await markAsRead(msg.id, 'bini-beauty', db);

    const [updated] = await getMessages({ channel: 'standup' }, db);
    const readBy = updated.read_by as string[];
    expect(readBy).toContain('bini-beauty');
  });
});

describe('getUnreadMessages()', () => {
  it('returns only unread messages for agent', async () => {
    const { db } = await createTestDb();
    await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'unread msg', undefined, undefined, undefined, undefined, undefined, db);
    const readMsg = await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'read msg', undefined, undefined, undefined, undefined, undefined, db);

    await markAsRead(readMsg.id, 'bini-beauty', db);

    const unread = await getUnreadMessages('bini-beauty', db);
    expect(unread).toHaveLength(1);
    expect(unread[0].message).toBe('unread msg');
  });
});

describe('sendMessage() with messageType + taskId', () => {
  it('saves message_type and task_id', async () => {
    const { db } = await createTestDb();
    const msg = await sendMessage(
      'junho-researcher', 'seoyeon-analyst', 'handoff', 'phase1 done',
      undefined, 'handoff', 'daily-20260323', undefined, undefined, db,
    );

    expect(msg.message_type).toBe('handoff');
    expect(msg.task_id).toBe('daily-20260323');
  });

  it('defaults message_type to report when not provided', async () => {
    const { db } = await createTestDb();
    const msg = await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'hello', undefined, undefined, undefined, undefined, undefined, db);
    expect(msg.message_type).toBe('report');
  });
});

describe('getMessagesByTaskId()', () => {
  it('returns all messages for a task_id', async () => {
    const { db } = await createTestDb();
    await sendMessage('a', 'b', 'ch', 'msg1', undefined, 'report', 'daily-001', undefined, undefined, db);
    await sendMessage('a', 'b', 'ch', 'msg2', undefined, 'handoff', 'daily-001', undefined, undefined, db);
    await sendMessage('a', 'b', 'ch', 'other', undefined, 'report', 'daily-002', undefined, undefined, db);

    const msgs = await getMessagesByTaskId('daily-001', db);
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m: { task_id: string }) => m.task_id === 'daily-001')).toBe(true);
  });

  it('returns empty array when task_id not found', async () => {
    const { db } = await createTestDb();
    const msgs = await getMessagesByTaskId('nonexistent', db);
    expect(msgs).toHaveLength(0);
  });
});

describe('getMessagesByType()', () => {
  it('filters by message_type', async () => {
    const { db } = await createTestDb();
    await sendMessage('a', 'b', 'ch', 'directive msg', undefined, 'directive', 'daily-001', undefined, undefined, db);
    await sendMessage('a', 'b', 'ch', 'report msg', undefined, 'report', 'daily-001', undefined, undefined, db);

    const directives = await getMessagesByType('directive', undefined, db);
    expect(directives).toHaveLength(1);
    expect(directives[0].message).toBe('directive msg');
  });

  it('filters by type + since date', async () => {
    const { db } = await createTestDb();
    await sendMessage('a', 'b', 'ch', 'old report', undefined, 'report', undefined, undefined, undefined, db);

    const future = new Date(Date.now() + 60_000);
    const msgs = await getMessagesByType('report', future, db);
    expect(msgs).toHaveLength(0);
  });
});

describe('getLatestHandoff()', () => {
  it('returns the most recent handoff for a task_id', async () => {
    const { db } = await createTestDb();
    await sendMessage('a', 'b', 'ch', 'only handoff', undefined, 'handoff', 'daily-001', undefined, undefined, db);

    const latest = await getLatestHandoff('daily-001', db);
    expect(latest).not.toBeNull();
    expect(latest!.message_type).toBe('handoff');
    expect(latest!.task_id).toBe('daily-001');
  });

  it('returns null when no handoff exists', async () => {
    const { db } = await createTestDb();
    const result = await getLatestHandoff('no-handoff-task', db);
    expect(result).toBeNull();
  });
});

describe('getMessagesByRoomId()', () => {
  it('returns all messages for a room_id', async () => {
    const { db } = await createTestDb();
    await sendMessage('minjun-ceo', 'bini-beauty', 'meeting', 'msg1', undefined, undefined, undefined, 'room-A', undefined, db);
    await sendMessage('bini-beauty', 'minjun-ceo', 'meeting', 'msg2', undefined, undefined, undefined, 'room-A', undefined, db);
    await sendMessage('seoyeon', 'minjun-ceo', 'standup', 'msg3', undefined, undefined, undefined, 'room-B', undefined, db);

    const msgs = await getMessagesByRoomId('room-A', db);
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m: { room_id: string }) => m.room_id === 'room-A')).toBe(true);
  });

  it('returns empty array when room not found', async () => {
    const { db } = await createTestDb();
    const msgs = await getMessagesByRoomId('nonexistent', db);
    expect(msgs).toHaveLength(0);
  });
});
