import { NextRequest, NextResponse } from 'next/server';
import { handleAlertAction } from '@/lib/binilab-api';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const data = await handleAlertAction(id, body.action, body.comment);
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, { status: 500 });
  }
}
