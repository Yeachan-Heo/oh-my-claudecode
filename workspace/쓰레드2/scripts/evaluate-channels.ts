#!/usr/bin/env tsx
/**
 * evaluate-channels.ts — 벤치마크 채널 성과 평가
 *
 * Usage:
 *   npx tsx scripts/evaluate-channels.ts              # --dry-run (기본)
 *   npx tsx scripts/evaluate-channels.ts --apply      # 하위 20% retired 마킹 (카테고리 최소 3개 보호)
 *   npx tsx scripts/evaluate-channels.ts --top 10     # 상위 10개만 출력
 *   npx tsx scripts/evaluate-channels.ts --check-limits  # 카테고리별 포화도 확인
 */
import 'dotenv/config';
import { db } from '../src/db/index.js';
import { sql } from 'drizzle-orm';

interface ChannelScore {
  channel_id: string;
  name: string;
  category: string;
  avg_views: number;
  avg_replies: number;
  avg_engagement: number;
  post_frequency: number;
  score: number;
}

async function main() {
  const args = process.argv.slice(2);
  const applyMode = args.includes('--apply');
  const checkLimits = args.includes('--check-limits');
  const topIdx = args.indexOf('--top');
  const topN = topIdx >= 0 ? parseInt(args[topIdx + 1]) || 10 : 0;

  // --check-limits: 카테고리별 벤치마크 수와 포화도 표시
  if (checkLimits) {
    const limitStats = await db.execute(sql`
      SELECT
        coalesce(category, '(미분류)') as category,
        count(*) as total,
        count(*) FILTER (WHERE benchmark_status != 'retired') as active,
        10 as capacity
      FROM channels
      WHERE is_benchmark = true
      GROUP BY category
      ORDER BY active DESC
    `);
    console.log('\n=== 카테고리별 벤치마크 포화도 (상한: 10개) ===');
    console.log('| 카테고리 | 활성 | 전체 | 포화도 |');
    console.log('|---------|------|------|--------|');
    for (const row of limitStats) {
      const r = row as any;
      const active = parseInt(r.active);
      const saturation = Math.round((active / 10) * 100);
      console.log(`| ${String(r.category).slice(0, 15)} | ${active} | ${r.total} | ${saturation}% |`);
    }
    process.exit(0);
  }

  // active 벤치마크 채널 조회 (retired 제외)
  const activeChannels = await db.execute(sql`
    SELECT channel_id, display_name as name, coalesce(category, '(미분류)') as category
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
    const channelCategory = (ch as any).category || '(미분류)';

    // crawl_at 2일+ 경과한 포스트만 평가 (mature 포스트)
    const stats = await db.execute(sql`
      SELECT
        count(*) as post_count,
        coalesce(avg(view_count), 0) as avg_views,
        coalesce(avg(reply_count), 0) as avg_replies,
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
    const avgReplies = parseFloat(s.avg_replies) || 0;
    const avgEng = parseFloat(s.avg_engagement) || 0;
    const postFreq = parseInt(f.cnt) || 0;

    // 종합 점수 = avg_views * 0.25 + avg_replies * 50 * 0.30 + avg_engagement * 100 * 0.25 + post_frequency * 0.20
    const score = avgViews * 0.25 + avgReplies * 50 * 0.30 + avgEng * 100 * 0.25 + postFreq * 0.20;

    scores.push({
      channel_id: channelId,
      name: channelName,
      category: channelCategory,
      avg_views: Math.round(avgViews),
      avg_replies: Math.round(avgReplies * 10) / 10,
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
  console.log('| # | 채널 | 카테고리 | 평균조회수 | 평균댓글 | 참여율% | 주간포스트 | 점수 |');
  console.log('|---|------|---------|----------|---------|--------|----------|------|');
  display.forEach((s, i) => {
    console.log(`| ${i + 1} | ${s.name.slice(0, 20)} | ${s.category.slice(0, 10)} | ${s.avg_views} | ${s.avg_replies} | ${s.avg_engagement}% | ${s.post_frequency} | ${s.score} |`);
  });

  // 하위 20%
  const bottomCount = Math.max(1, Math.ceil(scores.length * 0.2));
  const bottomChannels = scores.slice(-bottomCount);
  console.log(`\n하위 20% (${bottomCount}개):`);
  bottomChannels.forEach(s => console.log(`  - ${s.name} [${s.category}] (점수: ${s.score})`));

  if (applyMode) {
    // 카테고리별 활성 채널 수 집계 (retire 전 기준)
    const categoryCount: Record<string, number> = {};
    for (const s of scores) {
      categoryCount[s.category] = (categoryCount[s.category] || 0) + 1;
    }

    let retiredCount = 0;
    let skippedCount = 0;

    for (const s of bottomChannels) {
      const remainingAfterRetire = (categoryCount[s.category] || 0) - 1;
      if (remainingAfterRetire < 3) {
        console.log(`  [SKIP] ${s.name} — 카테고리 '${s.category}' 최소 3개 보호 (현재 ${categoryCount[s.category]}개)`);
        skippedCount++;
        continue;
      }
      await db.execute(sql`UPDATE channels SET benchmark_status = 'retired' WHERE channel_id = ${s.channel_id}`);
      // retire 후 카운트 감소
      categoryCount[s.category]--;
      retiredCount++;
    }

    console.log(`\nretired: ${retiredCount}개, 보호로 스킵: ${skippedCount}개`);
  } else {
    console.log('\n--apply 옵션으로 실행하면 하위 채널이 retired 처리됩니다.');
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
