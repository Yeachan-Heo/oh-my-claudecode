#!/usr/bin/env tsx
/**
 * trend-fetcher.ts — X(트위터) 한국 트렌딩 키워드 수집
 *
 * Apify의 Twitter Trends Proxy Scraper를 사용하여
 * 한국 실시간 트렌드 99개를 수집한다.
 *
 * Usage:
 *   npx tsx src/scraper/trend-fetcher.ts
 *
 * 비용: ~$0.04/회
 */

import 'dotenv/config';
import { ApifyClient } from 'apify-client';
import { db } from '../db/index.js';
import { trendKeywords } from '../db/schema.js';
import { generateId } from '../utils/id.js';

// ─── Types ───────────────────────────────────────────────

export interface TrendItem {
  trend: string;
  volume: string | null;     // "12.3K tweets" or null
  timePeriod: string | null;  // "Live", "1 hour ago", etc.
  time: string | null;        // ISO timestamp if available
}

// ─── Config ──────────────────────────────────────────────

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR_ID = 'karamelo/twitter-trends-scraper';
const COUNTRY_KR = '19'; // 한국

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [trend-fetcher] ${msg}`);
}

// ─── Main ────────────────────────────────────────────────

export async function fetchTrends(): Promise<TrendItem[]> {
  if (!APIFY_TOKEN) {
    throw new Error('APIFY_TOKEN 환경변수가 필요합니다. .env에 설정하세요.');
  }

  const client = new ApifyClient({ token: APIFY_TOKEN });

  log('Apify Twitter Trends Scraper 실행 중...');

  const run = await client.actor(ACTOR_ID).call({
    country: COUNTRY_KR,
    proxyOptions: { useApifyProxy: true },
  });

  log(`실행 완료 (runId: ${run.id}, status: ${run.status})`);

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  const trends: TrendItem[] = items.map((item: Record<string, unknown>) => ({
    trend: (item.trend as string) || (item.name as string) || '',
    volume: (item.volume as string) || (item.tweet_volume as string) || null,
    timePeriod: (item.timePeriod as string) || (item.time_period as string) || null,
    time: (item.time as string) || null,
  })).filter(t => t.trend.length > 0);

  log(`수집된 트렌드: ${trends.length}개`);

  // DB에 전부 저장 (selected=false 기본값)
  const now = new Date();
  let saved = 0;
  for (let i = 0; i < trends.length; i++) {
    try {
      await db.insert(trendKeywords).values({
        id: generateId('trend'),
        keyword: trends[i].trend,
        rank: i + 1,
        source: 'x_trending',
        fetched_at: now,
        selected: false,
        posts_collected: 0,
      }).onConflictDoNothing();
      saved++;
    } catch { /* 중복 무시 */ }
  }
  log(`DB 저장: ${saved}/${trends.length}개`);

  return trends;
}

// ─── CLI ─────────────────────────────────────────────────

async function main(): Promise<void> {
  log('=== X 한국 트렌드 수집 시작 ===');

  const trends = await fetchTrends();

  console.log('\n== 수집 결과 ==');
  trends.forEach((t, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${t.trend} ${t.volume ? `(${t.volume})` : ''} ${t.timePeriod ? `[${t.timePeriod}]` : ''}`);
  });

  console.log(`\n총: ${trends.length}개 트렌드`);
  process.exit(0);
}

const isDirectRun = process.argv[1]?.includes('trend-fetcher');
if (isDirectRun) {
  main().catch(err => { console.error(err); process.exit(1); });
}
