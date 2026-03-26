/**
 * @file schema-v2.test.ts — AI Company v2 신규 6개 테이블 + room_id CRUD 검증.
 *
 * TDD: PGlite 인메모리 DB로 Drizzle 정의가 올바른지 검증.
 */

import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';

// ─── DDL ─────────────────────────────────────────────────

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  department TEXT NOT NULL,
  team TEXT,
  is_team_lead BOOLEAN DEFAULT false,
  personality JSONB,
  avatar_color TEXT,
  status TEXT DEFAULT 'idle',
  agent_file TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_name TEXT NOT NULL,
  meeting_type TEXT NOT NULL,
  agenda TEXT,
  participants JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  decisions JSONB,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  concluded_at TIMESTAMPTZ
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
  room_id TEXT,
  reply_to TEXT,
  mentions JSONB DEFAULT '[]'
);
`;

async function createTestDb() {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema });
  return { client, db };
}

// ─── agents ──────────────────────────────────────────────

describe('agents table', () => {
  it('inserts and retrieves an agent', async () => {
    const { db } = await createTestDb();

    await db.insert(schema.agents).values({
      id: 'minjun-ceo',
      name: '민준',
      role: 'CEO',
      department: 'executive',
      is_team_lead: true,
      status: 'idle',
    });

    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, 'minjun-ceo'));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('민준');
    expect(rows[0].is_team_lead).toBe(true);
  });

  it('stores personality JSONB', async () => {
    const { db } = await createTestDb();
    const personality = { traits: ['냉철', '분석적'], style: '차분하지만 단호' };

    await db.insert(schema.agents).values({
      id: 'minjun-ceo',
      name: '민준',
      role: 'CEO',
      department: 'executive',
      personality,
    });

    const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'minjun-ceo'));
    expect(row.personality).toEqual(personality);
  });
});

// ─── agent_memories ──────────────────────────────────────

describe('agent_memories table', () => {
  it('inserts a memory with default importance', async () => {
    const { db } = await createTestDb();

    const [row] = await db
      .insert(schema.agentMemories)
      .values({
        id: crypto.randomUUID(),
        agent_id: 'minjun-ceo',
        scope: 'global',
        memory_type: 'insight',
        content: '뷰티 카테고리가 가장 ROI가 높다',
      })
      .returning();

    expect(row.scope).toBe('global');
    expect(row.importance).toBeCloseTo(0.5);
  });

  it('queries memories by agent_id and scope', async () => {
    const { db } = await createTestDb();

    await db.insert(schema.agentMemories).values([
      { id: crypto.randomUUID(), agent_id: 'minjun-ceo', scope: 'global', memory_type: 'insight', content: 'global insight' },
      { id: crypto.randomUUID(), agent_id: 'minjun-ceo', scope: 'private', memory_type: 'rule', content: 'private rule' },
    ]);

    const globals = await db
      .select()
      .from(schema.agentMemories)
      .where(eq(schema.agentMemories.scope, 'global'));

    expect(globals).toHaveLength(1);
    expect(globals[0].content).toBe('global insight');
  });
});

// ─── agent_episodes ──────────────────────────────────────

describe('agent_episodes table', () => {
  it('inserts pipeline_run episode with details', async () => {
    const { db } = await createTestDb();

    const details = { phases_completed: 6, gate_failures: 0, errors: [] };
    const [row] = await db
      .insert(schema.agentEpisodes)
      .values({
        id: crypto.randomUUID(),
        agent_id: 'minjun-ceo',
        event_type: 'pipeline_run',
        summary: '일일 파이프라인 완료',
        details,
      })
      .returning();

    expect(row.event_type).toBe('pipeline_run');
    expect(row.details).toEqual(details);
  });

  it('queries episodes by agent_id', async () => {
    const { db } = await createTestDb();

    await db.insert(schema.agentEpisodes).values([
      { id: crypto.randomUUID(), agent_id: 'minjun-ceo', event_type: 'decision', summary: '뷰티 강화 결정' },
      { id: crypto.randomUUID(), agent_id: 'bini-beauty', event_type: 'post', summary: '포스트 게시' },
    ]);

    const episodes = await db
      .select()
      .from(schema.agentEpisodes)
      .where(eq(schema.agentEpisodes.agent_id, 'minjun-ceo'));

    expect(episodes).toHaveLength(1);
    expect(episodes[0].summary).toBe('뷰티 강화 결정');
  });
});

// ─── strategy_archive ────────────────────────────────────

describe('strategy_archive table', () => {
  it('inserts a strategy version with active status', async () => {
    const { db } = await createTestDb();

    const strategy = { category_ratio: { beauty: 0.4, health: 0.3 }, time_slots: ['09:00', '19:00'] };
    const [row] = await db
      .insert(schema.strategyArchive)
      .values({
        id: crypto.randomUUID(),
        version: 'v1.0',
        strategy,
        status: 'active',
      })
      .returning();

    expect(row.version).toBe('v1.0');
    expect(row.status).toBe('active');
    expect(row.strategy).toEqual(strategy);
  });

  it('stores performance JSONB with revenue fields', async () => {
    const { db } = await createTestDb();

    const performance = { avg_roi: 2.5, avg_views: 1200, revenue_target: 500000, revenue_actual: 320000 };
    const [row] = await db
      .insert(schema.strategyArchive)
      .values({
        id: crypto.randomUUID(),
        version: 'v1.1',
        strategy: { categories: ['beauty'] },
        performance,
      })
      .returning();

    expect(row.performance).toEqual(performance);
  });
});

// ─── meetings ────────────────────────────────────────────

describe('meetings table', () => {
  it('creates a meeting with active status', async () => {
    const { db } = await createTestDb();

    const [row] = await db
      .insert(schema.meetings)
      .values({
        id: crypto.randomUUID(),
        room_name: 'standup-20260324',
        meeting_type: 'standup',
        agenda: '오늘 업무 공유',
        participants: ['minjun-ceo', 'bini-beauty', 'seoyeon-analyst'],
        created_by: 'minjun-ceo',
      })
      .returning();

    expect(row.status).toBe('active');
    expect(row.room_name).toBe('standup-20260324');
    expect(row.participants).toHaveLength(3);
  });

  it('can be concluded with decisions', async () => {
    const { db } = await createTestDb();

    const meetingId = crypto.randomUUID();
    await db.insert(schema.meetings).values({
      id: meetingId,
      room_name: 'strategy-room',
      meeting_type: 'strategy',
      created_by: 'minjun-ceo',
    });

    const decisions = { action: '뷰티 카테고리 비중 50%로 상향', votes: 3 };
    await db
      .update(schema.meetings)
      .set({ status: 'concluded', decisions, concluded_at: new Date() })
      .where(eq(schema.meetings.id, meetingId));

    const [row] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, meetingId));
    expect(row.status).toBe('concluded');
    expect(row.decisions).toEqual(decisions);
  });
});

// ─── pending_approvals ───────────────────────────────────

describe('pending_approvals table', () => {
  it('creates a pending approval', async () => {
    const { db } = await createTestDb();

    const [row] = await db
      .insert(schema.pendingApprovals)
      .values({
        id: crypto.randomUUID(),
        requested_by: 'minjun-ceo',
        approval_type: 'new_category',
        description: '패션 카테고리 추가 요청',
        details: { proposed_category: 'fashion', budget_impact: 0 },
      })
      .returning();

    expect(row.status).toBe('pending');
    expect(row.approval_type).toBe('new_category');
  });

  it('can be approved', async () => {
    const { db } = await createTestDb();

    const approvalId = crypto.randomUUID();
    await db.insert(schema.pendingApprovals).values({
      id: approvalId,
      requested_by: 'taeho-engineer',
      approval_type: 'system_change',
      description: '수집 스케줄 변경',
    });

    await db
      .update(schema.pendingApprovals)
      .set({ status: 'approved', resolved_at: new Date() })
      .where(eq(schema.pendingApprovals.id, approvalId));

    const [row] = await db.select().from(schema.pendingApprovals).where(eq(schema.pendingApprovals.id, approvalId));
    expect(row.status).toBe('approved');
    expect(row.resolved_at).not.toBeNull();
  });
});

// ─── agent_messages room_id ───────────────────────────────

describe('agent_messages room_id field', () => {
  it('saves and retrieves room_id', async () => {
    const { db } = await createTestDb();

    const [row] = await db
      .insert(schema.agentMessages)
      .values({
        id: crypto.randomUUID(),
        sender: 'minjun-ceo',
        recipient: 'bini-beauty',
        channel: 'meeting',
        message: '오늘 전략 토론 시작',
        room_id: 'standup-20260324',
      })
      .returning();

    expect(row.room_id).toBe('standup-20260324');
  });

  it('room_id is nullable for regular messages', async () => {
    const { db } = await createTestDb();

    const [row] = await db
      .insert(schema.agentMessages)
      .values({
        id: crypto.randomUUID(),
        sender: 'minjun-ceo',
        recipient: 'bini-beauty',
        channel: 'standup',
        message: '일반 메시지',
      })
      .returning();

    expect(row.room_id).toBeNull();
  });
});
