/**
 * @file agent-output-parser.ts — 에이전트 출력 태그 파싱 + DB 저장 + Phase Gate
 *
 * C2 해결: 에이전트 출력의 구조화 태그를 파싱하여 DB에 자동 저장.
 * Phase Gate: 태그 없으면 2회 재시도 → 실패 시 quarantine (기억 미저장).
 *
 * 지원 태그:
 *   [SAVE_MEMORY] ... [/SAVE_MEMORY]           — 의미 기억 저장
 *   [LOG_EPISODE] ... [/LOG_EPISODE]            — 에피소드 기록
 *   [CREATE_STRATEGY_VERSION] ... [/...]        — 전략 버전 생성 (CEO 전용)
 *
 * 태그 내부 포맷 (key: value, JSON, 숫자 지원):
 *   scope: global
 *   content: "뷰티 카테고리 ROI 높음"
 *   importance: 0.8
 *   details: {"reason": "성과 기반"}
 */

import { saveMemory, logEpisode } from '../db/memory.js';
import { createStrategyVersion } from '../db/strategy-archive.js';
import { dispatchToAgent, createAgentMeeting, reportToCeo } from './agent-actions.js';
import type { MeetingType } from './meeting.js';
import type { OrientResult, DirectiveResult } from './types.js';

// ─── Types ────────────────────────────────────────────────────

export interface ProcessResult {
  status: 'ok' | 'missing_tags' | 'quarantined';
  savedCount?: number;
  output?: string;
}

// ─── Tag Parsing ──────────────────────────────────────────────

/**
 * 정규식으로 태그 내부 텍스트를 모두 추출.
 * @param output - 에이전트 출력 전체
 * @param pattern - 캡처 그룹 1에 내용이 담기는 정규식 (global flag 필수)
 */
export function parseTag(output: string, pattern: RegExp): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  // RegExp.exec with global flag iterates through all matches
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  while ((match = re.exec(output)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

/**
 * 태그 내부 텍스트를 key-value 객체로 파싱.
 *
 * 지원 형식:
 *   key: "string value"    → string (따옴표 제거)
 *   key: string value      → string
 *   key: 0.8               → number
 *   key: {"json": "value"} → object
 */
export function parseMeta(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (!key || !raw) continue;

    // JSON object/array
    if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
      try {
        result[key] = JSON.parse(raw);
        continue;
      } catch {
        // fall through to string
      }
    }

    // Number
    const num = Number(raw);
    if (!isNaN(num) && raw !== '') {
      result[key] = num;
      continue;
    }

    // String (따옴표 제거)
    result[key] = raw.replace(/^["']|["']$/g, '');
  }

  return result;
}

// ─── Core ─────────────────────────────────────────────────────

/**
 * 에이전트 출력에서 태그를 파싱하고 DB에 저장.
 *
 * SAVE_MEMORY 또는 LOG_EPISODE 태그가 하나도 없으면 'missing_tags' 반환.
 * CREATE_STRATEGY_VERSION은 선택적 (없어도 ok).
 */
export async function processAgentOutput(
  agentId: string,
  output: string,
): Promise<ProcessResult> {
  const memories = parseTag(output, /\[SAVE_MEMORY\]([\s\S]*?)\[\/SAVE_MEMORY\]/g);
  const episodes = parseTag(output, /\[LOG_EPISODE\]([\s\S]*?)\[\/LOG_EPISODE\]/g);
  const strategies = parseTag(output, /\[CREATE_STRATEGY_VERSION\]([\s\S]*?)\[\/CREATE_STRATEGY_VERSION\]/g);

  // 필수 태그 체크 (SAVE_MEMORY or LOG_EPISODE 중 하나 이상)
  if (memories.length === 0 && episodes.length === 0) {
    return { status: 'missing_tags', output };
  }

  // DB 저장
  for (const raw of memories) {
    const meta = parseMeta(raw);
    await saveMemory({
      agentId,
      scope: (meta.scope as string) || 'global',
      memoryType: (meta.memory_type as string) || 'insight',
      content: (meta.content as string) || raw,
      importance: typeof meta.importance === 'number' ? meta.importance : 0.5,
      source: meta.source as string | undefined,
    });
  }

  for (const raw of episodes) {
    const meta = parseMeta(raw);
    await logEpisode({
      agentId,
      eventType: (meta.event_type as string) || 'decision',
      summary: (meta.summary as string) || raw,
      details: meta.details as Record<string, unknown> | undefined,
    });
  }

  for (const raw of strategies) {
    const meta = parseMeta(raw);
    if (meta.version && meta.strategy) {
      await createStrategyVersion({
        version: meta.version as string,
        parent_version: meta.parent_version as string | undefined,
        strategy: meta.strategy as Record<string, unknown>,
      });
    }
  }

  // ─── P1: 자발적 행동 태그 처리 ─────────────────────────────
  const meetingTags = parseTag(output, /\[CREATE_MEETING\]([\s\S]*?)\[\/CREATE_MEETING\]/g);
  const messageTags = parseTag(output, /\[SEND_MESSAGE\]([\s\S]*?)\[\/SEND_MESSAGE\]/g);
  const reportTags = parseTag(output, /\[REPORT_TO_CEO\]([\s\S]*?)\[\/REPORT_TO_CEO\]/g);

  for (const raw of meetingTags) {
    const meta = parseMeta(raw);
    const type = (meta.type as string) || 'free';
    const agenda = (meta.agenda as string) || '';
    const participantsRaw = meta.participants;
    const participants = Array.isArray(participantsRaw)
      ? participantsRaw as string[]
      : typeof participantsRaw === 'string'
        ? participantsRaw.split(',').map(p => p.trim()).filter(Boolean)
        : [];
    if (agenda && participants.length > 0) {
      await createAgentMeeting({
        creator: agentId,
        type: type as MeetingType,
        agenda,
        participants: participants.includes(agentId) ? participants : [agentId, ...participants],
      });
    }
  }

  for (const raw of messageTags) {
    const meta = parseMeta(raw);
    const to = (meta.to as string) || '';
    const msg = (meta.message as string) || '';
    if (to && msg) {
      const dmRoomId = `dm-${agentId}-${to}-${Date.now()}`;
      await dispatchToAgent({
        sender: agentId,
        target: to,
        roomId: dmRoomId,
        message: msg,
        extra: { dmRoom: true, dmParticipants: [agentId, to] },
      });
    }
  }

  for (const raw of reportTags) {
    const meta = parseMeta(raw);
    const summary = (meta.summary as string) || raw;
    if (summary) {
      await reportToCeo({ sender: agentId, summary });
    }
  }

  return {
    status: 'ok',
    savedCount: memories.length + episodes.length,
  };
}

// ─── OODA Result Extractors ──────────────────────────────────

/**
 * [ORIENT_RESULT]...[/ORIENT_RESULT] 태그에서 OrientResult JSON 추출.
 * JSON 파싱 실패 또는 필수 필드 누락 시 null 반환.
 */
export function extractOrientResult(output: string): OrientResult | null {
  const matches = parseTag(output, /\[ORIENT_RESULT\]([\s\S]*?)\[\/ORIENT_RESULT\]/g);
  if (matches.length === 0) return null;

  try {
    const parsed = JSON.parse(matches[0]);
    // 필수 필드 검증
    if (
      typeof parsed.bottleneck !== 'string' ||
      typeof parsed.evidence !== 'string' ||
      !Array.isArray(parsed.patterns) ||
      !Array.isArray(parsed.recommendations) ||
      typeof parsed.confidence !== 'number'
    ) {
      return null;
    }
    return parsed as OrientResult;
  } catch {
    return null;
  }
}

/**
 * [DIRECTIVE_RESULT]...[/DIRECTIVE_RESULT] 태그에서 DirectiveResult JSON 추출.
 * JSON 파싱 실패 또는 필수 필드 누락 시 null 반환.
 */
export function extractDirectiveResult(output: string): DirectiveResult | null {
  const matches = parseTag(output, /\[DIRECTIVE_RESULT\]([\s\S]*?)\[\/DIRECTIVE_RESULT\]/g);
  if (matches.length === 0) return null;

  try {
    const parsed = JSON.parse(matches[0]);
    // 필수 필드 검증
    if (
      typeof parsed.total_posts !== 'number' ||
      !Array.isArray(parsed.slots) ||
      typeof parsed.rationale !== 'string'
    ) {
      return null;
    }
    // slots 내부 검증
    for (const slot of parsed.slots) {
      if (
        typeof slot.category !== 'string' ||
        typeof slot.format !== 'string' ||
        typeof slot.hook !== 'string' ||
        typeof slot.brief !== 'string'
      ) {
        return null;
      }
    }
    return parsed as DirectiveResult;
  } catch {
    return null;
  }
}

// ─── Phase Gate ───────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const MISSING_TAGS_REASON = 'SAVE_MEMORY 또는 LOG_EPISODE 태그 누락';

/**
 * Phase Gate: 태그 없으면 retryFn으로 2회 재시도.
 * retryFn에 (attempt, reason)을 전달하여 재시도 맥락을 제공.
 * 재시도 간 지수 백오프 (attempt * 500ms).
 * 3회 모두 실패 시 quarantine (logEpisode error + 기억 미저장).
 */
export async function enforceTagGate(
  agentId: string,
  output: string,
  retryFn: (attempt: number, reason: string) => Promise<string>,
): Promise<{ output: string; quarantined: boolean }> {
  let result = await processAgentOutput(agentId, output);
  if (result.status === 'ok') return { output, quarantined: false };

  // 재시도 1회
  await delay(1 * 500);
  const retry1 = await retryFn(1, MISSING_TAGS_REASON);
  result = await processAgentOutput(agentId, retry1);
  if (result.status === 'ok') return { output: retry1, quarantined: false };

  // 재시도 2회
  await delay(2 * 500);
  const retry2 = await retryFn(2, MISSING_TAGS_REASON);
  result = await processAgentOutput(agentId, retry2);
  if (result.status === 'ok') return { output: retry2, quarantined: false };

  // quarantine — DB 기억 기록 없이 에러 에피소드만 남김
  await logEpisode({
    agentId: 'system',
    eventType: 'error',
    summary: `${agentId} quarantined: 태그 미작성 3회`,
    details: { agentId, attempts: 3 },
  });

  return { output: retry2, quarantined: true };
}
