/**
 * @file agent-messages helper integration tests using PGlite in-memory.
 *
 * TDD RED→GREEN: these tests drive the creation of agent_messages table
 * and CRUD helper functions.
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
  read_by JSONB NOT NULL DEFAULT '[]'
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
    const msg = await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'Hello team', undefined, db);

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
    await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'standup msg', undefined, db);
    await sendMessage('minjun-ceo', 'bini-beauty', 'general', 'general msg', undefined, db);

    const msgs = await getMessages({ channel: 'standup' }, db);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channel).toBe('standup');
  });

  it('filters by sender', async () => {
    const { db } = await createTestDb();
    await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'from ceo', undefined, db);
    await sendMessage('bini-beauty', 'minjun-ceo', 'standup', 'from bini', undefined, db);

    const msgs = await getMessages({ sender: 'minjun-ceo' }, db);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].sender).toBe('minjun-ceo');
  });

  it('filters by date', async () => {
    const { db } = await createTestDb();
    await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'today msg', undefined, db);

    const today = new Date().toISOString().split('T')[0]; // e.g. '2026-03-23'
    const msgs = await getMessages({ date: today }, db);
    expect(msgs.length).toBeGreaterThan(0);
  });
});

describe('markAsRead()', () => {
  it('adds agentName to read_by array', async () => {
    const { db } = await createTestDb();
    const msg = await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'read me', undefined, db);

    await markAsRead(msg.id, 'bini-beauty', db);

    const [updated] = await getMessages({ channel: 'standup' }, db);
    const readBy = updated.read_by as string[];
    expect(readBy).toContain('bini-beauty');
  });
});

describe('getUnreadMessages()', () => {
  it('returns only unread messages for agent', async () => {
    const { db } = await createTestDb();
    await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'unread msg', undefined, db);
    const readMsg = await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'read msg', undefined, db);

    await markAsRead(readMsg.id, 'bini-beauty', db);

    const unread = await getUnreadMessages('bini-beauty', db);
    expect(unread).toHaveLength(1);
    expect(unread[0].message).toBe('unread msg');
  });
});
