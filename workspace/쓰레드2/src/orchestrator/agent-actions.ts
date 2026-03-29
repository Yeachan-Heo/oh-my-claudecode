/**
 * @file agent-actions.ts — 에이전트 자발적 행동 핵심 로직
 *
 * P1: 에이전트가 스스로 행동을 개시하는 기능의 서비스 레이어.
 * CLI 스크립트(_dispatch.ts, _create-meeting.ts)와 output-parser가 이 모듈을 공유한다.
 *
 * 제공 함수:
 *   - dispatchToAgent(): 다른 에이전트에게 PENDING_RESPONSE 마커 생성
 *   - createAgentMeeting(): 회의 생성 + 참여자에게 PENDING_RESPONSE 발송
 *   - reportToCeo(): CEO에게 보고 메시지 dispatch
 */

import { db } from '../db/index.js';
import { agentMessages, chatRooms, chatParticipants, meetings } from '../db/schema.js';
import { eq, and, gt } from 'drizzle-orm';
import { startMeeting } from './meeting.js';
import { canCreateRoom } from './agent-spawner.js';
import type { MeetingType } from './meeting.js';

/** 중복 회의 방지 윈도우 (5분) */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

// ─── dispatchToAgent ─────────────────────────────────────────

export interface DispatchOptions {
  sender: string;
  target: string;
  roomId: string;
  message: string;
  /** 추가 payload 필드 (meetingId, reportFrom 등) */
  extra?: Record<string, unknown>;
}

/**
 * 대상 에이전트에게 PENDING_RESPONSE 마커를 생성한다.
 * watch-pending.ts가 이 마커를 감지하여 tmux 에이전트에 프롬프트를 전달한다.
 * extra.dmRoom=true이면 DM 채팅방도 함께 생성 (대시보드 연동).
 */
export async function dispatchToAgent(opts: DispatchOptions): Promise<string> {
  // DM 채팅방 자동 생성
  if (opts.extra?.dmRoom) {
    const participants = (opts.extra.dmParticipants as string[]) ?? [opts.sender, opts.target];
    await ensureChatRoom({
      roomId: opts.roomId,
      name: `${opts.sender} → ${opts.target}`,
      type: 'dm',
      createdBy: opts.sender,
      participants,
    });
  }

  const id = crypto.randomUUID();
  await db.insert(agentMessages).values({
    id,
    sender: 'system',
    recipient: opts.target,
    channel: 'dispatch',
    message: `[PENDING_RESPONSE] room=${opts.roomId}`,
    message_type: 'task_assign',
    room_id: opts.roomId,
    read_by: [],
    payload: {
      roomId: opts.roomId,
      originalMessage: opts.message,
      sender: opts.sender,
      ...opts.extra,
    },
  });
  return id;
}

// ─── createAgentMeeting ──────────────────────────────────────

export interface CreateMeetingOptions {
  creator: string;
  type: MeetingType;
  agenda: string;
  participants: string[];
}

export interface CreateMeetingResult {
  meetingId: string;
  dispatched: string[];
}

/**
 * 회의를 생성하고 각 참여자에게 PENDING_RESPONSE를 발송한다.
 * meeting.ts의 startMeeting()으로 DB 레코드를 생성한 뒤,
 * chat_rooms + chat_participants도 함께 생성하여 대시보드에서 볼 수 있게 한다.
 * 각 참여자에게 회의 참여 프롬프트를 dispatch한다.
 */
export async function createAgentMeeting(
  opts: CreateMeetingOptions,
): Promise<CreateMeetingResult> {
  // 0. 권한 검증
  if (!canCreateRoom(opts.creator, 'meeting')) {
    throw new Error(`[agent-actions] ${opts.creator}은(는) 회의 생성 권한이 없습니다 (rank: member). executive 또는 lead만 가능.`);
  }

  // 0.5. 중복 회의 방지 — 같은 creator + 같은 agenda로 최근 5분 이내 회의가 있으면 스킵
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
  const recentDuplicates = await db.select({ id: meetings.id })
    .from(meetings)
    .where(
      and(
        eq(meetings.created_by, opts.creator),
        eq(meetings.agenda, opts.agenda),
        gt(meetings.created_at, cutoff),
      ),
    )
    .limit(1);

  if (recentDuplicates.length > 0) {
    console.log(`[agent-actions] 중복 회의 감지 — creator=${opts.creator}, agenda="${opts.agenda}", existing=${recentDuplicates[0]!.id}. 스킵.`);
    return { meetingId: recentDuplicates[0]!.id, dispatched: [] };
  }

  // 1. meetings 테이블에 생성
  const transcript = await startMeeting({
    roomName: `meeting-${Date.now()}`,
    type: opts.type,
    agenda: opts.agenda,
    participants: opts.participants,
    createdBy: opts.creator,
    consensusRequired: opts.type !== 'standup',
  });

  const meetingId = transcript.meetingId;

  // 2. chat_rooms + chat_participants 생성 (대시보드 연동)
  await ensureChatRoom({
    roomId: meetingId,
    name: `[${opts.type}] ${opts.agenda}`,
    type: 'meeting',
    createdBy: opts.creator,
    participants: opts.participants,
    meetingId,
  });

  // 3. 각 참여자에게 PENDING_RESPONSE 발송
  const dispatched: string[] = [];
  for (const participant of opts.participants) {
    if (participant === opts.creator) continue; // 소집자 자신은 제외
    await dispatchToAgent({
      sender: opts.creator,
      target: participant,
      roomId: meetingId,
      message: `[회의 소집] ${opts.creator}이(가) "${opts.agenda}" 안건으로 ${opts.type} 회의를 소집했습니다. 참여하여 의견을 제시해주세요.`,
      extra: {
        meetingId,
        meetingType: opts.type,
        agenda: opts.agenda,
        participants: opts.participants,
      },
    });
    dispatched.push(participant);
  }

  return { meetingId, dispatched };
}

// ─── reportToCeo ─────────────────────────────────────────────

export interface ReportOptions {
  sender: string;
  summary: string;
  roomId?: string;
}

/**
 * CEO(minjun-ceo)에게 보고 메시지를 dispatch한다.
 * roomId가 없으면 자동으로 'report-{timestamp}' 형태의 room을 생성한다.
 * chat_rooms도 생성하여 대시보드에서 보고 내역을 볼 수 있게 한다.
 */
export async function reportToCeo(opts: ReportOptions): Promise<string> {
  const roomId = opts.roomId ?? `report-${Date.now()}`;

  // chat_rooms 생성 (대시보드 연동)
  await ensureChatRoom({
    roomId,
    name: `[보고] ${opts.sender}`,
    type: 'dm',
    createdBy: opts.sender,
    participants: [opts.sender, 'minjun-ceo'],
  });

  return dispatchToAgent({
    sender: opts.sender,
    target: 'minjun-ceo',
    roomId,
    message: `[보고] ${opts.sender}: ${opts.summary}`,
    extra: { reportFrom: opts.sender },
  });
}

// ─── Chat Room Helper ────────────────────────────────────────

interface EnsureChatRoomOptions {
  roomId: string;
  name: string;
  type: string;
  createdBy: string;
  participants: string[];
  meetingId?: string;
}

/**
 * chat_rooms + chat_participants 생성 (이미 존재하면 스킵).
 * 대시보드에서 에이전트 간 대화를 볼 수 있게 한다.
 */
async function ensureChatRoom(opts: EnsureChatRoomOptions): Promise<void> {
  try {
    // 이미 존재하는지 확인
    const existing = await db.select({ id: chatRooms.id })
      .from(chatRooms)
      .where(eq(chatRooms.id, opts.roomId))
      .limit(1);

    if (existing.length > 0) return;

    // chat_rooms 생성
    await db.insert(chatRooms).values({
      id: opts.roomId,
      name: opts.name,
      type: opts.type,
      status: 'active',
      created_by: opts.createdBy,
      meeting_id: opts.meetingId ?? null,
      message_count: 0,
    });

    // chat_participants 생성
    for (const agentId of opts.participants) {
      await db.insert(chatParticipants).values({
        id: crypto.randomUUID(),
        room_id: opts.roomId,
        agent_id: agentId,
        role: agentId === opts.createdBy ? 'owner' : 'member',
      });
    }
  } catch (e) {
    // chat room 생성 실패해도 dispatch 자체는 계속 진행
    console.error(`[agent-actions] chat room 생성 실패 (${opts.roomId}):`, (e as Error).message);
  }
}
