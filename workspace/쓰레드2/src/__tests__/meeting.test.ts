/**
 * @file src/__tests__/meeting.test.ts
 * meeting.ts 핵심 로직 TDD 테스트
 */

import { describe, it, expect, vi } from 'vitest';

// DB 모듈 목킹 — 순수 함수 테스트에는 DB 불필요
vi.mock('../db/index.js', () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-id' }]) }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  },
}));
vi.mock('../db/schema.js', () => ({
  meetings: {},
  agentEpisodes: {},
}));

import {
  selectNextSpeaker,
  leastRecentSpeaker,
  extractMentions,
  checkConsensus,
  assignDevilsAdvocate,
  compressTranscript,
  addMessage,
  buildMeetingContext,
  allParticipantsSpoken,
  extractFinalDecision,
  getMeetingStats,
  type Message,
  type MeetingTranscript,
  type MeetingConfig,
} from '../orchestrator/meeting.js';

// ─── 헬퍼 ───────────────────────────────────────────────────────────────────

const PARTICIPANTS = ['minjun-ceo', 'jihyun-lead', 'seoyeon-analyst', 'dooyun-qa'];

function makeMessage(agentId: string, content: string, turnIndex: number): Message {
  return { agentId, content, turnIndex, timestamp: new Date() };
}

function makeTranscript(
  messages: Message[],
  participants = PARTICIPANTS,
  type: MeetingConfig['type'] = 'standup',
): MeetingTranscript {
  return {
    meetingId: 'test-meeting-id',
    config: {
      roomName: 'test-room',
      type,
      agenda: '테스트 안건',
      participants,
      createdBy: 'minjun-ceo',
      consensusRequired: true,
      tokenBudget: 100_000,
    },
    messages,
    tokenEstimate: messages.length * 300,
  };
}

// ─── selectNextSpeaker ──────────────────────────────────────────────────────

describe('selectNextSpeaker', () => {
  it('빈 transcript → 첫 번째 참석자 반환', () => {
    const result = selectNextSpeaker([], PARTICIPANTS);
    expect(result).toBe('minjun-ceo');
  });

  it('@멘션된 에이전트 최우선 선택', () => {
    const transcript = [
      makeMessage('minjun-ceo', '@seoyeon-analyst 데이터 확인해줘요', 0),
    ];
    const result = selectNextSpeaker(transcript, PARTICIPANTS);
    expect(result).toBe('seoyeon-analyst');
  });

  it('미발언 에이전트 우선 선택', () => {
    const transcript = [
      makeMessage('minjun-ceo', '회의 시작', 0),
      makeMessage('jihyun-lead', '네', 1),
    ];
    const result = selectNextSpeaker(transcript, PARTICIPANTS);
    // seoyeon-analyst 또는 dooyun-qa 중 하나 (발언 안 한 에이전트)
    expect(['seoyeon-analyst', 'dooyun-qa']).toContain(result);
  });

  it('전원 발언 후 → 가장 오래 침묵한 에이전트 선택', () => {
    const transcript = [
      makeMessage('minjun-ceo', '발언1', 0),
      makeMessage('jihyun-lead', '발언2', 1),
      makeMessage('seoyeon-analyst', '발언3', 2),
      makeMessage('dooyun-qa', '발언4', 3),
    ];
    const result = selectNextSpeaker(transcript, PARTICIPANTS);
    expect(result).toBe('minjun-ceo'); // 가장 오래 침묵
  });

  it('참석자 1명이면 그 에이전트 반환', () => {
    const result = selectNextSpeaker([], ['minjun-ceo']);
    expect(result).toBe('minjun-ceo');
  });
});

// ─── leastRecentSpeaker ─────────────────────────────────────────────────────

describe('leastRecentSpeaker', () => {
  it('연속 3회 같은 에이전트 → 다른 에이전트 선택', () => {
    const transcript = [
      makeMessage('jihyun-lead', '발언1', 0),
      makeMessage('minjun-ceo', '발언2', 1),
      makeMessage('minjun-ceo', '발언3', 2),
      makeMessage('minjun-ceo', '발언4', 3),
    ];
    // minjun-ceo는 연속 3회이므로 제외
    // Note: leastRecentSpeaker counts CONSECUTIVE from END of transcript
    // minjun-ceo가 연속 3회 발언 → 다른 에이전트 선택
    const result = leastRecentSpeaker(transcript, PARTICIPANTS);
    expect(result).not.toBe('minjun-ceo');
  });

  it('발언 기록 없는 에이전트를 우선 선택', () => {
    const transcript = [makeMessage('minjun-ceo', '발언', 0)];
    const result = leastRecentSpeaker(transcript, PARTICIPANTS);
    expect(result).not.toBe('minjun-ceo');
  });
});

// ─── extractMentions ────────────────────────────────────────────────────────

describe('extractMentions', () => {
  it('@멘션 추출', () => {
    const result = extractMentions('@seoyeon-analyst 확인해줘', PARTICIPANTS);
    expect(result).toEqual(['seoyeon-analyst']);
  });

  it('참석자가 아닌 멘션은 무시', () => {
    const result = extractMentions('@unknown-agent 안녕', PARTICIPANTS);
    expect(result).toEqual([]);
  });

  it('여러 멘션 추출', () => {
    const result = extractMentions('@minjun-ceo @dooyun-qa 모두 확인', PARTICIPANTS);
    expect(result).toEqual(['minjun-ceo', 'dooyun-qa']);
  });

  it('멘션 없으면 빈 배열', () => {
    const result = extractMentions('그냥 발언', PARTICIPANTS);
    expect(result).toEqual([]);
  });
});

// ─── checkConsensus ─────────────────────────────────────────────────────────

describe('checkConsensus', () => {
  it('참석자 수보다 적은 메시지 → false', () => {
    const transcript = [makeMessage('minjun-ceo', '동의합니다', 0)];
    expect(checkConsensus(transcript, PARTICIPANTS)).toBe(false);
  });

  it('반박 있으면 → false', () => {
    const messages = [
      makeMessage('minjun-ceo', '동의합니다', 0),
      makeMessage('jihyun-lead', '동의합니다', 1),
      makeMessage('seoyeon-analyst', '반대합니다', 2),
      makeMessage('dooyun-qa', '동의합니다', 3),
      makeMessage('minjun-ceo', '동의합니다', 4),
    ];
    expect(checkConsensus(messages, PARTICIPANTS)).toBe(false);
  });

  it('반박 없고 동의 60%+ → true', () => {
    const messages = [
      makeMessage('minjun-ceo', '동의합니다 진행합시다', 0),
      makeMessage('jihyun-lead', '좋습니다 동의해요', 1),
      makeMessage('seoyeon-analyst', '동의합니다', 2),
      makeMessage('dooyun-qa', '진행하겠습니다', 3),
      makeMessage('minjun-ceo', '합의되었습니다', 4),
    ];
    expect(checkConsensus(messages, PARTICIPANTS)).toBe(true);
  });
});

// ─── assignDevilsAdvocate ───────────────────────────────────────────────────

describe('assignDevilsAdvocate', () => {
  it('weekly 아닌 회의 → null', () => {
    const transcript = Array.from({ length: 10 }, (_, i) =>
      makeMessage(PARTICIPANTS[i % 4]!, '발언', i),
    );
    expect(assignDevilsAdvocate(transcript, PARTICIPANTS, 'standup')).toBeNull();
  });

  it('weekly이고 10의 배수 턴 → 에이전트 반환', () => {
    const transcript = Array.from({ length: 10 }, (_, i) =>
      makeMessage(PARTICIPANTS[i % 4]!, '발언', i),
    );
    const result = assignDevilsAdvocate(transcript, PARTICIPANTS, 'weekly');
    expect(result).not.toBeNull();
    expect(PARTICIPANTS).toContain(result);
  });

  it('weekly이고 10의 배수 아닌 턴 → null', () => {
    const transcript = Array.from({ length: 7 }, (_, i) =>
      makeMessage(PARTICIPANTS[i % 4]!, '발언', i),
    );
    expect(assignDevilsAdvocate(transcript, PARTICIPANTS, 'weekly')).toBeNull();
  });

  it('마지막 발언자는 advocate에서 제외', () => {
    const transcript = Array.from({ length: 10 }, (_, i) =>
      makeMessage(PARTICIPANTS[i % 4]!, '발언', i),
    );
    const lastSpeaker = transcript[9]!.agentId;
    const result = assignDevilsAdvocate(transcript, PARTICIPANTS, 'weekly');
    expect(result).not.toBe(lastSpeaker);
  });
});

// ─── compressTranscript ──────────────────────────────────────────────────────

describe('compressTranscript', () => {
  it('15턴 이하 → 압축 안 함', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage(PARTICIPANTS[i % 4]!, '발언', i),
    );
    const transcript = makeTranscript(messages);
    const result = compressTranscript(transcript);
    expect(result.messages).toHaveLength(10);
    expect(result.summary).toBeUndefined();
  });

  it('16턴 이상 → 최근 15턴만 보존 + 요약 생성', () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMessage(PARTICIPANTS[i % 4]!, `발언 ${i}`, i),
    );
    const transcript = makeTranscript(messages);
    const result = compressTranscript(transcript);
    expect(result.messages).toHaveLength(15);
    expect(result.summary).toBeTruthy();
    expect(result.summaryUpToTurn).toBe(4); // 인덱스 4가 마지막 압축된 턴
  });
});

// ─── addMessage ──────────────────────────────────────────────────────────────

describe('addMessage', () => {
  it('메시지 추가 후 턴 인덱스 증가', () => {
    let transcript = makeTranscript([]);
    transcript = addMessage(transcript, 'minjun-ceo', '첫 발언');
    transcript = addMessage(transcript, 'jihyun-lead', '두 번째 발언');

    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages[0]!.turnIndex).toBe(0);
    expect(transcript.messages[1]!.turnIndex).toBe(1);
  });

  it('tokenEstimate 증가', () => {
    let transcript = makeTranscript([]);
    const initial = transcript.tokenEstimate;
    transcript = addMessage(transcript, 'minjun-ceo', '발언');
    expect(transcript.tokenEstimate).toBeGreaterThan(initial);
  });

  it('isAdvocate 플래그 설정', () => {
    let transcript = makeTranscript([]);
    transcript = addMessage(transcript, 'seoyeon-analyst', '반론합니다', true);
    expect(transcript.messages[0]!.isAdvocate).toBe(true);
  });
});

// ─── allParticipantsSpoken ──────────────────────────────────────────────────

describe('allParticipantsSpoken', () => {
  it('모두 발언했으면 true', () => {
    const messages = PARTICIPANTS.map((p, i) => makeMessage(p, '발언', i));
    const transcript = makeTranscript(messages);
    expect(allParticipantsSpoken(transcript)).toBe(true);
  });

  it('일부만 발언했으면 false', () => {
    const messages = [makeMessage('minjun-ceo', '발언', 0)];
    const transcript = makeTranscript(messages);
    expect(allParticipantsSpoken(transcript)).toBe(false);
  });
});

// ─── extractFinalDecision ───────────────────────────────────────────────────

describe('extractFinalDecision', () => {
  it('[FINAL_DECISION] 태그 파싱', () => {
    const output = '논의 결과\n[FINAL_DECISION] 결정: 뷰티 비율 40%로 증가\n마무리';
    const result = extractFinalDecision(output);
    expect(result).toContain('뷰티 비율 40%로 증가');
  });

  it('[CONSENSUS] 태그 파싱', () => {
    const output = '[CONSENSUS] 결정: 내일부터 시간대 변경';
    const result = extractFinalDecision(output);
    expect(result).toContain('내일부터 시간대 변경');
  });

  it('태그 없으면 빈 배열', () => {
    const result = extractFinalDecision('그냥 텍스트');
    expect(result).toEqual([]);
  });
});

// ─── getMeetingStats ─────────────────────────────────────────────────────────

describe('getMeetingStats', () => {
  it('발언 횟수 정확히 집계', () => {
    const messages = [
      makeMessage('minjun-ceo', '발언1', 0),
      makeMessage('minjun-ceo', '발언2', 1),
      makeMessage('jihyun-lead', '발언3', 2),
    ];
    const transcript = makeTranscript(messages);
    const stats = getMeetingStats(transcript);

    expect(stats.totalTurns).toBe(3);
    expect(stats.speakerBreakdown['minjun-ceo']).toBe(2);
    expect(stats.speakerBreakdown['jihyun-lead']).toBe(1);
  });
});

// ─── buildMeetingContext ─────────────────────────────────────────────────────

describe('buildMeetingContext', () => {
  it('회의 정보와 메시지가 포함된 컨텍스트 반환', () => {
    const messages = [makeMessage('minjun-ceo', '안건 논의 시작', 0)];
    const transcript = makeTranscript(messages);
    const ctx = buildMeetingContext(transcript);

    expect(ctx).toContain('test-room');
    expect(ctx).toContain('테스트 안건');
    expect(ctx).toContain('minjun-ceo');
    expect(ctx).toContain('안건 논의 시작');
  });

  it('합의 필요 회의에서 합의 태그 안내 포함', () => {
    const transcript = makeTranscript([]);
    const ctx = buildMeetingContext(transcript);
    expect(ctx).toContain('[CONSENSUS]');
  });

  it('요약이 있으면 요약 섹션 포함', () => {
    const transcript = makeTranscript([]);
    const withSummary: MeetingTranscript = {
      ...transcript,
      summary: '이전 논의 요약 내용',
      summaryUpToTurn: 14,
    };
    const ctx = buildMeetingContext(withSummary);
    expect(ctx).toContain('이전 대화 요약');
    expect(ctx).toContain('이전 논의 요약 내용');
  });
});
