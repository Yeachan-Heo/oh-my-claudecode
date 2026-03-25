import { client } from './src/db/index.js';

async function main() {
  // thread_posts 컬럼 확인
  const cols = await client`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'thread_posts' ORDER BY ordinal_position
  `;
  console.log('=== thread_posts 컬럼 ===');
  console.log(cols.map((c:any)=>c.column_name).join(', '));

  // 3. 카테고리별 포스트 분포 (needs_category 사용)
  const hasCat = cols.some((c:any) => c.column_name === 'needs_category');
  if (hasCat) {
    const cats = await client`
      SELECT needs_category as cat, COUNT(*) as cnt,
             ROUND(AVG(view_count)) as avg_views,
             ROUND(AVG(like_count)) as avg_likes,
             ROUND(AVG(reply_count)) as avg_replies
      FROM thread_posts
      WHERE needs_category IS NOT NULL
      GROUP BY needs_category ORDER BY cnt DESC
    `;
    console.log('\n=== 카테고리별(needs_category) 포스트 분포 ===');
    for (const r of cats) console.log(`  ${r.cat}: ${r.cnt}개 | 평균조회 ${r.avg_views} | 좋아요 ${r.avg_likes} | 댓글 ${r.avg_replies}`);
  }

  // 4. 최근 7일 수집 활동
  const recent = await client`
    SELECT DATE(collected_at) as day, COUNT(*) as cnt, COUNT(DISTINCT channel_id) as channels
    FROM thread_posts WHERE collected_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(collected_at) ORDER BY day DESC
  `;
  console.log('\n=== 최근 7일 수집 활동 ===');
  if (recent.length === 0) console.log('  (없음)');
  for (const r of recent) console.log(`  ${new Date(r.day).toLocaleDateString()}: ${r.cnt}개 (채널 ${r.channels}개)`);

  // 5. 빈이 포스트 현황
  const ours = await client`
    SELECT post_id, LEFT(text_content, 50) as preview, view_count, like_count, reply_count, timestamp
    FROM thread_posts WHERE channel_id = 'binilab__' ORDER BY timestamp DESC LIMIT 10
  `;
  console.log('\n=== 빈이 포스트 (최근 10개) ===');
  for (const r of ours) console.log(`  ${new Date(r.timestamp).toLocaleDateString()} | ${r.view_count}뷰 ${r.like_count}좋 ${r.reply_count}댓 | ${r.preview}...`);

  // 6. 전체 통계
  const [t] = await client`
    SELECT COUNT(*) as total, COUNT(DISTINCT channel_id) as unique_channels,
           COUNT(CASE WHEN view_count > 0 THEN 1 END) as with_views
    FROM thread_posts
  `;
  console.log('\n=== 전체 통계 ===');
  console.log(`  총 포스트: ${t.total}개 | 채널: ${t.unique_channels}개 | 조회수 있음: ${t.with_views}개`);

  // 7. community_posts
  const community = await client`SELECT source_platform, COUNT(*) as cnt FROM community_posts GROUP BY source_platform ORDER BY cnt DESC`;
  console.log('\n=== 커뮤니티 수집 현황 ===');
  if (community.length === 0) console.log('  (없음)');
  for (const r of community) console.log(`  ${r.source_platform}: ${r.cnt}개`);

  // 8. trend_keywords
  const [tr] = await client`
    SELECT COUNT(*) as total, COUNT(CASE WHEN selected = true THEN 1 END) as selected, MAX(fetched_at) as last_fetch FROM trend_keywords
  `;
  console.log('\n=== 트렌드 키워드 현황 ===');
  console.log(`  총 ${tr.total}개 | 선택됨 ${tr.selected}개 | 마지막 ${tr.last_fetch ? new Date(tr.last_fetch).toLocaleDateString() : '없음'}`);

  // 9. 참여율 높은 외부 채널 TOP 15
  const topCh = await client`
    SELECT channel_id, COUNT(*) as posts,
           ROUND(AVG(view_count)) as avg_views, ROUND(AVG(like_count)) as avg_likes, ROUND(AVG(reply_count)) as avg_replies,
           MAX(timestamp) as last_post
    FROM thread_posts WHERE channel_id != 'binilab__' AND view_count > 0
    GROUP BY channel_id HAVING COUNT(*) >= 10
    ORDER BY AVG(reply_count) DESC LIMIT 15
  `;
  console.log('\n=== 참여율 높은 외부 채널 TOP 15 ===');
  for (const r of topCh) console.log(`  @${r.channel_id} | ${r.posts}포스트 | 평균 ${r.avg_views}뷰 ${r.avg_likes}좋 ${r.avg_replies}댓 | 최신 ${new Date(r.last_post).toLocaleDateString()}`);

  // 10. 포스트 0개인 벤치마크 채널
  const zeroCh = await client`
    SELECT c.channel_id, c.category FROM channels c
    WHERE c.is_benchmark = true
      AND NOT EXISTS (SELECT 1 FROM thread_posts tp WHERE tp.channel_id = c.channel_id)
  `;
  console.log('\n=== 포스트 0개 벤치마크 채널 (유령 채널) ===');
  for (const r of zeroCh) console.log(`  @${r.channel_id} | ${r.category || '미분류'}`);

  // 11. brand_events 현황
  const [be] = await client`
    SELECT COUNT(*) as total, COUNT(CASE WHEN is_stale = false THEN 1 END) as fresh,
           COUNT(CASE WHEN is_used = true THEN 1 END) as used
    FROM brand_events
  `;
  console.log('\n=== 브랜드 이벤트 현황 ===');
  console.log(`  총 ${be.total}개 | 유효(fresh) ${be.fresh}개 | 사용됨 ${be.used}개`);

  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
