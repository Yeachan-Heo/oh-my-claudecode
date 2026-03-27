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
import { buildMeetingContext } from './meeting.js';
import { db as defaultDb } from '../db/index.js';
import { meetings } from '../db/schema.js';
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

  // 2. payload 타입에 따른 context 분기
  const payloadAny = payload as Record<string, unknown>;
  const meetingId = payloadAny.meetingId as string | undefined;
  const reportFrom = payloadAny.reportFrom as string | undefined;

  let contextSection: string;
  let missionSection: string;
  let eventType: string;

  if (meetingId) {
    // ─── 회의 참여 요청 ───
    const meetingContext = await loadMeetingContext(meetingId);
    contextSection = [
      '== 회의 컨텍스트 ==',
      meetingContext || '(회의 정보 없음)',
    ].join('\n');
    missionSection = [
      `== ${payload.sender}의 회의 소집 ==`,
      payload.originalMessage,
      '',
      '== 규칙 ==',
      '- 페르소나에 맞게 회의에 참여. 자기 전문 분야 관점에서 의견 제시.',
      '- 다른 참석자 의견에 반응 (동의/반박 근거 제시).',
      '- 전문가 톤 금지. 구어체로.',
      '- 합의에 도달하면 "[CONSENSUS] 결정: ..." 형식으로 발언.',
    ].join('\n');
    eventType = 'meeting';
  } else if (reportFrom) {
    // ─── 보고 수신 ───
    contextSection = '== 보고 수신 ==';
    missionSection = [
      `== ${reportFrom}의 보고 ==`,
      payload.originalMessage,
      '',
      '== 규칙 ==',
      '- 보고 내용을 검토하고 필요한 후속 조치를 결정.',
      '- 중요한 정보면 팀에 공유하거나 회의를 소집할 수 있음.',
      '- 간결하게 응답 (피드백 + 다음 단계).',
    ].join('\n');
    eventType = 'report';
  } else {
    // ─── 일반 채팅 ───
    const roomContext = payload.roomContext ?? await loadRoomContext(payload.roomId);
    contextSection = [
      '== 채팅방 최근 대화 ==',
      roomContext || '(대화 없음)',
    ].join('\n');
    missionSection = [
      `== ${payload.sender}의 메시지 ==`,
      payload.originalMessage,
      '',
      '== 규칙 ==',
      '- 페르소나에 맞게 응답. 짧고 자연스럽게 (1~3문장).',
      '- 전문가 톤 금지. 구어체로.',
      '- 작업 지시면 작업 계획을 답하고 실행 의지를 표현.',
      '- 의견을 물으면 자기 전문 분야 관점에서 솔직하게.',
    ].join('\n');
    eventType = 'chat';
  }

  // 3. 지시형 메시지 감지 — 행동 실행 프롬프트 추가
  const isDirective = /회의.*소집|회의.*열어|~해줘$|~해$|~하라$|~시켜$|소집해|분석해|수집해|실행해|만들어/
    .test(payload.originalMessage ?? '');

  // 4. P1 자발적 행동 도구 안내
  const PROJECT_ROOT = process.cwd();
  const toolSection = [
    '== 자발적 행동 도구 ==',
    '너는 대화뿐 아니라 직접 행동할 수 있다. 지시를 받으면 Bash 도구로 아래 명령을 실행하라.',
    '',
    '1. **에이전트에게 메시지 보내기**:',
    '```bash',
    `npx tsx ${PROJECT_ROOT}/_dispatch.ts '${agentId}' '{대상 에이전트 ID}' '{room_id}' '{메시지}'`,
    '```',
    '',
    '2. **CEO에게 보고** (출력에 태그 포함):',
    '```',
    '[REPORT_TO_CEO]',
    'summary: 작업 결과 한 줄 요약',
    '[/REPORT_TO_CEO]',
    '```',
  ];

  if (agent.role === 'ceo') {
    toolSection.push(
      '',
      '3. **회의 소집** (CEO 전용):',
      '```bash',
      `npx tsx ${PROJECT_ROOT}/_create-meeting.ts '${agentId}' '{회의타입}' '{안건}' '{참여자1,참여자2,...}'`,
      '```',
      '회의 타입: standup | planning | review | emergency | weekly | free',
    );
  }

  // 4.5. 파일 수정 권한 제한 (rank 기반)
  const filePermSection = (() => {
    if (agentId === 'sihun-owner') return ''; // 오너는 제한 없음
    if (agent.role === 'engineer') {
      return [
        '',
        '== 파일 수정 권한 (엔지니어) ==',
        '- 코드 수정 가능 (src/, scripts/, agent-town/). 단, 오너 승인 후 커밋.',
        '- `.claude/agents/taeho-engineer.md`, `agents/memory/*.md` 자유 수정.',
      ].join('\n');
    }
    if (agent.rank === 'executive' || agent.rank === 'lead') {
      return [
        '',
        '== 파일 수정 권한 (팀장급 이상) ==',
        '- **수정 가능**: `.claude/agents/${agentId}.md` (자기 페르소나), `agents/memory/*.md`, `ops/*.md`',
        '- **수정 금지**: `src/`, `scripts/`, `*.ts`, `*.tsx`, `*.js` — 코드 수정은 태호(엔지니어)에게 요청.',
        '- Write/Edit 도구로 코드 파일을 수정하지 마라.',
      ].join('\n');
    }
    return [
      '',
      '== 파일 수정 권한 (일반) ==',
      '- **수정 가능**: `.claude/agents/${agentId}.md` (자기 페르소나)만 수정 가능.',
      '- **수정 금지**: 그 외 모든 파일. 코드 수정은 태호(엔지니어)에게 요청.',
      '- Write/Edit 도구 사용 금지 (Read/Grep/Glob만 허용).',
    ].join('\n');
  })();

  // 5. 지시형이면 행동 규칙 추가
  const actionRule = isDirective ? [
    '',
    '== 행동 규칙 (지시를 받았으므로 반드시 따를 것) ==',
    '- 이 메시지는 **지시/명령**이다. 채팅 응답만 하지 말고 **실제 행동을 실행**하라.',
    '- 위 "자발적 행동 도구"의 Bash 명령을 실행하여 지시를 이행하라.',
    '- 행동 후 결과를 _respond.ts로 보고하라.',
  ].join('\n') : '';

  // 6. 프롬프트 구성
  const prompt = [
    `너는 BiniLab ${agent.name}이다. 역할: ${agent.role}`,
    `Read ${PROJECT_ROOT}/COMPANY.md`,
    `Read ${PROJECT_ROOT}/${agent.file}`,
    '',
    '== 에이전트 기억 ==',
    bootstrap.memories || '(없음)',
    '',
    ...toolSection,
    '',
    contextSection,
    filePermSection,
    '',
    missionSection,
    actionRule,
    '',
    '== 응답 저장 (필수) ==',
    '응답을 생성한 후, 반드시 아래 Bash 명령으로 DB에 저장하세요:',
    '```bash',
    `npx tsx ${PROJECT_ROOT}/_respond.ts '${payload.roomId}' '${agentId}' '여기에 응답 텍스트'`,
    '```',
    '',
    '[SAVE_MEMORY]',
    'scope: global',
    'type: insight',
    'importance: 0.5',
    'content: 이 대화에서 배운 인사이트 (없으면 "없음")',
    '[/SAVE_MEMORY]',
    '[LOG_EPISODE]',
    `event_type: ${eventType}`,
    `summary: ${payload.sender}에게 응답`,
    `details: {"room_id": "${payload.roomId}"}`,
    '[/LOG_EPISODE]',
  ].join('\n');

  return prompt;
}

// ─── Meeting Context Loader ──────────────────────────────────────

async function loadMeetingContext(meetingId: string): Promise<string> {
  try {
    const [meeting] = await defaultDb.select()
      .from(meetings)
      .where(eq(meetings.id, meetingId))
      .limit(1);

    if (!meeting) return '';

    const participants = (meeting.participants as string[]) ?? [];
    return buildMeetingContext({
      meetingId,
      config: {
        roomName: meeting.room_name,
        type: meeting.meeting_type as import('./meeting.js').MeetingType,
        agenda: meeting.agenda ?? '',
        participants,
        createdBy: meeting.created_by,
        consensusRequired: meeting.meeting_type !== 'standup',
      },
      messages: [],
      tokenEstimate: 0,
    });
  } catch (e) {
    console.error(`[processor] 회의 컨텍스트 로드 실패 (${meetingId}):`, (e as Error).message);
    return '';
  }
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
