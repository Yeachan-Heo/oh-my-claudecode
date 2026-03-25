import 'dotenv/config';
import { client } from './src/db/index.js';
async function main() {
  // 1. 24h 수집 카테고리 분포
  const catDist = await client`
    SELECT topic_category, count(*)::int AS cnt, 
      COALESCE(AVG(view_count), 0)::int AS avg_views
    FROM thread_posts
    WHERE crawl_at >= NOW() - INTERVAL '24 hours'
    GROUP BY topic_category
    ORDER BY cnt DESC
  `;
  console.log('=== 24h 수집 카테고리 분포 ===');
  for (const r of catDist) console.log(`${r.topic_category || 'NULL'}: ${r.cnt}건, 평균뷰 ${r.avg_views}`);

  // 2. 채널별 카테고리 (verified)
  const channels = await client`
    SELECT c.username, 
      (SELECT topic_category FROM thread_posts WHERE channel_id = c.username AND topic_category IS NOT NULL GROUP BY topic_category ORDER BY count(*) DESC LIMIT 1) AS main_category,
      (SELECT count(*)::int FROM thread_posts WHERE channel_id = c.username AND crawl_at >= NOW() - INTERVAL '24 hours') AS posts_24h
    FROM channels c
    WHERE c.status = 'verified'
    ORDER BY posts_24h DESC
  `;
  console.log('\n=== 채널별 주 카테고리 + 24h 수집 ===');
  for (const r of channels) console.log(`${r.username}: ${r.main_category || '미분류'} (24h: ${r.posts_24h}건)`);

  // 3. 뷰티 카테고리 TOP 포스트
  const beautyTop = await client`
    SELECT LEFT(text, 50) AS text_short, view_count, channel_id
    FROM thread_posts
    WHERE topic_category = '뷰티' AND crawl_at >= NOW() - INTERVAL '24 hours'
    ORDER BY view_count DESC NULLS LAST
    LIMIT 5
  `;
  console.log('\n=== 뷰티 24h TOP 포스트 ===');
  if (beautyTop.length === 0) console.log('(없음)');
  for (const r of beautyTop) console.log(`${r.view_count}뷰 | ${r.channel_id} | ${r.text_short}`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
