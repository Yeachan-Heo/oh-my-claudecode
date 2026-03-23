#!/usr/bin/env tsx
/**
 * evaluate-channels.ts — 벤치마크 채널 성과 평가
 *
 * Usage:
 *   npx tsx scripts/evaluate-channels.ts              # --dry-run (기본)
 *   npx tsx scripts/evaluate-channels.ts --apply      # 하위 20% retired 마킹
 *   npx tsx scripts/evaluate-channels.ts --top 10     # 상위 10개만 출력
 */
import 'dotenv/config';
import { db } from '../src/db/index.js';
import { sql } from 'drizzle-orm';

interface ChannelScore {
  channel_id: string;
  name: string;
  avg_views: number;
  avg_engagement: number;
  post_frequency: number;
  score: number;
}

async function main() {
  const args = process.argv.slice(2);
  const applyMode = args.includes('--apply');
  const topIdx = args.indexOf('--top');
  const topN = topIdx >= 0 ? parseInt(args[topIdx + 1]) || 10 : 0;

  // active 벤치마크 채널 조회 (verified = 기존 활성 채널, retired 제외)
  const activeChannels = await db.execute(sql`
    SELECT channel_id, display_name as name
    FROM channels
    WHERE is_benchmark = true
      AND benchmark_status != 'retired'
  `);
  console.log(`Active channels: ${activeChannels.length}`);

  if (activeChannels.length === 0) {
    console.log('평가할 채널이 없습니다.');
    process.exit(0);
  }

  const scores: ChannelScore[] = [];

  for (const ch of activeChannels) {
    const channelId = (ch as any).channel_id;
    const channelName = (ch as any).name || channelId;

    // crawl_at 2일+ 경과한 포스트만 평가 (mature 포스트)
    const stats = await db.execute(sql`
      SELECT
        count(*) as post_count,
        coalesce(avg(view_count), 0) as avg_views,
        coalesce(avg(
          CASE WHEN coalesce(view_count, 0) > 0
            THEN (coalesce(like_count, 0) + coalesce(reply_count, 0) + coalesce(repost_count, 0))::numeric / view_count
            ELSE 0
          END
        ), 0) as avg_engagement
      FROM thread_posts
      WHERE channel_id = ${channelId}
        AND crawl_at < NOW() - INTERVAL '2 days'
    `);

    // 7일 내 포스트 빈도
    const freq = await db.execute(sql`
      SELECT count(*) as cnt
      FROM thread_posts
      WHERE channel_id = ${channelId}
        AND timestamp > NOW() - INTERVAL '7 days'
    `);

    const s = stats[0] as any;
    const f = freq[0] as any;
    const avgViews = parseFloat(s.avg_views) || 0;
    const avgEng = parseFloat(s.avg_engagement) || 0;
    const postFreq = parseInt(f.cnt) || 0;

    // 종합 점수 = avg_views * 0.4 + avg_engagement * 100 * 0.3 + post_frequency * 0.3
    const score = avgViews * 0.4 + avgEng * 100 * 0.3 + postFreq * 0.3;

    scores.push({
      channel_id: channelId,
      name: channelName,
      avg_views: Math.round(avgViews),
      avg_engagement: Math.round(avgEng * 10000) / 100,
      post_frequency: postFreq,
      score: Math.round(score * 100) / 100,
    });
  }

  // 점수 내림차순 정렬
  scores.sort((a, b) => b.score - a.score);

  // 출력
  const display = topN > 0 ? scores.slice(0, topN) : scores;
  console.log('\n=== 채널 평가 결과 ===');
  console.log('| # | 채널 | 평균조회수 | 참여율% | 주간포스트 | 점수 |');
  console.log('|---|------|----------|--------|----------|------|');
  display.forEach((s, i) => {
    console.log(`| ${i + 1} | ${s.name.slice(0, 20)} | ${s.avg_views} | ${s.avg_engagement}% | ${s.post_frequency} | ${s.score} |`);
  });

  // 하위 20%
  const bottomCount = Math.max(1, Math.ceil(scores.length * 0.2));
  const bottomChannels = scores.slice(-bottomCount);
  console.log(`\n하위 20% (${bottomCount}개):`);
  bottomChannels.forEach(s => console.log(`  - ${s.name} (점수: ${s.score})`));

  if (applyMode) {
    for (const s of bottomChannels) {
      await db.execute(sql`UPDATE channels SET benchmark_status = 'retired' WHERE channel_id = ${s.channel_id}`);
    }
    console.log(`\n${bottomCount}개 채널 retired 처리 완료`);
  } else {
    console.log('\n--apply 옵션으로 실행하면 하위 채널이 retired 처리됩니다.');
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
