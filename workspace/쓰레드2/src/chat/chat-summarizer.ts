/**
 * @file Summarize important conversations before deletion. Phase 4.
 */
import { db as defaultDb } from '../db/index.js';
import { agentMessages, agentMemories } from '../db/schema.js';
import { eq } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

const IMPORTANT_SENDERS = ['sihun-owner', 'minjun-ceo'];
const IMPORTANT_TYPES = ['directive', 'alert'];

export interface ConversationSummary {
  roomId: string;
  roomName: string;
  participants: string[];
  summary: string;
  decisions: string[];
  savedAt: Date;
}

export async function isImportantConversation(roomId: string, db: DbLike = defaultDb): Promise<boolean> {
  const messages = await db.select()
    .from(agentMessages)
    .where(eq(agentMessages.room_id, roomId))
    .limit(100);

  return messages.some((m: { sender: string; message_type: string | null }) =>
    IMPORTANT_SENDERS.includes(m.sender) ||
    IMPORTANT_TYPES.includes(m.message_type ?? '')
  );
}

export async function summarizeAndSave(
  roomId: string,
  roomName: string,
  db: DbLike = defaultDb,
): Promise<ConversationSummary | null> {
  const messages = await db.select()
    .from(agentMessages)
    .where(eq(agentMessages.room_id, roomId))
    .limit(100);

  if (messages.length === 0) return null;

  // Extract key info
  const participants = [...new Set(messages.map((m: { sender: string }) => m.sender))] as string[];
  const directives = messages.filter((m: { message_type: string | null }) => m.message_type === 'directive');
  const decisions = directives.map((m: { message: string }) => m.message.slice(0, 200));

  // Build summary from messages
  const summaryParts = [
    `채팅방: ${roomName}`,
    `참여자: ${participants.join(', ')}`,
    `메시지 수: ${messages.length}`,
    `기간: ${messages[0]?.created_at?.toISOString()} ~ ${messages[messages.length - 1]?.created_at?.toISOString()}`,
  ];

  if (decisions.length > 0) {
    summaryParts.push(`주요 지시: ${decisions.join('; ')}`);
  }

  const summary: ConversationSummary = {
    roomId,
    roomName,
    participants,
    summary: summaryParts.join('\n'),
    decisions,
    savedAt: new Date(),
  };

  // Save to agent_memories for each participant
  for (const agentId of participants) {
    await db.insert(agentMemories).values({
      agent_id: agentId,
      scope: 'global',
      memory_type: 'fact',
      content: `[대화 요약] ${summary.summary}`,
      importance: 0.6,
      source: `chat_summary:${roomId}`,
    });
  }

  return summary;
}
