/**
 * @file agent-messages - AI 에이전트 간 메시지 CRUD 헬퍼.
 *
 * Usage:
 *   import { sendMessage, getMessages, markAsRead, getUnreadMessages } from './db/agent-messages.js';
 */

import { db as defaultDb } from './index.js';
import { agentMessages } from './schema.js';
import { eq, and, gte, lt, desc } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

/**
 * 메시지 전송 — agent_messages 테이블에 저장.
 */
export async function sendMessage(
  sender: string,
  recipient: string,
  channel: string,
  message: string,
  context?: Record<string, unknown>,
  messageType?: string,
  taskId?: string,
  roomId?: string,
  db: DbLike = defaultDb,
) {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(agentMessages)
    .values({
      id,
      sender,
      recipient,
      channel,
      message,
      context: context ?? null,
      read_by: [],
      message_type: messageType ?? 'report',
      task_id: taskId ?? null,
      room_id: roomId ?? null,
    })
    .returning();
  return row;
}

/**
 * room_id로 회의 메시지 조회 (회의방 그루핑).
 */
export async function getMessagesByRoomId(roomId: string, db: DbLike = defaultDb) {
  return db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.room_id, roomId))
    .orderBy(desc(agentMessages.created_at));
}

/**
 * task_id로 해당 실행의 모든 메시지 조회.
 */
export async function getMessagesByTaskId(taskId: string, db: DbLike = defaultDb) {
  return db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.task_id, taskId))
    .orderBy(desc(agentMessages.created_at));
}

/**
 * message_type으로 메시지 필터 조회 (선택적 since 날짜 필터).
 */
export async function getMessagesByType(
  messageType: string,
  since?: Date,
  db: DbLike = defaultDb,
) {
  const conditions = [eq(agentMessages.message_type, messageType)];
  if (since) conditions.push(gte(agentMessages.created_at, since));
  return db
    .select()
    .from(agentMessages)
    .where(and(...conditions))
    .orderBy(desc(agentMessages.created_at));
}

/**
 * 특정 task_id의 최신 핸드오프 메시지 조회.
 */
export async function getLatestHandoff(taskId: string, db: DbLike = defaultDb) {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.task_id, taskId), eq(agentMessages.message_type, 'handoff')))
    .orderBy(desc(agentMessages.created_at))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 메시지 조회 — channel, sender, date 필터 지원.
 */
export async function getMessages(
  filters: { channel?: string; sender?: string; date?: string; limit?: number },
  db: DbLike = defaultDb,
) {
  const conditions = [];

  if (filters.channel) conditions.push(eq(agentMessages.channel, filters.channel));
  if (filters.sender) conditions.push(eq(agentMessages.sender, filters.sender));
  if (filters.date) {
    const start = new Date(filters.date + 'T00:00:00.000Z');
    const end = new Date(filters.date + 'T23:59:59.999Z');
    conditions.push(gte(agentMessages.created_at, start));
    conditions.push(lt(agentMessages.created_at, end));
  }

  const query = db
    .select()
    .from(agentMessages)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(agentMessages.created_at));

  return filters.limit ? query.limit(filters.limit) : query;
}

/**
 * 메시지 읽음 처리 — read_by 배열에 agentName 추가 (중복 방지).
 */
export async function markAsRead(
  messageId: string,
  agentName: string,
  db: DbLike = defaultDb,
) {
  const [row] = await db
    .select({ read_by: agentMessages.read_by })
    .from(agentMessages)
    .where(eq(agentMessages.id, messageId));

  if (!row) return;

  const current = (row.read_by as string[]) ?? [];
  if (current.includes(agentName)) return;

  await db
    .update(agentMessages)
    .set({ read_by: [...current, agentName] })
    .where(eq(agentMessages.id, messageId));
}

/**
 * 읽지 않은 메시지 조회 — recipient가 agentName이고 read_by에 없는 것.
 */
export async function getUnreadMessages(agentName: string, db: DbLike = defaultDb) {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.recipient, agentName))
    .orderBy(desc(agentMessages.created_at));

  return rows.filter((r: { read_by: unknown }) => {
    const readBy = (r.read_by as string[]) ?? [];
    return !readBy.includes(agentName);
  });
}
