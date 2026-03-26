/**
 * @file Message retention policy — 60/90 day cleanup. Phase 4.
 */
import { db as defaultDb } from '../db/index.js';
import { agentMessages, chatRooms } from '../db/schema.js';
import { sql, eq, and, lt, ne } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

const RETENTION_60_DAYS = 60 * 24 * 60 * 60 * 1000;
const RETENTION_90_DAYS = 90 * 24 * 60 * 60 * 1000;
const RETENTION_30_DAYS = 30 * 24 * 60 * 60 * 1000;

export interface CleanupResult {
  deletedMessages: number;
  archivedRooms: number;
}

export async function cleanupOldMessages(db: DbLike = defaultDb): Promise<CleanupResult> {
  const now = Date.now();
  const cutoff60 = new Date(now - RETENTION_60_DAYS);
  const cutoff90 = new Date(now - RETENTION_90_DAYS);
  const cutoff30 = new Date(now - RETENTION_30_DAYS);

  let deletedMessages = 0;

  // 1. Delete 60-day-old DM/meeting/team messages (preserve directives)
  const result60 = await db.delete(agentMessages)
    .where(and(
      lt(agentMessages.created_at, cutoff60),
      ne(agentMessages.message_type, 'directive'),
      sql`${agentMessages.room_id} IN (
        SELECT id FROM chat_rooms WHERE type IN ('dm', 'meeting', 'team')
      )`,
    ));
  deletedMessages += result60?.rowCount ?? 0;

  // 2. Delete 90-day-old announcement/owner messages (preserve directives)
  const result90 = await db.delete(agentMessages)
    .where(and(
      lt(agentMessages.created_at, cutoff90),
      ne(agentMessages.message_type, 'directive'),
      sql`${agentMessages.room_id} IN (
        SELECT id FROM chat_rooms WHERE type IN ('announcement', 'owner')
      )`,
    ));
  deletedMessages += result90?.rowCount ?? 0;

  // 3. Delete 30-day-old pipeline messages (no room_id)
  const result30 = await db.delete(agentMessages)
    .where(and(
      lt(agentMessages.created_at, cutoff30),
      ne(agentMessages.message_type, 'directive'),
      sql`${agentMessages.room_id} IS NULL`,
    ));
  deletedMessages += result30?.rowCount ?? 0;

  // 4. Archive rooms with no recent messages (60 days)
  const archivedResult = await db.update(chatRooms)
    .set({ status: 'archived', archived_at: new Date() })
    .where(and(
      eq(chatRooms.status, 'active'),
      lt(chatRooms.last_message_at, cutoff60),
    ));

  return {
    deletedMessages,
    archivedRooms: archivedResult?.rowCount ?? 0,
  };
}
