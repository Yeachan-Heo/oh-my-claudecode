import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  try {
    const db = createAdminClient();
    const agentId = req.nextUrl.searchParams.get('agent_id');
    const type = req.nextUrl.searchParams.get('type');
    const limit = Number(req.nextUrl.searchParams.get('limit') ?? 20);

    let query = db.from('chat_rooms').select(`
      *,
      chat_participants(agent_id, role)
    `).eq('status', 'active').order('last_message_at', { ascending: false, nullsFirst: false }).limit(limit);

    if (type) query = query.eq('type', type);

    const { data, error } = await query;
    if (error) throw error;

    // Filter by agent_id if provided
    let rooms = data ?? [];
    if (agentId) {
      rooms = rooms.filter((r: any) =>
        r.chat_participants?.some((p: any) => p.agent_id === agentId)
      );
    }

    return NextResponse.json({
      rooms: rooms.map((r: any) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        status: r.status,
        last_message_at: r.last_message_at,
        message_count: r.message_count,
        participants: r.chat_participants?.map((p: any) => p.agent_id) ?? [],
      })),
      total: rooms.length,
    });
  } catch (error) {
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const db = createAdminClient();
    const body = await req.json();
    const { type, name, participants, created_by } = body;

    const { data: room, error } = await db.from('chat_rooms').insert({
      name: type === 'dm' ? `${participants[0]} ↔ ${participants[1]}` : name,
      type,
      status: 'active',
      created_by,
    }).select().single();

    if (error) throw error;

    // Add participants
    if (participants?.length) {
      await db.from('chat_participants').insert(
        participants.map((agentId: string) => ({
          room_id: room.id,
          agent_id: agentId,
          role: agentId === created_by ? 'owner' : 'member',
        }))
      );
    }

    return NextResponse.json({ room });
  } catch (error) {
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, { status: 500 });
  }
}
