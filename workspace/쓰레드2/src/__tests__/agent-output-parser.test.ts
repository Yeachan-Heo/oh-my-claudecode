/**
 * @file agent-output-parser.test.ts — 에이전트 출력 태그 파싱 + Phase Gate TDD
 *
 * 핵심 케이스:
 *  - 태그 파싱 (SAVE_MEMORY, LOG_EPISODE, CREATE_STRATEGY_VERSION)
 *  - DB 저장 확인
 *  - missing_tags → 재시도 2회 → quarantine
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/index.js', () => ({ db: {} }));

// memory.ts는 db를 import time에 실행하지 않으므로 mock 후 import
vi.mock('../db/memory.js', () => ({
  saveMemory: vi.fn().mockResolvedValue({ id: 'mem-1' }),
  logEpisode: vi.fn().mockResolvedValue({ id: 'ep-1' }),
}));

vi.mock('../db/strategy-archive.js', () => ({
  createStrategyVersion: vi.fn().mockResolvedValue({ id: 'sv-1', version: 'v2.0' }),
}));

import {
  parseTag,
  parseMeta,
  processAgentOutput,
  enforceTagGate,
  ProcessResult,
} from '../orchestrator/agent-output-parser.js';
import { saveMemory, logEpisode } from '../db/memory.js';
import { createStrategyVersion } from '../db/strategy-archive.js';

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
    expect(result).toBe(output);
    expect(retryFn).not.toHaveBeenCalled();
  });

  it('1회 실패 후 재시도 성공 — retryFn 1회 호출', async () => {
    const firstOutput = '태그 없는 출력';
    const retryOutput = `[SAVE_MEMORY]\nscope: global\nmemory_type: insight\ncontent: 재시도 성공\n[/SAVE_MEMORY]`;
    const retryFn = vi.fn().mockResolvedValue(retryOutput);

    const result = await enforceTagGate('bini', firstOutput, retryFn);
    expect(retryFn).toHaveBeenCalledTimes(1);
    expect(result).toBe(retryOutput);
  });

  it('2회 실패 후 재시도 2회 성공 — retryFn 2회 호출', async () => {
    const noTag = '태그 없음';
    const retryOutput = `[LOG_EPISODE]\nevent_type: decision\nsummary: 성공\n[/LOG_EPISODE]`;
    const retryFn = vi.fn()
      .mockResolvedValueOnce(noTag)
      .mockResolvedValueOnce(retryOutput);

    const result = await enforceTagGate('bini', noTag, retryFn);
    expect(retryFn).toHaveBeenCalledTimes(2);
    expect(result).toBe(retryOutput);
  });

  it('3회 모두 실패 — quarantine: logEpisode(system, error) 호출 후 마지막 출력 반환', async () => {
    vi.mocked(logEpisode).mockClear();
    const noTag = '계속 태그 없음';
    const retryFn = vi.fn().mockResolvedValue(noTag);

    const result = await enforceTagGate('bini', noTag, retryFn);
    expect(retryFn).toHaveBeenCalledTimes(2);
    expect(result).toBe(noTag); // 출력은 반환
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

    await enforceTagGate('bini', noTag, retryFn);
    expect(saveMemory).not.toHaveBeenCalled();
  });
});
