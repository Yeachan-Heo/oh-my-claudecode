import { NextRequest, NextResponse } from 'next/server';
import { getAgentStatuses } from '@/lib/binilab-api';

export async function GET(_req: NextRequest) {
  try {
    const data = await getAgentStatuses();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, { status: 500 });
  }
}
