import { NextRequest, NextResponse } from 'next/server';
import { getPosts } from '@/lib/binilab-api';

export async function GET(req: NextRequest) {
  try {
    const params = {
      status: req.nextUrl.searchParams.get('status') ?? undefined,
      category: req.nextUrl.searchParams.get('category') ?? undefined,
      sort: req.nextUrl.searchParams.get('sort') ?? 'recent',
      limit: Number(req.nextUrl.searchParams.get('limit') ?? 20),
      offset: Number(req.nextUrl.searchParams.get('offset') ?? 0),
    };
    const data = await getPosts(params);
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, { status: 500 });
  }
}
