import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = createAdminClient();
    await db
      .from('chat_rooms')
      .update({ status: 'archived', archived_at: new Date().toISOString() })
      .eq('id', id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: String(error) } },
      { status: 500 },
    );
  }
}
