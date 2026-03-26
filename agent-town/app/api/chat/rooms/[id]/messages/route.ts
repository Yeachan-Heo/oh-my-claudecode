import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: roomId } = await params;
    const db = createAdminClient();
    const limit = Number(req.nextUrl.searchParams.get('limit') ?? 50);

    const { data, error } = await db
      .from('agent_messages')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw error;

    return NextResponse.json({
      messages: (data ?? []).map(m => ({
        id: m.id,
        sender: m.sender,
        message: m.message,
        message_type: m.message_type,
        reply_to: m.reply_to,
        mentions: m.mentions,
        created_at: m.created_at,
      })),
      has_more: (data?.length ?? 0) >= limit,
    });
  } catch (error) {
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, { status: 500 });
  }
}
