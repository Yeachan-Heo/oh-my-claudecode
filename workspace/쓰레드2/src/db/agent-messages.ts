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
    })
    .returning();
  return row;
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
