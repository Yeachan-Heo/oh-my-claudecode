/**
 * message-dispatcher.ts — 대시보드 채팅 메시지 의도 분류 + 에이전트 디스패치
 *
 * 흐름:
 *   1. classifyMessage() — @멘션/회의키워드/일반 대화 분류
 *   2. selectRelevantAgents() — 메시지 내용 기반 관련 에이전트 선택
 *   3. generateAgentResponse() — pending_response 마커를 DB에 기록
 *   4. dispatchMessage() — 메인 진입점
 */

import { db } from '../db/index.js';
import { agentMessages } from '../db/schema.js';
import { sendMessage } from '../db/agent-messages.js';
import { createTask } from '../db/agent-tasks.js';
import { bootstrapAgent } from './agent-session.js';
import { AGENT_REGISTRY } from './agent-spawner.js';
import { desc, eq } from 'drizzle-orm';

// 에이전트 이름 → ID 매핑 (한국어 이름 지원)
const NAME_TO_ID: Record<string, string> = {
  '민준': 'minjun-ceo',
  '서연': 'seoyeon-analyst',
  '빈이': 'bini-beauty-editor',
  '하나': 'hana-health-editor',
  '소라': 'sora-lifestyle-editor',
  '지우': 'jiu-diet-editor',
  '도윤': 'doyun-qa',
  '준호': 'junho-researcher',
  '태호': 'taeho-engineer',
  '지현': 'jihyun-marketing-lead',
};

export interface DispatchResult {
  type: 'chat' | 'meeting' | 'task';
  targetAgents: string[];    // 응답할 에이전트 ID 목록
  action?: string;           // task일 때 작업 내용
  responses: AgentResponse[];
}

export interface AgentResponse {
  agentId: string;
  agentName: string;
  message: string;
  savedToDb: boolean;
}

// 1. 메시지 의도 분류
export function classifyMessage(
  message: string,
  sender: string,
  roomType: string,
  participants: string[],
): { type: 'chat' | 'meeting' | 'task'; targets: string[]; action: string } {
  const msg = message.trim();

  // @멘션 감지 → task
  const mentionMatch = msg.match(/@(\S+)/);
  if (mentionMatch) {
    const mentionName = mentionMatch[1];
    const agentId = NAME_TO_ID[mentionName] ??
      Object.keys(AGENT_REGISTRY).find(id => id.includes(mentionName.toLowerCase()));
    if (agentId) {
      const action = msg.replace(/@\S+\s*/, '').trim();
      return { type: 'task', targets: [agentId], action };
    }
  }

  // 회의 키워드 → meeting
  if (/회의\s*(시작|하자|해)|전체\s*의견|다들\s*어떻게|스탠드업/.test(msg)) {
    const targets = participants.filter(p => p !== sender && p !== 'sihun-owner');
    return { type: 'meeting', targets, action: msg };
  }

  // 일반 대화 → chat (채팅방 참여자 중 1~2명이 응답)
  const targets = selectRelevantAgents(msg, participants, sender);
  return { type: 'chat', targets, action: msg };
}

// 내용 기반 관련 에이전트 선택
function selectRelevantAgents(message: string, participants: string[], sender: string): string[] {
  const msg = message.toLowerCase();
  const candidates: string[] = [];

  if (/수집|채널|트렌드|크롤/.test(msg)) candidates.push('junho-researcher');
  if (/분석|데이터|성과|지표/.test(msg)) candidates.push('seoyeon-analyst');
  if (/전략|방향|결정|배분/.test(msg)) candidates.push('minjun-ceo');
  if (/포스트|글|콘텐츠|작성|뷰티/.test(msg)) candidates.push('bini-beauty-editor');
  if (/검수|qa|체크|검토/.test(msg)) candidates.push('doyun-qa');
  if (/건강|영양|약/.test(msg)) candidates.push('hana-health-editor');
  if (/생활|살림|인테리어/.test(msg)) candidates.push('sora-lifestyle-editor');
  if (/다이어트|식단|운동/.test(msg)) candidates.push('jiu-diet-editor');
  if (/코드|버그|시스템|에러/.test(msg)) candidates.push('taeho-engineer');
  if (/마케팅|기획|캠페인/.test(msg)) candidates.push('jihyun-marketing-lead');

  // 매칭 없으면 CEO가 대답
  if (candidates.length === 0) candidates.push('minjun-ceo');

  // 참여자 목록에 있는 에이전트만 필터
  const valid = candidates.filter(c => participants.includes(c) && c !== sender);

  // 최대 2명
  return valid.slice(0, 2);
}

// 2. 채팅방 최근 대화 context 로드
async function loadRoomContext(roomId: string, limit: number = 10): Promise<string> {
  const messages = await db.select()
    .from(agentMessages)
    .where(eq(agentMessages.room_id, roomId))
    .orderBy(desc(agentMessages.created_at))
    .limit(limit);

  // 시간순 정렬 (오래된 것 먼저)
  messages.reverse();

  return messages.map(m => `[${m.sender}] ${m.message}`).join('\n');
}

// 3. 에이전트 응답 생성 + DB 저장
async function generateAgentResponse(
  agentId: string,
  message: string,
  roomContext: string,
  roomId: string,
  _messageType: 'chat' | 'task_result' | 'report',
): Promise<AgentResponse> {
  const agent = AGENT_REGISTRY[agentId];
  if (!agent) return { agentId, agentName: agentId, message: '', savedToDb: false };

  // DB에서 기억 로드 (에러 무시)
  await bootstrapAgent(agentId).catch(() => null);

  // pending_response 마커 저장
  // 오케스트레이터(Claude Code 메인 세션)가 polling으로 이 마커를 감지해 실제 AI 응답 생성
  await sendMessage(
    'system',
    agentId,
    'dispatch',
    `[PENDING_RESPONSE] room=${roomId} message="${message.slice(0, 200)}"`,
    { roomId, originalMessage: message, roomContext: roomContext.slice(-500) },
    'task_assign',
    undefined,
    roomId,
  );

  return {
    agentId,
    agentName: agent.name,
    message: `[대기 중] ${agent.name}이(가) 응답을 준비하고 있습니다...`,
    savedToDb: true,
  };
}

// 4. 메인 디스패치 함수
export async function dispatchMessage(
  message: string,
  sender: string,
  roomId: string,
  roomType: string,
  participants: string[],
): Promise<DispatchResult> {
  // 의도 분류
  const classification = classifyMessage(message, sender, roomType, participants);

  // 채팅방 context 로드
  const roomContext = await loadRoomContext(roomId);

  const responses: AgentResponse[] = [];

  if (classification.type === 'task') {
    // task 모드: agent_tasks 생성 + 에이전트에게 pending_response
    const targetAgent = classification.targets[0];

    if (targetAgent) {
      await createTask({
        title: classification.action.slice(0, 100),
        description: `대시보드 채팅에서 ${sender}가 지시: ${classification.action}`,
        assigned_to: targetAgent,
        assigned_by: sender,
        priority: 7,
        input_data: { roomId, message: classification.action, roomContext },
      });

      const resp = await generateAgentResponse(
        targetAgent, classification.action, roomContext, roomId, 'task_result',
      );
      responses.push(resp);
    }

  } else if (classification.type === 'meeting') {
    // meeting 모드: 각 참여자에게 pending_response
    for (const agentId of classification.targets) {
      const resp = await generateAgentResponse(
        agentId, message, roomContext, roomId, 'report',
      );
      responses.push(resp);
    }

  } else {
    // chat 모드: 관련 에이전트 1~2명에게 pending_response
    for (const agentId of classification.targets) {
      const resp = await generateAgentResponse(
        agentId, message, roomContext, roomId, 'chat',
      );
      responses.push(resp);
    }
  }

  return {
    type: classification.type,
    targetAgents: classification.targets,
    action: classification.action,
    responses,
  };
}
