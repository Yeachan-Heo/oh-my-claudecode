/**
 * @file agent-actions.test.ts — createAgentMeeting 중복 방지 테스트
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock state ──────────────────────────────────────────────

/** dedup 쿼리 결과를 제어하는 변수 */
let dedupQueryResult: Array<{ id: string }> = [];

// ─── DB mock ─────────────────────────────────────────────────

const mockStartMeeting = vi.fn().mockResolvedValue({
  meetingId: 'new-meeting-id',
  config: {},
  messages: [],
  tokenEstimate: 0,
});

vi.mock('../db/index.js', () => {
  // select chain: dedup 쿼리용
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => dedupQueryResult),
  };
  // insert chain: meetings + chatRooms + chatParticipants + agentMessages
  const insertChain = {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'new-meeting-id' }]),
    }),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(selectChain),
      insert: vi.fn().mockReturnValue(insertChain),
    },
  };
});

vi.mock('../db/schema.js', () => ({
  meetings: { id: 'id', created_by: 'created_by', agenda: 'agenda', created_at: 'created_at' },
  agentMessages: {},
  chatRooms: { id: 'id' },
  chatParticipants: {},
}));

vi.mock('./meeting.js', () => ({
  startMeeting: mockStartMeeting,
}));

vi.mock('./agent-spawner.js', () => ({
  canCreateRoom: vi.fn().mockReturnValue(true),
}));

import { createAgentMeeting } from '../orchestrator/agent-actions.js';

// ─── Tests ───────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  dedupQueryResult = [];
});

describe('createAgentMeeting — 중복 방지', () => {
  const baseOpts = {
    creator: 'minjun-ceo',
    type: 'planning' as const,
    agenda: '이번 주 콘텐츠 전략',
    participants: ['minjun-ceo', 'seoyeon-analyst'],
  };

  it('중복 없으면 정상 생성', async () => {
    dedupQueryResult = [];

    const result = await createAgentMeeting(baseOpts);

    expect(result.meetingId).toBe('new-meeting-id');
    expect(result.dispatched.length).toBeGreaterThan(0);
  });

  it('5분 이내 같은 creator+agenda 회의가 있으면 스킵', async () => {
    dedupQueryResult = [{ id: 'existing-meeting-id' }];

    const result = await createAgentMeeting(baseOpts);

    expect(result.meetingId).toBe('existing-meeting-id');
    expect(result.dispatched).toEqual([]);
  });

  it('중복 스킵 시 startMeeting이 호출되지 않음', async () => {
    dedupQueryResult = [{ id: 'existing-meeting-id' }];

    await createAgentMeeting(baseOpts);

    expect(mockStartMeeting).not.toHaveBeenCalled();
  });
});
