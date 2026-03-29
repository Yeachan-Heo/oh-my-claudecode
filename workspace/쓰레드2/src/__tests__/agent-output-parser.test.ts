/**
 * @file agent-output-parser.test.ts — 에이전트 출력 태그 파싱 + Phase Gate TDD
 *
 * 핵심 케이스:
 *  - 태그 파싱 (SAVE_MEMORY, LOG_EPISODE, CREATE_STRATEGY_VERSION)
 *  - DB 저장 확인
 *  - missing_tags → 재시도 2회 → quarantine
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({ db: {} }));

// memory.ts는 db를 import time에 실행하지 않으므로 mock 후 import
vi.mock('../db/memory.js', () => ({
  saveMemory: vi.fn().mockResolvedValue({ id: 'mem-1' }),
  logEpisode: vi.fn().mockResolvedValue({ id: 'ep-1' }),
}));

vi.mock('../db/strategy-archive.js', () => ({
  createStrategyVersion: vi.fn().mockResolvedValue({ id: 'sv-1', version: 'v2.0' }),
}));

vi.mock('../orchestrator/agent-actions.js', () => ({
  dispatchToAgent: vi.fn().mockResolvedValue('marker-123'),
  createAgentMeeting: vi.fn().mockResolvedValue({ meetingId: 'meet-123', dispatched: ['seoyeon-analyst'] }),
  reportToCeo: vi.fn().mockResolvedValue('report-marker-123'),
}));

vi.mock('../db/agent-tasks.js', () => ({
  createTask: vi.fn().mockResolvedValue({ id: 'task-1', title: 'mock', status: 'pending' }),
}));

import {
  parseTag,
  parseMeta,
  processAgentOutput,
  enforceTagGate,
  mapPriorityToNumber,
} from '../orchestrator/agent-output-parser.js';
import { saveMemory, logEpisode } from '../db/memory.js';
import { createStrategyVersion } from '../db/strategy-archive.js';
import { dispatchToAgent, createAgentMeeting, reportToCeo } from '../orchestrator/agent-actions.js';
import { createTask } from '../db/agent-tasks.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── parseTag ─────────────────────────────────────────────────

describe('parseTag', () => {
  it('단일 태그 추출', () => {
    const output = '[SAVE_MEMORY]\nscope: global\ncontent: 테스트\n[/SAVE_MEMORY]';
    const result = parseTag(output, /\[SAVE_MEMORY\]([\s\S]*?)\[\/SAVE_MEMORY\]/g);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('scope: global');
  });

  it('다중 태그 추출', () => {
    const output = `
[SAVE_MEMORY]
content: 첫 번째
[/SAVE_MEMORY]
텍스트
[SAVE_MEMORY]
content: 두 번째
[/SAVE_MEMORY]
    `.trim();
    const result = parseTag(output, /\[SAVE_MEMORY\]([\s\S]*?)\[\/SAVE_MEMORY\]/g);
    expect(result).toHaveLength(2);
  });

  it('태그 없으면 빈 배열', () => {
    const result = parseTag('아무 태그도 없는 텍스트', /\[SAVE_MEMORY\]([\s\S]*?)\[\/SAVE_MEMORY\]/g);
    expect(result).toHaveLength(0);
  });

  it('중첩 태그 무시 — 가장 바깥 매칭', () => {
    const output = '[LOG_EPISODE]\nsummary: 테스트\n[/LOG_EPISODE]';
    const result = parseTag(output, /\[LOG_EPISODE\]([\s\S]*?)\[\/LOG_EPISODE\]/g);
    expect(result).toHaveLength(1);
  });
});

// ─── parseMeta ────────────────────────────────────────────────

describe('parseMeta', () => {
  it('key: value 파싱', () => {
    const meta = parseMeta('scope: global\ncontent: 뷰티가 ROI 높음');
    expect(meta.scope).toBe('global');
    expect(meta.content).toBe('뷰티가 ROI 높음');
  });

  it('숫자 값 파싱', () => {
    const meta = parseMeta('importance: 0.8');
    expect(meta.importance).toBe(0.8);
  });

  it('JSON 값 파싱', () => {
    const meta = parseMeta('details: {"reason": "뷰티 성과 기반"}');
    expect(meta.details).toEqual({ reason: '뷰티 성과 기반' });
  });

  it('멀티라인 content 파싱', () => {
    const meta = parseMeta('scope: global\ncontent: "뷰티 카테고리가 성과 좋음"');
    expect(meta.content).toBeDefined();
  });

  it('따옴표 제거', () => {
    const meta = parseMeta('content: "따옴표 있는 값"');
    expect(meta.content).toBe('따옴표 있는 값');
  });
});

// ─── processAgentOutput ───────────────────────────────────────

describe('processAgentOutput', () => {
  it('SAVE_MEMORY 태그 파싱 → saveMemory 호출', async () => {
    vi.mocked(saveMemory).mockClear();
    const output = `
[SAVE_MEMORY]
scope: global
memory_type: insight
content: 뷰티 카테고리 ROI 1.5배
importance: 0.8
[/SAVE_MEMORY]
    `.trim();

    const result = await processAgentOutput('minjun-ceo', output);
    expect(result.status).toBe('ok');
    expect(saveMemory).toHaveBeenCalledTimes(1);
    expect(saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'minjun-ceo', scope: 'global' })
    );
  });

  it('LOG_EPISODE 태그 파싱 → logEpisode 호출', async () => {
    vi.mocked(logEpisode).mockClear();
    const output = `
[LOG_EPISODE]
event_type: decision
summary: 뷰티 비율 70%로 상향 결정
[/LOG_EPISODE]
    `.trim();

    const result = await processAgentOutput('minjun-ceo', output);
    expect(result.status).toBe('ok');
    expect(logEpisode).toHaveBeenCalledTimes(1);
    expect(logEpisode).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'minjun-ceo', eventType: 'decision' })
    );
  });

  it('CREATE_STRATEGY_VERSION 태그 → createStrategyVersion 호출', async () => {
    vi.mocked(createStrategyVersion).mockClear();
    const output = `
[LOG_EPISODE]
event_type: decision
summary: 전략 v2 생성
[/LOG_EPISODE]
[CREATE_STRATEGY_VERSION]
version: v2.1
parent_version: v2.0
strategy: {"category_ratio": {"beauty": 0.7}}
[/CREATE_STRATEGY_VERSION]
    `.trim();

    await processAgentOutput('minjun-ceo', output);
    expect(createStrategyVersion).toHaveBeenCalledTimes(1);
    expect(createStrategyVersion).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v2.1' })
    );
  });

  it('태그 없으면 missing_tags 반환', async () => {
    const output = '안녕하세요. 오늘 뷰티 콘텐츠를 기획했습니다.';
    const result = await processAgentOutput('bini', output);
    expect(result.status).toBe('missing_tags');
    expect(saveMemory).not.toHaveBeenCalled();
    expect(logEpisode).not.toHaveBeenCalled();
  });

  it('savedCount 반환 — 저장된 태그 수', async () => {
    vi.mocked(saveMemory).mockClear();
    vi.mocked(logEpisode).mockClear();
    const output = `
[SAVE_MEMORY]
scope: global
memory_type: insight
content: 테스트1
[/SAVE_MEMORY]
[LOG_EPISODE]
event_type: decision
summary: 테스트2
[/LOG_EPISODE]
    `.trim();

    const result = await processAgentOutput('minjun-ceo', output);
    expect(result.status).toBe('ok');
    expect((result as { savedCount: number }).savedCount).toBe(2);
  });
});

// ─── enforceTagGate ───────────────────────────────────────────

describe('enforceTagGate', () => {
  it('첫 출력에 태그 있으면 즉시 반환', async () => {
    const output = `[SAVE_MEMORY]\nscope: global\nmemory_type: insight\ncontent: 테스트\n[/SAVE_MEMORY]`;
    const retryFn = vi.fn();

    const result = await enforceTagGate('bini', output, retryFn);
    expect(result.output).toBe(output);
    expect(result.quarantined).toBe(false);
    expect(retryFn).not.toHaveBeenCalled();
  });

  it('1회 실패 후 재시도 성공 — retryFn 1회 호출', async () => {
    const firstOutput = '태그 없는 출력';
    const retryOutput = `[SAVE_MEMORY]\nscope: global\nmemory_type: insight\ncontent: 재시도 성공\n[/SAVE_MEMORY]`;
    const retryFn = vi.fn().mockResolvedValue(retryOutput);

    const result = await enforceTagGate('bini', firstOutput, retryFn);
    expect(retryFn).toHaveBeenCalledTimes(1);
    expect(retryFn).toHaveBeenCalledWith(1, expect.any(String));
    expect(result.output).toBe(retryOutput);
    expect(result.quarantined).toBe(false);
  });

  it('2회 실패 후 재시도 2회 성공 — retryFn 2회 호출', async () => {
    const noTag = '태그 없음';
    const retryOutput = `[LOG_EPISODE]\nevent_type: decision\nsummary: 성공\n[/LOG_EPISODE]`;
    const retryFn = vi.fn()
      .mockResolvedValueOnce(noTag)
      .mockResolvedValueOnce(retryOutput);

    const result = await enforceTagGate('bini', noTag, retryFn);
    expect(retryFn).toHaveBeenCalledTimes(2);
    expect(retryFn).toHaveBeenNthCalledWith(1, 1, expect.any(String));
    expect(retryFn).toHaveBeenNthCalledWith(2, 2, expect.any(String));
    expect(result.output).toBe(retryOutput);
    expect(result.quarantined).toBe(false);
  });

  it('3회 모두 실패 — quarantine: logEpisode(system, error) 호출 후 마지막 출력 반환', async () => {
    vi.mocked(logEpisode).mockClear();
    const noTag = '계속 태그 없음';
    const retryFn = vi.fn().mockResolvedValue(noTag);

    const result = await enforceTagGate('bini', noTag, retryFn);
    expect(retryFn).toHaveBeenCalledTimes(2);
    expect(result.output).toBe(noTag); // 출력은 반환
    expect(result.quarantined).toBe(true);
    // quarantine 에피소드 기록
    expect(logEpisode).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'system',
        eventType: 'error',
        summary: expect.stringContaining('quarantined'),
      })
    );
  });

  it('quarantine 시 saveMemory 미호출 — DB 기억 기록 없음', async () => {
    vi.mocked(saveMemory).mockClear();
    vi.mocked(logEpisode).mockClear();
    const noTag = '태그 없음';
    const retryFn = vi.fn().mockResolvedValue(noTag);

    const result = await enforceTagGate('bini', noTag, retryFn);
    expect(saveMemory).not.toHaveBeenCalled();
    expect(result.quarantined).toBe(true);
  });
});

// ─── P1: 자발적 행동 태그 파싱 ──────────────────────────────────

describe('P1: CREATE_MEETING 태그', () => {
  it('[CREATE_MEETING] 태그 파싱 → createAgentMeeting 호출', async () => {
    vi.mocked(createAgentMeeting).mockClear();
    const output = `
[LOG_EPISODE]
event_type: meeting
summary: 회의 소집
[/LOG_EPISODE]
[CREATE_MEETING]
type: planning
agenda: 이번 주 콘텐츠 전략
participants: seoyeon-analyst,bini-beauty-editor,jihyun-marketing-lead
[/CREATE_MEETING]
    `.trim();

    const result = await processAgentOutput('minjun-ceo', output);
    expect(result.status).toBe('ok');
    expect(createAgentMeeting).toHaveBeenCalledTimes(1);
    expect(createAgentMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        creator: 'minjun-ceo',
        type: 'planning',
        agenda: '이번 주 콘텐츠 전략',
        participants: expect.arrayContaining(['seoyeon-analyst', 'bini-beauty-editor']),
      })
    );
  });

  it('[CREATE_MEETING] agenda 없으면 호출 안 함', async () => {
    vi.mocked(createAgentMeeting).mockClear();
    const output = `
[SAVE_MEMORY]
scope: global
memory_type: insight
content: 테스트
[/SAVE_MEMORY]
[CREATE_MEETING]
type: planning
participants: seoyeon-analyst
[/CREATE_MEETING]
    `.trim();

    await processAgentOutput('minjun-ceo', output);
    expect(createAgentMeeting).not.toHaveBeenCalled();
  });
});

describe('P1: SEND_MESSAGE 태그', () => {
  it('[SEND_MESSAGE] 태그 파싱 → dispatchToAgent 호출', async () => {
    vi.mocked(dispatchToAgent).mockClear();
    const output = `
[LOG_EPISODE]
event_type: chat
summary: 메시지 전송
[/LOG_EPISODE]
[SEND_MESSAGE]
to: bini-beauty-editor
message: 오늘 뷰티 콘텐츠 3개 준비해주세요
[/SEND_MESSAGE]
    `.trim();

    const result = await processAgentOutput('minjun-ceo', output);
    expect(result.status).toBe('ok');
    expect(dispatchToAgent).toHaveBeenCalledTimes(1);
    expect(dispatchToAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: 'minjun-ceo',
        target: 'bini-beauty-editor',
        message: '오늘 뷰티 콘텐츠 3개 준비해주세요',
      })
    );
  });

  it('[SEND_MESSAGE] to 없으면 호출 안 함', async () => {
    vi.mocked(dispatchToAgent).mockClear();
    const output = `
[SAVE_MEMORY]
scope: global
memory_type: insight
content: 테스트
[/SAVE_MEMORY]
[SEND_MESSAGE]
message: 대상 없는 메시지
[/SEND_MESSAGE]
    `.trim();

    await processAgentOutput('minjun-ceo', output);
    expect(dispatchToAgent).not.toHaveBeenCalled();
  });
});

describe('P1: REPORT_TO_CEO 태그', () => {
  it('[REPORT_TO_CEO] 태그 파싱 → reportToCeo 호출', async () => {
    vi.mocked(reportToCeo).mockClear();
    const output = `
[LOG_EPISODE]
event_type: report
summary: 분석 완료
[/LOG_EPISODE]
[REPORT_TO_CEO]
summary: 오늘 수집 30건, 분석 완료. 뷰티 카테고리 조회수 평균 1200.
[/REPORT_TO_CEO]
    `.trim();

    const result = await processAgentOutput('seoyeon-analyst', output);
    expect(result.status).toBe('ok');
    expect(reportToCeo).toHaveBeenCalledTimes(1);
    expect(reportToCeo).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: 'seoyeon-analyst',
        summary: expect.stringContaining('수집 30건'),
      })
    );
  });

  it('다중 P1 태그 동시 처리', async () => {
    vi.mocked(dispatchToAgent).mockClear();
    vi.mocked(reportToCeo).mockClear();
    const output = `
[LOG_EPISODE]
event_type: pipeline_run
summary: 파이프라인 완료
[/LOG_EPISODE]
[SEND_MESSAGE]
to: jihyun-marketing-lead
message: 콘텐츠 기획 데이터 준비됨
[/SEND_MESSAGE]
[REPORT_TO_CEO]
summary: 파이프라인 Phase 1~2 완료
[/REPORT_TO_CEO]
    `.trim();

    const result = await processAgentOutput('seoyeon-analyst', output);
    expect(result.status).toBe('ok');
    expect(dispatchToAgent).toHaveBeenCalledTimes(1);
    expect(reportToCeo).toHaveBeenCalledTimes(1);
  });
});

// ─── P2: ACTION_ITEM 태그 파싱 ──────────────────────────────────

describe('mapPriorityToNumber', () => {
  it('urgent → 1, high → 2, medium → 5, low → 8', () => {
    expect(mapPriorityToNumber('urgent')).toBe(1);
    expect(mapPriorityToNumber('high')).toBe(2);
    expect(mapPriorityToNumber('medium')).toBe(5);
    expect(mapPriorityToNumber('low')).toBe(8);
  });

  it('unknown/undefined → 기본값 5', () => {
    expect(mapPriorityToNumber(undefined)).toBe(5);
    expect(mapPriorityToNumber('whatever')).toBe(5);
  });
});

describe('P2: ACTION_ITEM 태그', () => {
  it('[ACTION_ITEM] 기본 파싱 → createTask 호출', async () => {
    vi.mocked(createTask).mockClear();
    const output = `
[LOG_EPISODE]
event_type: meeting
summary: 회의 합의 도달
[/LOG_EPISODE]
[ACTION_ITEM]
title: 뷰티 카테고리 벤치마크 채널 5개 추가 발굴
assignee: junho-researcher
priority: high
description: 현재 뷰티 벤치마크 3개 → 8개로 확대. 팔로워 5k+ 조건.
[/ACTION_ITEM]
    `.trim();

    const result = await processAgentOutput('minjun-ceo', output);
    expect(result.status).toBe('ok');
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '뷰티 카테고리 벤치마크 채널 5개 추가 발굴',
        assigned_to: 'junho-researcher',
        assigned_by: 'minjun-ceo',
        priority: 2, // high → 2
        description: expect.stringContaining('8개로 확대'),
      })
    );
  });

  it('복수 [ACTION_ITEM] → createTask 복수 호출', async () => {
    vi.mocked(createTask).mockClear();
    const output = `
[SAVE_MEMORY]
scope: global
memory_type: insight
content: 회의 결과 정리
[/SAVE_MEMORY]
[ACTION_ITEM]
title: 건강 카테고리 콘텐츠 3개 작성
assignee: hana-health-editor
priority: medium
description: 이번 주 건강 콘텐츠 부족
[/ACTION_ITEM]
[ACTION_ITEM]
title: 다이어트 키워드 수집
assignee: jiu-diet-editor
priority: low
description: 다이어트 관련 키워드 30개 수집
[/ACTION_ITEM]
    `.trim();

    const result = await processAgentOutput('minjun-ceo', output);
    expect(result.status).toBe('ok');
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        title: '건강 카테고리 콘텐츠 3개 작성',
        assigned_to: 'hana-health-editor',
        priority: 5, // medium → 5
      })
    );
    expect(createTask).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        title: '다이어트 키워드 수집',
        assigned_to: 'jiu-diet-editor',
        priority: 8, // low → 8
      })
    );
  });

  it('필수 필드(title/assignee) 누락 시 createTask 미호출', async () => {
    vi.mocked(createTask).mockClear();
    const output = `
[LOG_EPISODE]
event_type: decision
summary: 태스크 생성 시도
[/LOG_EPISODE]
[ACTION_ITEM]
priority: high
description: title과 assignee 없음
[/ACTION_ITEM]
[ACTION_ITEM]
title: assignee 없는 태스크
priority: medium
[/ACTION_ITEM]
[ACTION_ITEM]
assignee: bini-beauty-editor
priority: low
[/ACTION_ITEM]
    `.trim();

    const result = await processAgentOutput('minjun-ceo', output);
    expect(result.status).toBe('ok');
    expect(createTask).not.toHaveBeenCalled();
  });
});
