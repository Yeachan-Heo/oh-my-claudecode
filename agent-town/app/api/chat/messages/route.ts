import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const db = createAdminClient();
    const body = await req.json();
    const { room_id, sender, message, message_type, mentions, reply_to } = body;

    if (!room_id || !sender || !message) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'room_id, sender, message required' } }, { status: 400 });
    }

    const { data, error } = await db.from('agent_messages').insert({
      id: crypto.randomUUID(),
      sender,
      recipient: 'room',
      channel: 'chat',
      message,
      message_type: message_type ?? 'chat',
      room_id,
      reply_to: reply_to ?? null,
      mentions: mentions ?? [],
      read_by: [],
    }).select().single();

    if (error) throw error;

    // Update room stats
    await db.from('chat_rooms')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', room_id);

    return NextResponse.json({ message: data });
  } catch (error) {
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, { status: 500 });
  }
}
