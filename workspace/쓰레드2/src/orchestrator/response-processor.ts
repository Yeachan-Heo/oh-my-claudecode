/**
 * @file response-processor.ts — PENDING_RESPONSE 처리 루프
 *
 * dispatcher가 DB에 남긴 PENDING_RESPONSE 마커를 polling하여
 * 에이전트 응답 프롬프트를 생성하고 채팅방에 결과를 저장한다.
 *
 * 흐름:
 *   1. DB에서 PENDING_RESPONSE 마커 조회 (channel='dispatch', message_type='task_assign', message LIKE '[PENDING_RESPONSE]%')
 *   2. 각 마커에 대해:
 *      a. payload에서 roomId, originalMessage, sender 추출
 *      b. 해당 채팅방의 최근 10개 메시지 context 로드
 *      c. 대상 에이전트의 기억 로드 (bootstrapAgent)
 *      d. 에이전트 프롬프트 구성 (페르소나 + 기억 + 대화 context + 임무)
 *      e. Agent() 서브에이전트로 응답 생성 (호출부에서 처리)
 *      f. 응답을 해당 채팅방에 agent_messages로 저장 (room_id 포함)
 *      g. output-parser로 태그 파싱 → 기억 저장
 *      h. PENDING_RESPONSE 마커를 처리 완료로 업데이트 (message_type → 'processed')
 *   3. 처리 완료 로그
 */

import 'dotenv/config';
import { db } from '../db/index.js';
import { agentMessages } from '../db/schema.js';
import { sendMessage } from '../db/agent-messages.js';
import { bootstrapAgent } from './agent-session.js';
import { AGENT_REGISTRY } from './agent-spawner.js';
import { eq, and, like, desc } from 'drizzle-orm';

// ─── Types ────────────────────────────────────────────────────

export interface PendingResponse {
  id: string;
  recipient: string;  // 대상 에이전트 ID
  payload: {
    roomId: string;
    originalMessage: string;
    sender: string;
    roomContext?: string;
  };
}

// ─── Query ────────────────────────────────────────────────────

/**
 * PENDING_RESPONSE 마커 조회.
 * channel='dispatch', message_type='task_assign', message LIKE '[PENDING_RESPONSE]%'
 */
export async function getPendingResponses(): Promise<PendingResponse[]> {
  const rows = await db.select()
    .from(agentMessages)
    .where(and(
      eq(agentMessages.channel, 'dispatch'),
      eq(agentMessages.message_type, 'task_assign'),
      like(agentMessages.message, '[PENDING_RESPONSE]%'),
    ))
    .orderBy(agentMessages.created_at)
    .limit(10);

  return rows.map(r => ({
    id: r.id,
    recipient: r.recipient,
    payload: (r.payload as PendingResponse['payload']) ?? {
      roomId: '',
      originalMessage: '',
      sender: '',
    },
  }));
}

// ─── Room Context ─────────────────────────────────────────────

/**
 * 채팅방 최근 대화 로드 (dispatch 채널 제외).
 */
async function loadRoomContext(roomId: string, limit: number = 10): Promise<string> {
  const messages = await db.select()
    .from(agentMessages)
    .where(eq(agentMessages.room_id, roomId))
    .orderBy(desc(agentMessages.created_at))
    .limit(limit);

  return messages
    .reverse()
    .filter(m => m.channel !== 'dispatch')
    .map(m => `[${m.sender}] ${m.message}`)
    .join('\n');
}

// ─── Prompt Builder ───────────────────────────────────────────

/**
 * 단일 PENDING_RESPONSE에 대한 에이전트 프롬프트 생성.
 * 실제 Agent() 스폰은 호출부(오케스트레이터)에서 처리한다.
 *
 * @returns 프롬프트 문자열, 알 수 없는 에이전트이면 빈 문자열
 */
export async function processOneResponse(pending: PendingResponse): Promise<string> {
  const { recipient: agentId, payload } = pending;
  const agent = AGENT_REGISTRY[agentId];
  if (!agent) {
    console.log(`[processor] 알 수 없는 에이전트: ${agentId}`);
    return '';
  }

  console.log(`[processor] ${agent.name}(${agentId}) 응답 생성 중...`);

  // 1. 기억 로드
  const bootstrap = await bootstrapAgent(agentId);

  // 2. 채팅방 context
  const roomContext = payload.roomContext ?? await loadRoomContext(payload.roomId);

  // 3. 프롬프트 구성
  const prompt = [
    `너는 BiniLab ${agent.name}이다. 역할: ${agent.role}`,
    `Read ${process.cwd()}/COMPANY.md`,
    `Read ${process.cwd()}/${agent.file}`,
    '',
    '== 에이전트 기억 ==',
    bootstrap.memories || '(없음)',
    '',
    '== 채팅방 최근 대화 ==',
    roomContext || '(대화 없음)',
    '',
    `== ${payload.sender}의 메시지 ==`,
    payload.originalMessage,
    '',
    '== 규칙 ==',
    '- 페르소나에 맞게 응답. 짧고 자연스럽게 (1~3문장).',
    '- 전문가 톤 금지. 구어체로.',
    '- 작업 지시면 작업 계획을 답하고 실행 의지를 표현.',
    '- 의견을 물으면 자기 전문 분야 관점에서 솔직하게.',
    '',
    '[SAVE_MEMORY]',
    'scope: global',
    'type: insight',
    'importance: 0.5',
    'content: 이 대화에서 배운 인사이트 (없으면 "없음")',
    '[/SAVE_MEMORY]',
    '[LOG_EPISODE]',
    'event_type: chat',
    `summary: ${payload.sender}에게 응답`,
    `details: {"room_id": "${payload.roomId}"}`,
    '[/LOG_EPISODE]',
  ].join('\n');

  return prompt;
}

// ─── Persistence ──────────────────────────────────────────────

/**
 * PENDING 마커를 처리 완료로 표시 (message_type → 'processed').
 */
export async function markAsProcessed(pendingId: string): Promise<void> {
  await db.update(agentMessages)
    .set({ message_type: 'processed' })
    .where(eq(agentMessages.id, pendingId));
}

/**
 * 에이전트 응답을 채팅방에 저장.
 */
export async function saveResponseToRoom(
  agentId: string,
  roomId: string,
  response: string,
): Promise<void> {
  const agent = AGENT_REGISTRY[agentId];
  await sendMessage(
    agentId,
    'sihun-owner',
    'meeting',
    response,
    undefined,
    'report',
    undefined,
    roomId,
  );
  console.log(`[processor] ${agent?.name ?? agentId} 응답 저장 완료 (room: ${roomId})`);
}

// ─── Main Loop ────────────────────────────────────────────────

/**
 * 전체 처리 루프 (1회 실행).
 * 실제 Agent() 스폰은 호출부(오케스트레이터)에서 처리하며,
 * 이 함수는 프롬프트를 반환하고 마커를 업데이트한다.
 *
 * @returns 처리된 건수
 */
export async function processAllPending(): Promise<number> {
  const pendings = await getPendingResponses();
  if (pendings.length === 0) {
    console.log('[processor] 대기 중인 응답 없음');
    return 0;
  }

  console.log(`[processor] ${pendings.length}건 처리 시작`);
  let processed = 0;

  for (const pending of pendings) {
    try {
      const prompt = await processOneResponse(pending);
      if (!prompt) {
        await markAsProcessed(pending.id);
        continue;
      }

      // 프롬프트 출력 — 오케스트레이터가 Agent()로 스폰 후 saveResponseToRoom 호출
      console.log(`[processor] 프롬프트 준비 완료 (id: ${pending.id}, agent: ${pending.recipient})`);

      await markAsProcessed(pending.id);
      processed++;
    } catch (err) {
      console.error(`[processor] ${pending.recipient} 처리 실패:`, (err as Error).message);
    }
  }

  console.log(`[processor] ${processed}/${pendings.length}건 처리 완료`);
  return processed;
}

// ─── CLI ──────────────────────────────────────────────────────

if (process.argv[1]?.includes('response-processor')) {
  processAllPending()
    .then(n => { console.log(`완료: ${n}건`); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
