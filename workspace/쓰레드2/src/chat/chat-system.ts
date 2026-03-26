/**
 * @file Chat system — room CRUD + message handling.
 * Wraps meeting.ts for 'meeting' type rooms. Phase 4.
 */
import { db as defaultDb } from '../db/index.js';
import { chatRooms, chatParticipants, agentMessages } from '../db/schema.js';
import { eq, and, isNull, desc, sql } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

// Types
export type RoomType = 'dm' | 'meeting' | 'announcement' | 'owner' | 'team';
export type RoomStatus = 'active' | 'archived';
export type ParticipantRole = 'owner' | 'admin' | 'member';

export interface CreateRoomInput {
  type: RoomType;
  name: string;
  participants: string[];
  createdBy: string;
  meetingConfig?: Record<string, unknown>;
}

export interface ChatRoom {
  id: string;
  name: string;
  type: RoomType;
  status: RoomStatus;
  created_by: string;
  meeting_id: string | null;
  metadata: Record<string, unknown>;
  last_message_at: Date | null;
  message_count: number;
  created_at: Date;
}

// Permission rules
const MEETING_CREATORS = ['sihun-owner', 'minjun-ceo'];
const ANNOUNCEMENT_CREATORS = ['sihun-owner', 'minjun-ceo'];

function validateCreatePermission(input: CreateRoomInput): void {
  if (input.type === 'dm' && input.participants.length !== 2) {
    throw new Error('DM requires exactly 2 participants');
  }
  if (input.type === 'meeting' && !MEETING_CREATORS.includes(input.createdBy)) {
    throw new Error('Only CEO or owner can create meetings');
  }
  if (input.type === 'announcement' && !ANNOUNCEMENT_CREATORS.includes(input.createdBy)) {
    throw new Error('Only CEO or owner can create announcements');
  }
  if (input.type === 'owner' && input.createdBy !== 'sihun-owner') {
    throw new Error('Only owner can create owner channels');
  }
}

// CRUD operations
export async function createRoom(input: CreateRoomInput, db: DbLike = defaultDb): Promise<ChatRoom> {
  validateCreatePermission(input);

  const roomId = crypto.randomUUID();
  const [room] = await db.insert(chatRooms).values({
    id: roomId,
    name: input.type === 'dm' ? `${input.participants[0]} ↔ ${input.participants[1]}` : input.name,
    type: input.type,
    status: 'active',
    created_by: input.createdBy,
    metadata: input.meetingConfig ?? {},
  }).returning();

  // Add participants
  const participantRows = input.participants.map((agentId) => ({
    id: crypto.randomUUID(),
    room_id: roomId,
    agent_id: agentId,
    role: (agentId === input.createdBy ? 'owner' : 'member') as ParticipantRole,
  }));

  if (participantRows.length > 0) {
    await db.insert(chatParticipants).values(participantRows);
  }

  return room as ChatRoom;
}

export async function getRooms(filters?: {
  agentId?: string;
  type?: RoomType;
  status?: RoomStatus;
  limit?: number;
  offset?: number;
}, db: DbLike = defaultDb) {
  // Build base query
  const query = db.select().from(chatRooms)
    .where(eq(chatRooms.status, filters?.status ?? 'active'))
    .orderBy(desc(chatRooms.last_message_at))
    .limit(filters?.limit ?? 20)
    .offset(filters?.offset ?? 0);

  const rooms = await query;

  // If filtering by agent, filter in-memory (simpler than join)
  if (filters?.agentId) {
    const participantRooms = await db.select({ room_id: chatParticipants.room_id })
      .from(chatParticipants)
      .where(and(
        eq(chatParticipants.agent_id, filters.agentId),
        isNull(chatParticipants.left_at),
      ));
    const roomIds = new Set(participantRooms.map((p: { room_id: string }) => p.room_id));
    return rooms.filter((r: { id: string }) => roomIds.has(r.id));
  }

  return rooms;
}

export async function getRoom(roomId: string, db: DbLike = defaultDb) {
  const [room] = await db.select().from(chatRooms).where(eq(chatRooms.id, roomId));
  return room ?? null;
}

export async function getRoomParticipants(roomId: string, db: DbLike = defaultDb) {
  return db.select().from(chatParticipants)
    .where(and(eq(chatParticipants.room_id, roomId), isNull(chatParticipants.left_at)));
}

export async function archiveRoom(roomId: string, db: DbLike = defaultDb) {
  await db.update(chatRooms)
    .set({ status: 'archived', archived_at: new Date() })
    .where(eq(chatRooms.id, roomId));
}

export async function joinRoom(roomId: string, agentId: string, db: DbLike = defaultDb) {
  await db.insert(chatParticipants).values({
    id: crypto.randomUUID(),
    room_id: roomId,
    agent_id: agentId,
    role: 'member',
  }).onConflictDoNothing();
}

export async function leaveRoom(roomId: string, agentId: string, db: DbLike = defaultDb) {
  await db.update(chatParticipants)
    .set({ left_at: new Date() })
    .where(and(
      eq(chatParticipants.room_id, roomId),
      eq(chatParticipants.agent_id, agentId),
    ));
}

export async function updateRoomStats(roomId: string, db: DbLike = defaultDb) {
  await db.update(chatRooms)
    .set({
      last_message_at: new Date(),
      message_count: sql`${chatRooms.message_count} + 1`,
    })
    .where(eq(chatRooms.id, roomId));
}

// sendChatMessage — wraps existing sendMessage with room stats update
export async function sendChatMessage(
  sender: string,
  roomId: string,
  message: string,
  options?: {
    mentions?: string[];
    replyTo?: string;
    messageType?: string;
    context?: Record<string, unknown>;
  },
  db: DbLike = defaultDb,
) {
  const msgId = crypto.randomUUID();
  const [row] = await db.insert(agentMessages).values({
    id: msgId,
    sender,
    recipient: 'room',
    channel: 'chat',
    message,
    context: options?.context ?? null,
    message_type: options?.messageType ?? 'chat',
    room_id: roomId,
    reply_to: options?.replyTo ?? null,
    mentions: options?.mentions ?? [],
  }).returning();

  await updateRoomStats(roomId, db);
  return row;
}
