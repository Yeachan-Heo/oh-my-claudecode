/**
 * @file src/orchestrator/meeting.ts
 * S-5+6: 회의 오케스트레이터 — 자유토론 + 합의 기반 종료
 *
 * 핵심 원칙:
 * - 자유토론 (라운드 로빈 아님)
 * - maxTurns 없음 — tokenBudget이 유일한 안전장치
 * - 합의 도달 시 종료, 정보공유 회의는 전원 1회 발언 후 종료
 * - Devil's Advocate: 주간 전략회의(weekly) 전용, 매 10턴
 */

import { db } from '../db/index.js';
import { meetings, agentEpisodes } from '../db/schema.js';
import { eq } from 'drizzle-orm';

// ─── 타입 정의 ──────────────────────────────────────────────────────────────

export type MeetingType =
  | 'standup'
  | 'planning'
  | 'review'
  | 'emergency'
  | 'weekly'
  | 'free';

/**
 * 회의 설정.
 * maxTurns 없음 — tokenBudget으로만 제어.
 */
export interface MeetingConfig {
  roomName: string;
  type: MeetingType;
  agenda: string;
  participants: string[];     // 에이전트 ID 목록
  createdBy: string;
  consensusRequired: boolean; // true: 합의 때까지, false: 정보 공유
  tokenBudget?: number;       // 기본값: 타입별 DEFAULT_TOKEN_BUDGET
}

export interface Message {
  agentId: string;
  content: string;
  turnIndex: number;
  timestamp: Date;
  isAdvocate?: boolean;       // Devil's Advocate 발언 여부
}

export interface MeetingTranscript {
  meetingId: string;
  config: MeetingConfig;
  messages: Message[];
  summary?: string;           // sliding window 압축 요약
  summaryUpToTurn?: number;   // 요약이 커버하는 마지막 턴 인덱스
  tokenEstimate: number;      // 현재 예상 토큰
}

export interface MeetingResult {
  meetingId: string;
  status: 'consensus' | 'ceo_decided' | 'token_budget_exceeded' | 'info_shared';
  decisions: string[];
  transcript: MeetingTranscript;
  totalTurns: number;
}

// ─── 상수 ───────────────────────────────────────────────────────────────────

const _DEFAULT_TOKEN_BUDGET: Record<MeetingType, number> = {
  standup:   100_000,
  planning:   80_000,
  review:     50_000,
  emergency:  80_000,
  weekly:    200_000,
  free:      100_000,
};

/** 토큰 추정: 메시지당 평균 300토큰 */
const TOKENS_PER_MESSAGE = 300;

/** 합의 체크 주기 (매 N턴) */
const CONSENSUS_CHECK_INTERVAL = 5;

/** Devil's Advocate 주기 (매 N턴) — weekly 전용 */
const DEVILS_ADVOCATE_INTERVAL = 10;

/** 연속 발언 제한 */
const MAX_CONSECUTIVE_TURNS = 3;

/** sliding window: 최근 N턴은 전체 보존 */
const SLIDING_WINDOW_SIZE = 15;

// ─── 핵심 로직 ──────────────────────────────────────────────────────────────

/**
 * 다음 발언자 선택 (자유토론 규칙).
 *
 * 우선순위:
 * 1. @멘션된 에이전트 (최우선)
 * 2. 아직 발언 안 한 에이전트
 * 3. 가장 오래 발언 안 한 에이전트 (단, 연속 3회 금지)
 */
export function selectNextSpeaker(
  transcript: Message[],
  participants: string[],
): string {
  if (participants.length === 0) throw new Error('참석자가 없습니다');
  if (participants.length === 1) return participants[0]!;

  const lastMessage = transcript[transcript.length - 1];

  // 1. @멘션 우선
  if (lastMessage) {
    const mentioned = extractMentions(lastMessage.content, participants);
    if (mentioned.length > 0) return mentioned[0]!;
  }

  // 2. 아직 발언 안 한 에이전트
  const spoken = new Set(transcript.map((m) => m.agentId));
  const notSpoken = participants.filter((p) => !spoken.has(p));
  if (notSpoken.length > 0) return notSpoken[0]!;

  // 3. 연속 3회 제한을 지키며 가장 오래 침묵한 에이전트
  return leastRecentSpeaker(transcript, participants);
}

/**
 * 마지막 발언이 가장 오래된 에이전트 선택 (연속 3회 금지).
 */
export function leastRecentSpeaker(
  transcript: Message[],
  participants: string[],
): string {
  // 가장 최근 발언 턴 인덱스 (없으면 -1)
  const lastSpokenAt: Record<string, number> = {};
  for (const msg of transcript) {
    lastSpokenAt[msg.agentId] = msg.turnIndex;
  }

  // 연속 발언 수 계산
  const consecutiveCount: Record<string, number> = {};
  for (const p of participants) {
    consecutiveCount[p] = 0;
  }
  for (let i = transcript.length - 1; i >= 0; i--) {
    const agentId = transcript[i]!.agentId;
    const currentCount = consecutiveCount[agentId];
    if (currentCount === undefined) break;
    if (i === transcript.length - 1 || transcript[i + 1]!.agentId === agentId) {
      consecutiveCount[agentId] = currentCount + 1;
    } else {
      break;
    }
  }

  // 연속 3회 초과 제외, 나머지 중 가장 오래된 발언자
  const eligible = participants.filter(
    (p) => (consecutiveCount[p] ?? 0) < MAX_CONSECUTIVE_TURNS,
  );

  // eligible이 없으면 (모두 연속 3회) 강제로 마지막 발언자 외 누구라도
  const pool = eligible.length > 0 ? eligible : participants.filter(
    (p) => p !== transcript[transcript.length - 1]?.agentId,
  );

  if (pool.length === 0) return participants[0]!;

  // 가장 오래 침묵한 에이전트 (lastSpokenAt 낮은 순)
  return pool.sort((a, b) => (lastSpokenAt[a] ?? -1) - (lastSpokenAt[b] ?? -1))[0]!;
}

/**
 * 메시지에서 @멘션된 참석자 추출.
 */
export function extractMentions(content: string, participants: string[]): string[] {
  const mentionPattern = /@(\w[\w-]*)/g;
  const matches = [...content.matchAll(mentionPattern)].map((m) => m[1]!.toLowerCase());
  return participants.filter((p) => matches.includes(p.toLowerCase()));
}

/**
 * 합의 체크.
 * 마지막 N턴에서 반박/이의 없이 동의 표현이 지배적이면 합의 도달.
 */
export function checkConsensus(transcript: Message[], participants: string[]): boolean {
  if (transcript.length < participants.length) return false;

  const recentMessages = transcript.slice(-CONSENSUS_CHECK_INTERVAL);

  const DISAGREEMENT_PATTERNS = [
    /반대|반박|아니|틀렸|문제|위험|재검토|다시|잠깐|안 돼|안돼/,
    /but\s|however\s|disagree|concern|issue|problem/i,
  ];

  const AGREEMENT_PATTERNS = [
    /동의|찬성|맞아|좋아|좋습니다|그렇군|진행|합의|확정|결정/,
    /agree|sounds\s+good|proceed|confirm/i,
  ];

  const disagreements = recentMessages.filter((m) =>
    DISAGREEMENT_PATTERNS.some((p) => p.test(m.content)),
  ).length;

  const agreements = recentMessages.filter((m) =>
    AGREEMENT_PATTERNS.some((p) => p.test(m.content)),
  ).length;

  return disagreements === 0 && agreements >= Math.ceil(recentMessages.length * 0.6);
}

/**
 * Devil's Advocate: 랜덤 에이전트에게 반론 임무 부여 (weekly 전용).
 * 반환: 반론 임무를 받은 에이전트 ID, 없으면 null
 */
export function assignDevilsAdvocate(
  transcript: Message[],
  participants: string[],
  meetingType: MeetingType,
): string | null {
  if (meetingType !== 'weekly') return null;
  if (transcript.length === 0 || transcript.length % DEVILS_ADVOCATE_INTERVAL !== 0) return null;

  // 최근 발언자 제외, 랜덤 선택
  const lastSpeaker = transcript[transcript.length - 1]?.agentId;
  const eligible = participants.filter((p) => p !== lastSpeaker);
  if (eligible.length === 0) return participants[0] ?? null;

  const idx = Math.floor(Math.random() * eligible.length);
  return eligible[idx] ?? null;
}

/**
 * Sliding window 압축.
 * 15턴 이전 메시지를 요약 텍스트로 대체.
 */
export function compressTranscript(transcript: MeetingTranscript): MeetingTranscript {
  const messages = transcript.messages;
  if (messages.length <= SLIDING_WINDOW_SIZE) return transcript;

  const oldMessages = messages.slice(0, messages.length - SLIDING_WINDOW_SIZE);
  const recentMessages = messages.slice(-SLIDING_WINDOW_SIZE);

  // 이전 요약이 있으면 합산
  const prevSummary = transcript.summary ?? '';
  const newSummaryContent = oldMessages
    .map((m) => `[${m.agentId}] ${m.content.slice(0, 100)}`)
    .join('\n');

  const combinedSummary = prevSummary
    ? `${prevSummary}\n---\n${newSummaryContent}`
    : newSummaryContent;

  return {
    ...transcript,
    messages: recentMessages,
    summary: combinedSummary,
    summaryUpToTurn: oldMessages[oldMessages.length - 1]?.turnIndex,
    tokenEstimate: estimateTokens(recentMessages, combinedSummary),
  };
}

function estimateTokens(messages: Message[], summary?: string): number {
  const messageTokens = messages.length * TOKENS_PER_MESSAGE;
  const summaryTokens = summary ? Math.ceil(summary.length / 4) : 0;
  return messageTokens + summaryTokens;
}

// ─── 회의 DB 관리 ────────────────────────────────────────────────────────────

/**
 * 회의 시작: meetings 테이블에 레코드 생성.
 */
export async function startMeeting(config: MeetingConfig): Promise<MeetingTranscript> {
  const [meeting] = await db
    .insert(meetings)
    .values({
      room_name: config.roomName,
      meeting_type: config.type,
      agenda: config.agenda,
      participants: config.participants,
      status: 'active',
      created_by: config.createdBy,
    })
    .returning({ id: meetings.id });

  if (!meeting) throw new Error('회의 생성 실패');

  return {
    meetingId: meeting.id,
    config,
    messages: [],
    tokenEstimate: 0,
  };
}

/**
 * 회의 종료: status → 'concluded', decisions 저장.
 */
export async function concludeMeeting(
  meetingId: string,
  decisions: string[],
  status: MeetingResult['status'],
): Promise<void> {
  await db
    .update(meetings)
    .set({
      status: 'concluded',
      decisions: { decisions, terminationReason: status },
      concluded_at: new Date(),
    })
    .where(eq(meetings.id, meetingId));

  await db.insert(agentEpisodes).values({
    agent_id: 'system',
    event_type: 'meeting',
    summary: `회의 종료 (${status}): ${decisions[0] ?? '결정 없음'}`,
    details: { meetingId, decisions, status },
  });
}

/**
 * 회의 메시지 추가 (in-memory transcript에 append).
 * DB 저장은 agent_messages를 통해 처리됨 (room_id 연결).
 */
export function addMessage(
  transcript: MeetingTranscript,
  agentId: string,
  content: string,
  isAdvocate = false,
): MeetingTranscript {
  const turnIndex = transcript.messages.length;
  const newMessage: Message = {
    agentId,
    content,
    turnIndex,
    timestamp: new Date(),
    isAdvocate,
  };

  const updated: MeetingTranscript = {
    ...transcript,
    messages: [...transcript.messages, newMessage],
    tokenEstimate: transcript.tokenEstimate + TOKENS_PER_MESSAGE,
  };

  // 15턴마다 sliding window 압축
  if (updated.messages.length > SLIDING_WINDOW_SIZE && updated.messages.length % SLIDING_WINDOW_SIZE === 0) {
    return compressTranscript(updated);
  }

  return updated;
}

// ─── 회의 실행 엔진 ──────────────────────────────────────────────────────────

/**
 * 회의 실행 컨텍스트 생성.
 * 에이전트 스폰 시 이 컨텍스트를 프롬프트에 주입.
 */
export function buildMeetingContext(transcript: MeetingTranscript): string {
  const { config, messages, summary, summaryUpToTurn } = transcript;

  const lines: string[] = [
    `# 회의: ${config.roomName}`,
    `타입: ${config.type} | 안건: ${config.agenda}`,
    `참석자: ${config.participants.join(', ')}`,
    `합의 필요: ${config.consensusRequired ? '예' : '아니오'}`,
    '',
  ];

  if (summary) {
    lines.push(`## 이전 대화 요약 (턴 0~${summaryUpToTurn ?? '?'})`);
    lines.push(summary);
    lines.push('');
  }

  lines.push('## 최근 대화');
  for (const msg of messages) {
    const prefix = msg.isAdvocate ? `[반론임무] ${msg.agentId}` : msg.agentId;
    lines.push(`[턴${msg.turnIndex}] **${prefix}**: ${msg.content}`);
  }

  if (config.consensusRequired) {
    lines.push('');
    lines.push('> 합의에 도달하면 "[CONSENSUS] 결정: ..." 형식으로 발언하세요.');
  }

  return lines.join('\n');
}

/**
 * 정보공유 회의 종료 조건: 모든 참석자가 1회 이상 발언했는지.
 */
export function allParticipantsSpoken(
  transcript: MeetingTranscript,
): boolean {
  const spoken = new Set(transcript.messages.map((m) => m.agentId));
  return transcript.config.participants.every((p) => spoken.has(p));
}

/**
 * CEO 강제 정리 프롬프트 생성.
 * 합의 미달 3회 연속 또는 tokenBudget 초과 시 사용.
 */
export function buildCeoForcedDecisionPrompt(
  transcript: MeetingTranscript,
  reason: 'consensus_failed' | 'token_budget',
): string {
  const ctx = buildMeetingContext(transcript);
  const reasonText =
    reason === 'token_budget'
      ? '토큰 예산 초과로 회의를 마무리해야 합니다.'
      : '합의 시도 3회 연속 실패로 CEO 최종 결정이 필요합니다.';

  return [
    ctx,
    '',
    `## CEO 최종 결정 요청`,
    reasonText,
    '지금까지 논의를 바탕으로 최종 결정을 내리고 "[FINAL_DECISION] 결정: ..." 형식으로 발언하세요.',
    '결정은 구체적인 액션 아이템을 포함해야 합니다.',
  ].join('\n');
}

/**
 * CEO의 최종 결정 추출.
 */
export function extractFinalDecision(ceoOutput: string): string[] {
  const decisions: string[] = [];

  // [FINAL_DECISION] 태그
  const finalPattern = /\[FINAL_DECISION\]\s*결정:\s*(.+?)(?:\n|$)/g;
  for (const match of ceoOutput.matchAll(finalPattern)) {
    decisions.push(match[1]!.trim());
  }

  // [CONSENSUS] 태그
  const consensusPattern = /\[CONSENSUS\]\s*결정:\s*(.+?)(?:\n|$)/g;
  for (const match of ceoOutput.matchAll(consensusPattern)) {
    decisions.push(match[1]!.trim());
  }

  return decisions;
}

// ─── 회의 통계 ──────────────────────────────────────────────────────────────

export interface MeetingStats {
  totalTurns: number;
  speakerBreakdown: Record<string, number>;
  tokenEstimate: number;
  consensusAttempts: number;
}

export function getMeetingStats(transcript: MeetingTranscript): MeetingStats {
  const speakerBreakdown: Record<string, number> = {};
  for (const msg of transcript.messages) {
    speakerBreakdown[msg.agentId] = (speakerBreakdown[msg.agentId] ?? 0) + 1;
  }

  return {
    totalTurns: transcript.messages.length,
    speakerBreakdown,
    tokenEstimate: transcript.tokenEstimate,
    consensusAttempts: Math.floor(transcript.messages.length / CONSENSUS_CHECK_INTERVAL),
  };
}
