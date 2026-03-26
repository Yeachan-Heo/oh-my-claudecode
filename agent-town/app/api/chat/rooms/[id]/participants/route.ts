import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: roomId } = await params;
    const { agent_id } = await req.json();
    const db = createAdminClient();
    await db.from('chat_participants').insert({ room_id: roomId, agent_id, role: 'member' });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: String(error) } },
      { status: 500 },
    );
  }
}
