-- Migration: AI Company v2 — 6 new tables + room_id + indexes
-- S-1: DB schema for agents, memories, episodes, strategy, meetings, approvals

-- 에이전트 레지스트리
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
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 의미 기억
CREATE TABLE IF NOT EXISTS agent_memories (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  importance FLOAT DEFAULT 0.5,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);

-- 에피소드 기억 (pipeline_run 통합)
CREATE TABLE IF NOT EXISTS agent_episodes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  details JSONB,
  occurred_at TIMESTAMPTZ DEFAULT now()
);

-- 전략 아카이브
CREATE TABLE IF NOT EXISTS strategy_archive (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  version TEXT NOT NULL,
  parent_version TEXT,
  strategy JSONB NOT NULL,
  performance JSONB,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  evaluated_at TIMESTAMPTZ
);

-- 회의 메타데이터
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_name TEXT NOT NULL,
  meeting_type TEXT NOT NULL,
  agenda TEXT,
  participants JSONB DEFAULT '[]',
  status TEXT DEFAULT 'active',
  decisions JSONB,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  concluded_at TIMESTAMPTZ
);

-- 승인 대기
CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  requested_by TEXT NOT NULL,
  approval_type TEXT NOT NULL,
  description TEXT NOT NULL,
  details JSONB,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- agent_messages에 room_id 추가
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS room_id TEXT;

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_memories_agent_scope ON agent_memories(agent_id, scope, importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_global ON agent_memories(scope) WHERE scope = 'global';
CREATE INDEX IF NOT EXISTS idx_episodes_agent ON agent_episodes(agent_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_pipeline ON agent_episodes(event_type) WHERE event_type = 'pipeline_run';
CREATE INDEX IF NOT EXISTS idx_archive_status ON strategy_archive(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON pending_approvals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_room ON agent_messages(room_id) WHERE room_id IS NOT NULL;
