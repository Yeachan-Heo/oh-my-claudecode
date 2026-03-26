import { NextRequest, NextResponse } from 'next/server';
import { getPerformanceSummary } from '@/lib/binilab-api';

export async function GET(req: NextRequest) {
  try {
    const period = (req.nextUrl.searchParams.get('period') ?? '7d') as '7d' | '30d' | 'today';
    const data = await getPerformanceSummary(period);
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, { status: 500 });
  }
}
