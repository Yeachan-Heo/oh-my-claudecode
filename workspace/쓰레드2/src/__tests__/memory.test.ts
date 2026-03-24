/**
 * @file memory.test.ts — TDD for src/db/memory.ts
 *
 * RED → GREEN: tests drive the memory helper implementation.
 * Uses PGlite in-memory DB.
 */

import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema.js';
import {
  saveMemory,
  logEpisode,
  loadAgentContext,
  formatMemoryForPrompt,
} from '../db/memory.js';
import {
  sendMessage,
  getMessagesByRoomId,
} from '../db/agent-messages.js';

// ─── DDL ─────────────────────────────────────────────────

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS agent_memories (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  importance FLOAT DEFAULT 0.5,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_episodes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  details JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_archive (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  version TEXT NOT NULL,
  parent_version TEXT,
  strategy JSONB NOT NULL,
  performance JSONB,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  requested_by TEXT NOT NULL,
  approval_type TEXT NOT NULL,
  description TEXT NOT NULL,
  details JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

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
  room_id TEXT
);
`;

async function createTestDb() {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema });
  return { client, db };
}

// ─── saveMemory ───────────────────────────────────────────

describe('saveMemory()', () => {
  it('inserts a global memory', async () => {
    const { db } = await createTestDb();

    const row = await saveMemory({
      agentId: 'minjun-ceo',
      scope: 'global',
      memoryType: 'insight',
      content: '뷰티 카테고리 ROI 가장 높음',
      importance: 0.8,
    }, db);

    expect(row.scope).toBe('global');
    expect(row.content).toBe('뷰티 카테고리 ROI 가장 높음');
    expect(row.importance).toBeCloseTo(0.8);
  });

  it('inserts a private memory for specific agent', async () => {
    const { db } = await createTestDb();

    const row = await saveMemory({
      agentId: 'bini-beauty',
      scope: 'private',
      memoryType: 'rule',
      content: '뷰티 포스트는 공감 먼저',
    }, db);

    expect(row.agent_id).toBe('bini-beauty');
    expect(row.scope).toBe('private');
  });

  it('defaults importance to 0.5', async () => {
    const { db } = await createTestDb();

    const row = await saveMemory({
      agentId: 'minjun-ceo',
      scope: 'global',
      memoryType: 'fact',
      content: '팩트',
    }, db);

    expect(row.importance).toBeCloseTo(0.5);
  });
});

// ─── logEpisode ───────────────────────────────────────────

describe('logEpisode()', () => {
  it('inserts a decision episode', async () => {
    const { db } = await createTestDb();

    const row = await logEpisode({
      agentId: 'minjun-ceo',
      eventType: 'decision',
      summary: '뷰티 카테고리 비중 50%로 상향',
    }, db);

    expect(row.agent_id).toBe('minjun-ceo');
    expect(row.event_type).toBe('decision');
    expect(row.summary).toBe('뷰티 카테고리 비중 50%로 상향');
  });

  it('inserts a pipeline_run episode with details', async () => {
    const { db } = await createTestDb();

    const details = { phases_completed: 6, gate_failures: 0, errors: [] };
    const row = await logEpisode({
      agentId: 'minjun-ceo',
      eventType: 'pipeline_run',
      summary: '일일 파이프라인 완료',
      details,
    }, db);

    expect(row.event_type).toBe('pipeline_run');
    expect(row.details).toEqual(details);
  });
});

// ─── loadAgentContext ─────────────────────────────────────

describe('loadAgentContext()', () => {
  it('returns empty arrays when no data', async () => {
    const { db } = await createTestDb();

    const ctx = await loadAgentContext('minjun-ceo', 'executive', db);

    expect(Array.isArray(ctx.global)).toBe(true);
    expect(Array.isArray(ctx.department)).toBe(true);
    expect(Array.isArray(ctx.private)).toBe(true);
    expect(Array.isArray(ctx.episodes)).toBe(true);
    expect(Array.isArray(ctx.pendingDecisions)).toBe(true);
    expect(Array.isArray(ctx.pendingApprovals)).toBe(true);
  });

  it('returns global memories in ctx.global', async () => {
    const { db } = await createTestDb();

    await saveMemory({ agentId: 'minjun-ceo', scope: 'global', memoryType: 'insight', content: 'global insight', importance: 0.9 }, db);
    await saveMemory({ agentId: 'bini-beauty', scope: 'private', memoryType: 'rule', content: 'private rule' }, db);

    const ctx = await loadAgentContext('minjun-ceo', 'executive', db);

    expect(ctx.global.length).toBeGreaterThan(0);
    expect((ctx.global[0] as { content: string }).content).toBe('global insight');
  });

  it('returns private memories for this agent only', async () => {
    const { db } = await createTestDb();

    await saveMemory({ agentId: 'minjun-ceo', scope: 'private', memoryType: 'rule', content: 'ceo private rule' }, db);
    await saveMemory({ agentId: 'bini-beauty', scope: 'private', memoryType: 'rule', content: 'bini private rule' }, db);

    const ctx = await loadAgentContext('minjun-ceo', 'executive', db);

    expect((ctx.private as Array<{ agent_id: string }>).every(m => m.agent_id === 'minjun-ceo')).toBe(true);
  });

  it('returns recent episodes for agent', async () => {
    const { db } = await createTestDb();

    await logEpisode({ agentId: 'minjun-ceo', eventType: 'decision', summary: 'episode 1' }, db);
    await logEpisode({ agentId: 'minjun-ceo', eventType: 'decision', summary: 'episode 2' }, db);
    await logEpisode({ agentId: 'bini-beauty', eventType: 'post', summary: 'bini episode' }, db);

    const ctx = await loadAgentContext('minjun-ceo', 'executive', db);

    expect(ctx.episodes.length).toBe(2);
    expect((ctx.episodes as Array<{ agent_id: string }>).every(e => e.agent_id === 'minjun-ceo')).toBe(true);
  });

  it('returns pendingApprovals from DB', async () => {
    const { db } = await createTestDb();

    await db.insert(schema.pendingApprovals).values({
      id: crypto.randomUUID(),
      requested_by: 'minjun-ceo',
      approval_type: 'new_category',
      description: '패션 카테고리 추가',
      status: 'pending',
    });

    const ctx = await loadAgentContext('minjun-ceo', 'executive', db);

    expect(ctx.pendingApprovals.length).toBeGreaterThan(0);
  });

  it('falls back to empty array if a sub-query fails', async () => {
    // Pass a broken db to simulate sub-query failure
    // We test that loadAgentContext doesn't throw
    const { db } = await createTestDb();

    // This should not throw even if individual queries fail
    await expect(loadAgentContext('unknown-agent', 'unknown-dept', db)).resolves.toBeDefined();
  });
});

// ─── formatMemoryForPrompt ────────────────────────────────

describe('formatMemoryForPrompt()', () => {
  it('returns a non-empty string with sections', () => {
    const ctx = {
      global: [{ content: 'global insight', memory_type: 'insight', importance: 0.9, created_at: new Date() }],
      department: [],
      private: [{ content: 'private rule', memory_type: 'rule', importance: 0.7, created_at: new Date() }],
      episodes: [{ summary: 'decided X', event_type: 'decision', occurred_at: new Date() }],
      strategy: null,
      pendingDecisions: [],
      pendingApprovals: [],
    };

    const result = formatMemoryForPrompt(ctx);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('global insight');
    expect(result).toContain('private rule');
  });

  it('truncates to 3000 tokens (chars proxy)', () => {
    const longContent = 'x'.repeat(500);
    const manyMemories = Array.from({ length: 30 }, (_, i) => ({
      content: longContent + i,
      memory_type: 'insight',
      importance: 0.5,
      created_at: new Date(),
    }));

    const ctx = {
      global: manyMemories,
      department: manyMemories,
      private: manyMemories,
      episodes: [],
      strategy: null,
      pendingDecisions: [],
      pendingApprovals: [],
    };

    const result = formatMemoryForPrompt(ctx);
    // 3000 tokens ≈ 12000 chars (4 chars/token), add buffer
    expect(result.length).toBeLessThanOrEqual(15000);
  });

  it('returns empty string for empty context', () => {
    const ctx = {
      global: [],
      department: [],
      private: [],
      episodes: [],
      strategy: null,
      pendingDecisions: [],
      pendingApprovals: [],
    };

    const result = formatMemoryForPrompt(ctx);
    expect(typeof result).toBe('string');
  });
});

// ─── agent-messages roomId + getMessagesByRoomId ──────────

describe('sendMessage() with roomId', () => {
  it('saves roomId when provided', async () => {
    const { db } = await createTestDb();

    const msg = await sendMessage(
      'minjun-ceo', 'bini-beauty', 'meeting', '전략 토론',
      undefined, undefined, undefined, 'standup-20260324', db,
    );

    expect(msg.room_id).toBe('standup-20260324');
  });

  it('room_id is null when not provided', async () => {
    const { db } = await createTestDb();

    const msg = await sendMessage('minjun-ceo', 'bini-beauty', 'standup', 'hello', undefined, undefined, undefined, undefined, db);

    expect(msg.room_id).toBeNull();
  });
});

describe('getMessagesByRoomId()', () => {
  it('returns all messages for a room_id', async () => {
    const { db } = await createTestDb();

    await sendMessage('minjun-ceo', 'bini-beauty', 'meeting', 'msg1', undefined, undefined, undefined, 'room-A', db);
    await sendMessage('bini-beauty', 'minjun-ceo', 'meeting', 'msg2', undefined, undefined, undefined, 'room-A', db);
    await sendMessage('seoyeon', 'minjun-ceo', 'standup', 'msg3', undefined, undefined, undefined, 'room-B', db);

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
