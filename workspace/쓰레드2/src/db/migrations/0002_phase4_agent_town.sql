-- Phase 4: Agent Town 연동을 위한 agents 테이블 확장
-- 에이전트 상태/위치 실시간 추적

ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_task TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS location TEXT DEFAULT 'desk';

-- Phase 4 Step B: 채팅 시스템 테이블

CREATE TABLE IF NOT EXISTS chat_rooms (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_by    TEXT NOT NULL,
  meeting_id    TEXT,
  metadata      JSONB DEFAULT '{}',
  last_message_at TIMESTAMPTZ,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS chat_participants (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at       TIMESTAMPTZ,
  last_read_at  TIMESTAMPTZ,
  UNIQUE(room_id, agent_id)
);

ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS reply_to TEXT;
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS mentions JSONB DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_chat_rooms_status ON chat_rooms (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_type ON chat_rooms (type);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_created_by ON chat_rooms (created_by);
CREATE INDEX IF NOT EXISTS idx_chat_participants_room ON chat_participants (room_id);
CREATE INDEX IF NOT EXISTS idx_chat_participants_agent ON chat_participants (agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_participants_unique ON chat_participants (room_id, agent_id);
