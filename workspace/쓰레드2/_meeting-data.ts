import { client } from './src/db/index.js';

async function main() {
  // 1. 벤치마크 채널 현황
  const channels = await client`
    SELECT c.channel_id, c.is_active, c.follower_count, c.category,
           (SELECT COUNT(*) FROM thread_posts tp WHERE tp.channel_id = c.channel_id) as post_count,
           (SELECT MAX(timestamp) FROM thread_posts tp WHERE tp.channel_id = c.channel_id) as last_post
    FROM channels c
    WHERE c.is_benchmark = true
    ORDER BY c.is_active DESC, c.category, c.follower_count DESC
  `;
  const active = channels.filter((r:any)=>r.is_active);
  const inactive = channels.filter((r:any)=>!r.is_active);
  console.log('=== 벤치마크 채널 현황 ===');
  console.log(`총 ${channels.length}개 (활성: ${active.length}, 비활성: ${inactive.length})`);
  for (const r of channels) {
    console.log(`  ${r.is_active?'✅':'❌'} @${r.channel_id} | ${r.category || '미분류'} | 팔로워 ${r.follower_count || '?'} | 포스트 ${r.post_count}개 | 최신 ${r.last_post ? new Date(r.last_post).toLocaleDateString() : '없음'}`);
  }

  // 2. 수집 소스별 포스트 현황
  const sources = await client`
    SELECT post_source, COUNT(*) as cnt,
           MIN(timestamp) as oldest, MAX(timestamp) as newest,
           COUNT(DISTINCT channel_id) as unique_channels
    FROM thread_posts
    GROUP BY post_source
    ORDER BY cnt DESC
  `;
  console.log('\n=== 수집 소스별 포스트 현황 ===');
  for (const r of sources) {
    console.log(`  ${r.post_source || 'null'}: ${r.cnt}개 | 채널 ${r.unique_channels}개 | ${new Date(r.oldest).toLocaleDateString()} ~ ${new Date(r.newest).toLocaleDateString()}`);
  }

  // 3. 카테고리별 포스트 분포
  const cats = await client`
    SELECT category, COUNT(*) as cnt,
           ROUND(AVG(view_count)) as avg_views,
           ROUND(AVG(like_count)) as avg_likes,
           ROUND(AVG(reply_count)) as avg_replies
    FROM thread_posts
    WHERE category IS NOT NULL
    GROUP BY category
    ORDER BY cnt DESC
  `;
  console.log('\n=== 카테고리별 포스트 분포 ===');
  for (const r of cats) {
    console.log(`  ${r.category}: ${r.cnt}개 | 평균조회 ${r.avg_views} | 평균좋아요 ${r.avg_likes} | 평균댓글 ${r.avg_replies}`);
  }

  // 4. 최근 7일 수집 활동
  const recent = await client`
    SELECT DATE(collected_at) as day, COUNT(*) as cnt, COUNT(DISTINCT channel_id) as channels
    FROM thread_posts
    WHERE collected_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(collected_at)
    ORDER BY day DESC
  `;
  console.log('\n=== 최근 7일 수집 활동 ===');
  if (recent.length === 0) console.log('  (없음)');
  for (const r of recent) {
    console.log(`  ${new Date(r.day).toLocaleDateString()}: ${r.cnt}개 (채널 ${r.channels}개)`);
  }

  // 5. 빈이 포스트 현황
  const ours = await client`
    SELECT post_id, LEFT(text_content, 50) as preview, view_count, like_count, reply_count,
           timestamp, category
    FROM thread_posts
    WHERE channel_id = 'binilab__'
    ORDER BY timestamp DESC
    LIMIT 10
  `;
  console.log('\n=== 빈이 포스트 (최근 10개) ===');
  for (const r of ours) {
    console.log(`  ${new Date(r.timestamp).toLocaleDateString()} | ${r.view_count}뷰 ${r.like_count}좋 ${r.reply_count}댓 | ${r.category || '미분류'} | ${r.preview}...`);
  }

  // 6. 전체 통계
  const [t] = await client`
    SELECT COUNT(*) as total,
           COUNT(DISTINCT channel_id) as unique_channels,
           COUNT(CASE WHEN view_count > 0 THEN 1 END) as with_views
    FROM thread_posts
  `;
  console.log('\n=== 전체 통계 ===');
  console.log(`  총 포스트: ${t.total}개 | 채널: ${t.unique_channels}개 | 조회수 있는 포스트: ${t.with_views}개`);

  // 7. community_posts
  const community = await client`
    SELECT source_platform, COUNT(*) as cnt FROM community_posts GROUP BY source_platform ORDER BY cnt DESC
  `;
  console.log('\n=== 커뮤니티 수집 현황 ===');
  if (community.length === 0) console.log('  (없음)');
  for (const r of community) console.log(`  ${r.source_platform}: ${r.cnt}개`);

  // 8. trend_keywords
  const [tr] = await client`
    SELECT COUNT(*) as total,
           COUNT(CASE WHEN selected = true THEN 1 END) as selected,
           MAX(fetched_at) as last_fetch
    FROM trend_keywords
  `;
  console.log('\n=== 트렌드 키워드 현황 ===');
  console.log(`  총 ${tr.total}개 | 선택됨 ${tr.selected}개 | 마지막 수집 ${tr.last_fetch ? new Date(tr.last_fetch).toLocaleDateString() : '없음'}`);

  // 9. 최고 성과 외부 채널 (레퍼런스 후보)
  const topChannels = await client`
    SELECT channel_id, COUNT(*) as posts,
           ROUND(AVG(view_count)) as avg_views,
           ROUND(AVG(like_count)) as avg_likes,
           ROUND(AVG(reply_count)) as avg_replies,
           MAX(timestamp) as last_post
    FROM thread_posts
    WHERE channel_id != 'binilab__' AND view_count > 0
    GROUP BY channel_id
    HAVING COUNT(*) >= 10
    ORDER BY AVG(reply_count) DESC
    LIMIT 15
  `;
  console.log('\n=== 참여율 높은 외부 채널 TOP 15 ===');
  for (const r of topChannels) {
    console.log(`  @${r.channel_id} | ${r.posts}포스트 | 평균 ${r.avg_views}뷰 ${r.avg_likes}좋 ${r.avg_replies}댓 | 최신 ${new Date(r.last_post).toLocaleDateString()}`);
  }

  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
