#!/usr/bin/env tsx
/**
 * track-performance.ts — @duribeon231 포스트 성과 추적 CLI
 *
 * 1. Chrome CDP 연결
 * 2. @duribeon231 프로필 방문 + GraphQL 인터셉터로 engagement 일괄 수집
 * 3. thread_posts에 있는 우리 포스트를 content_lifecycle에 자동 등록
 * 4. 각 포스트 개별 방문 → view_count DOM 추출
 * 5. post_snapshots 저장 + content_lifecycle 업데이트
 * 6. 결과 출력 + 텔레그램 알림
 *
 * Usage:
 *   npx tsx scripts/track-performance.ts                    # 전체 포스트 추적
 *   npx tsx scripts/track-performance.ts --post <post_id>   # 특정 포스트만
 */

import { eq, and, sql } from 'drizzle-orm';
import { connectBrowser } from '../src/utils/browser.js';
import { createGraphQLInterceptor } from '../src/scraper/graphql-interceptor.js';
import { getPostMaturity } from '../src/tracker/snapshot.js';
import { calculateVelocity } from '../src/tracker/metrics.js';
import { humanDelay } from '../src/utils/timing.js';
import { sendAlert } from '../src/utils/telegram.js';
import { db } from '../src/db/index.js';
import { postSnapshots, contentLifecycle, threadPosts } from '../src/db/schema.js';
import type { GraphQLExtractedPost } from '../src/scraper/graphql-interceptor.js';
import type { Page } from 'playwright';

// ─── Constants ───────────────────────────────────────────

const OUR_CHANNEL = 'duribeon231';
const PROFILE_URL = `https://www.threads.net/@${OUR_CHANNEL}`;

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── CLI ─────────────────────────────────────────────────

interface CliOptions {
  postId: string | null;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  let postId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--post' && args[i + 1]) {
      postId = args[i + 1];
      i++;
    }
  }

  return { postId };
}

// ─── DOM: Post Text Extraction ───────────────────────────

async function extractPostText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Threads 포스트 본문 추출 — span[dir="auto"]이 실제 텍스트를 담고 있음
    const uiPatterns = /^(좋아요|답글|리포스트|공유|조회|팔로우|팔로잉|더 보기|수정|삭제|신고)/;

    // 1차: span[dir="auto"] 중 가장 긴 텍스트 (Threads 현재 DOM 구조)
    const spans = document.querySelectorAll('span[dir="auto"]');
    let longest = '';
    for (const span of spans) {
      const text = span.textContent?.trim() || '';
      if (text.length > longest.length && text.length > 20 && !uiPatterns.test(text)) {
        longest = text;
      }
    }
    if (longest.length > 20) return longest;

    // 2차: div[dir="auto"] 폴백
    const divs = document.querySelectorAll('div[dir="auto"]');
    for (const div of divs) {
      const text = div.textContent?.trim() || '';
      if (text.length > longest.length && text.length > 20 && !uiPatterns.test(text)) {
        longest = text;
      }
    }
    return longest;
  });
}

// ─── DOM: View Count Extraction ──────────────────────────

async function extractViewCount(page: Page): Promise<number> {
  const views = await page.evaluate((): number => {
    const bodyText = document.body.innerText || '';

    // Korean: "조회 N회", "조회 N천회", "조회 N만회"
    const koMatch = bodyText.match(/조회\s*([\d,.]+(?:\.\d+)?)\s*(만|천)?\s*회/);
    if (koMatch) {
      const num = parseFloat(koMatch[1].replace(/,/g, ''));
      if (koMatch[2] === '만') return Math.round(num * 10000);
      if (koMatch[2] === '천') return Math.round(num * 1000);
      return Math.round(num);
    }

    // English: "N views", "N.NK views", "NM views"
    const enMatch = bodyText.match(/([\d,.]+(?:\.\d+)?)\s*[KkMm]?\s*views/i);
    if (enMatch) {
      const v = enMatch[1].replace(/,/g, '');
      const full = enMatch[0].toLowerCase();
      if (full.includes('k')) return Math.round(parseFloat(v) * 1000);
      if (full.includes('m')) return Math.round(parseFloat(v) * 1000000);
      return Math.round(parseFloat(v));
    }

    return 0;
  });

  return views;
}

// ─── Step 1: GraphQL engagement collection ───────────────

async function collectGraphQLEngagement(page: Page): Promise<Map<string, GraphQLExtractedPost>> {
  log(`GraphQL 인터셉터 등록 + ${PROFILE_URL} 방문`);

  const interceptor = createGraphQLInterceptor(page);

  try {
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(3000, 5000);

    // Scroll to load all posts
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('End');
      await humanDelay(1500, 3000);
    }

    const gqlPosts = interceptor.getCollectedPosts();
    log(`GraphQL 캡처: ${gqlPosts.length}개 포스트`);

    const map = new Map<string, GraphQLExtractedPost>();
    for (const post of gqlPosts) {
      map.set(post.post_id, post);
    }

    // DOM 폴백: GraphQL이 적게 잡히면 프로필 DOM에서 포스트 링크 스캔
    const domPostIds = await page.evaluate((channel: string) => {
      const ids: string[] = [];
      const links = document.querySelectorAll(`a[href*="/@${channel}/post/"]`);
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/post\/([^/?#]+)/);
        if (match && match[1] && !ids.includes(match[1])) {
          ids.push(match[1]);
        }
      }
      return ids;
    }, OUR_CHANNEL);

    // DOM에서 발견했지만 GraphQL에 없는 포스트 → 빈 엔트리로 추가
    let domAdded = 0;
    for (const pid of domPostIds) {
      if (!map.has(pid)) {
        map.set(pid, {
          post_id: pid,
          author: OUR_CHANNEL,
          text: '',
          permalink: `https://www.threads.net/@${OUR_CHANNEL}/post/${pid}`,
          like_count: 0,
          reply_count: 0,
          repost_count: 0,
          has_image: false,
          time_text: null,
          timestamp_unix: null,
          quote_count: 0,
          reshare_count: 0,
          media_urls: [],
          link_url: null,
          source: 'graphql',
        });
        domAdded++;
      }
    }
    if (domAdded > 0) log(`DOM 폴백으로 ${domAdded}개 포스트 추가 발견`);

    return map;
  } finally {
    interceptor.destroy();
  }
}

// ─── Step 2: Auto-register from GraphQL + DB ─────────────

/**
 * GraphQL에서 캡처한 우리 포스트 중 DB에 없는 것을 thread_posts + content_lifecycle에 자동 등록.
 * 브라우저로 직접 게시한 포스트도 놓치지 않음.
 */
async function autoRegisterFromGraphQL(gqlMap: Map<string, GraphQLExtractedPost>): Promise<void> {
  log(`신규 포스트 자동 등록 체크 (GraphQL ${gqlMap.size}개 + DB)`);

  // 1. GraphQL에서 캡처한 우리 포스트를 thread_posts에 등록 (없는 것만)
  let newPosts = 0;
  for (const [postId, gql] of gqlMap) {
    if (gql.author !== OUR_CHANNEL) continue;

    const result = await db.insert(threadPosts).values({
      post_id: postId,
      channel_id: OUR_CHANNEL,
      author: OUR_CHANNEL,
      text: gql.text,
      permalink: gql.permalink,
      timestamp: gql.timestamp_unix ? new Date(gql.timestamp_unix * 1000) : new Date(),
      like_count: gql.like_count,
      reply_count: gql.reply_count,
      repost_count: gql.repost_count,
      has_image: gql.has_image,
      media_urls: gql.media_urls?.length ? gql.media_urls : [],
      crawl_at: new Date(),
      run_id: 'track_performance_auto',
    }).onConflictDoNothing().returning({ post_id: threadPosts.post_id });

    if (result.length > 0) {
      newPosts++;
      log(`  thread_posts 신규: ${postId} "${gql.text.slice(0, 40)}..."`);
    }
  }
  if (newPosts > 0) log(`  thread_posts 신규 등록: ${newPosts}개`);

  // 1.5. author가 잘못된 우리 포스트 보정 (DOM 크롤링 시 '프로필' 등으로 잡히는 케이스)
  const fixed = await db.update(threadPosts)
    .set({ author: OUR_CHANNEL })
    .where(and(
      eq(threadPosts.channel_id, OUR_CHANNEL),
      sql`${threadPosts.author} != ${OUR_CHANNEL}`
    ))
    .returning({ post_id: threadPosts.post_id });
  if (fixed.length > 0) log(`  author 보정: ${fixed.length}개 (${fixed.map(f => f.post_id).join(', ')})`);

  // 2. thread_posts에 있는 우리 포스트 전체 → content_lifecycle 등록
  const ourPosts = await db.select().from(threadPosts)
    .where(eq(threadPosts.channel_id, OUR_CHANNEL));

  if (ourPosts.length === 0) {
    log(`  thread_posts에 ${OUR_CHANNEL} 포스트 없음`);
    return;
  }

  log(`  thread_posts 총 ${ourPosts.length}개 포스트`);

  let registered = 0;
  for (const post of ourPosts) {
    const result = await db.insert(contentLifecycle).values({
      id: post.post_id,
      source_post_id: post.post_id,
      source_channel_id: OUR_CHANNEL,
      source_engagement: 0,
      source_relevance: 0,
      extracted_need: '',
      need_category: '',
      need_confidence: 0,
      matched_product_id: '',
      match_relevance: 0,
      content_text: post.text || '',
      content_style: 'warmup',
      hook_type: 'empathy',
      posted_account_id: OUR_CHANNEL,
      posted_at: post.timestamp || post.crawl_at || new Date(),
      threads_post_id: post.post_id,
      threads_post_url: post.permalink || `https://www.threads.net/@${OUR_CHANNEL}/post/${post.post_id}`,
      maturity: 'warmup',
      current_impressions: 0,
      current_clicks: 0,
      current_conversions: 0,
      current_revenue: 0,
    }).onConflictDoNothing().returning({ id: contentLifecycle.id });

    if (result.length > 0) {
      registered++;
      log(`  lifecycle 등록: ${post.post_id}`);
    }
  }

  if (registered > 0) log(`  content_lifecycle 신규 등록: ${registered}개`);
}

// ─── Step 3: Query lifecycle entries to track ─────────────

interface LifecycleEntry {
  id: string;
  threads_post_id: string | null;
  threads_post_url: string | null;
  posted_at: Date | null;
  created_at: Date;
}

async function getLifecycleEntries(postId: string | null): Promise<LifecycleEntry[]> {
  const rows = await db
    .select({
      id: contentLifecycle.id,
      threads_post_id: contentLifecycle.threads_post_id,
      threads_post_url: contentLifecycle.threads_post_url,
      posted_at: contentLifecycle.posted_at,
      created_at: contentLifecycle.created_at,
    })
    .from(contentLifecycle)
    .where(eq(contentLifecycle.posted_account_id, OUR_CHANNEL));

  if (postId !== null) {
    return rows.filter(r => r.id === postId || r.threads_post_id === postId);
  }
  return rows;
}

// ─── Step 4: Determine snapshot type ─────────────────────

function resolveSnapshotType(postedAt: Date): 'early' | 'mature' | 'final' {
  const ageHours = (Date.now() - postedAt.getTime()) / (1000 * 60 * 60);
  if (ageHours < 48) return 'early';
  if (ageHours < 168) return 'mature';
  return 'final';
}

// ─── Result types ─────────────────────────────────────────

interface TrackResult {
  postId: string;
  text: string;
  viewCount: number;
  likes: number;
  comments: number;
  shares: number;
  engagementRate: number;
  snapshotType: 'early' | 'mature' | 'final';
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCliArgs();

  log(`=== @${OUR_CHANNEL} 성과 추적 시작 ===`);
  if (opts.postId) {
    log(`모드: 특정 포스트 (${opts.postId})`);
  } else {
    log(`모드: 전체 포스트`);
  }

  // Step 1: Connect browser first (needed for GraphQL scan)
  let browser;
  try {
    browser = await connectBrowser();
  } catch (err) {
    console.error(`브라우저 연결 실패: ${(err as Error).message}`);
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error('브라우저 컨텍스트 없음');
    await browser.close();
    process.exit(1);
  }

  const page = context.pages()[0] || await context.newPage();

  // Polyfill for esbuild __name
  await context.addInitScript({ content: 'window.__name = (fn, _name) => fn;' });
  await page.evaluate('window.__name = (fn, _name) => fn');

  const results: TrackResult[] = [];
  let snapshotCount = 0;

  try {
    // Step 2: Collect GraphQL engagement from profile page
    const gqlMap = await collectGraphQLEngagement(page);

    // Step 3: Auto-register new posts from GraphQL + DB into lifecycle
    await autoRegisterFromGraphQL(gqlMap);

    // Step 4: Query lifecycle entries (now includes newly registered posts)
    const lifecycleEntries = await getLifecycleEntries(opts.postId);
    if (lifecycleEntries.length === 0) {
      log('추적할 포스트가 없습니다.');
      process.exit(0);
    }
    log(`추적 대상: ${lifecycleEntries.length}개`);

    // Step 5: For each lifecycle entry, visit post page for view_count
    for (let i = 0; i < lifecycleEntries.length; i++) {
      const entry = lifecycleEntries[i];
      const postUrl = entry.threads_post_url
        || `https://www.threads.net/@${OUR_CHANNEL}/post/${entry.id}`;
      const postId = entry.threads_post_id || entry.id;

      log(`\n▶ [${i + 1}/${lifecycleEntries.length}] 포스트: ${postId}`);
      log(`  URL: ${postUrl}`);

      // Navigate to post for view count
      try {
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await humanDelay(2000, 4000);
      } catch (err) {
        log(`  페이지 로드 실패: ${(err as Error).message} — 건너뜀`);
        continue;
      }

      let viewCount = await extractViewCount(page);

      // Retry once if view count is 0 (thread-type posts may need extra load time)
      if (viewCount === 0) {
        await humanDelay(3000, 5000);
        viewCount = await extractViewCount(page);
        if (viewCount === 0) {
          // Last resort: try threads.net URL variant
          const altUrl = postUrl.replace('threads.com', 'threads.net');
          if (altUrl !== postUrl) {
            try {
              await page.goto(altUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
              await humanDelay(3000, 5000);
              viewCount = await extractViewCount(page);
            } catch { /* ignore */ }
          }
        }
      }
      log(`  조회수: ${viewCount}`);

      // Extract post text from DOM if missing
      const gql = gqlMap.get(postId);
      let postText = gql?.text || '';
      if (!postText || postText.length < 5) {
        postText = await extractPostText(page);
        if (postText.length > 5) {
          log(`  본문 수집: "${postText.slice(0, 50)}..."`);
          // DB 업데이트 — thread_posts.text가 비어있으면 채운다
          try {
            await db.update(threadPosts)
              .set({ text: postText })
              .where(eq(threadPosts.post_id, postId));
          } catch { /* non-critical */ }
        }
      }

      // Get engagement from GraphQL (prefer), fallback to DOM parsing
      let likes = gql?.like_count ?? 0;
      let comments = gql?.reply_count ?? 0;
      let shares = gql?.repost_count ?? 0;

      // DOM fallback: if GraphQL didn't capture engagement, parse from page
      if (likes === 0 && comments === 0 && shares === 0) {
        const domMetrics = await page.evaluate(() => {
          let l = 0, c = 0, s = 0;
          const buttons = document.querySelectorAll('button, [role="button"]');
          for (const btn of buttons) {
            const label = btn.getAttribute('aria-label') || btn.textContent || '';
            const lower = label.toLowerCase();
            const numMatch = label.match(/(\d[\d,.]*)/);
            const num = numMatch ? parseInt(numMatch[1].replace(/,/g, ''), 10) || 0 : 0;
            if ((lower.includes('좋아요') || lower.includes('like')) && num > 0 && l === 0) l = num;
            else if ((lower.includes('답글') || lower.includes('reply') || lower.includes('comment')) && num > 0 && c === 0) c = num;
            else if ((lower.includes('리포스트') || lower.includes('repost')) && num > 0 && s === 0) s = num;
          }
          return { likes: l, comments: c, shares: s };
        });
        likes = domMetrics.likes;
        comments = domMetrics.comments;
        shares = domMetrics.shares;
        if (likes > 0 || comments > 0 || shares > 0) {
          log(`  DOM 폴백으로 engagement 수집됨`);
        }
      }

      log(`  좋아요: ${likes}, 답글: ${comments}, 리포스트: ${shares}`);

      // Determine posted_at for maturity calculation
      const postedAt = entry.posted_at
        ? new Date(entry.posted_at)
        : new Date(entry.created_at);

      const ageHours = (Date.now() - postedAt.getTime()) / (1000 * 60 * 60);
      const snapshotType = resolveSnapshotType(postedAt);
      const maturity = getPostMaturity(postedAt);

      // Calculate velocity
      const velocity = calculateVelocity(
        { likes, comments, shares, clicks: 0, conversions: 0 },
        ageHours,
      );

      // Save snapshot — 하루에 포스트당 1개만 유지 (upsert)
      const today = new Date().toISOString().slice(0, 10);
      const snapId = `snap_${today}_${postId.slice(0, 6)}`;
      try {
        // 오늘 같은 포스트의 기존 스냅샷 확인
        const [existing] = await db.select({ id: postSnapshots.id })
          .from(postSnapshots)
          .where(and(
            eq(postSnapshots.post_id, entry.id),
            sql`${postSnapshots.snapshot_at}::date = ${today}::date`
          ))
          .limit(1);

        if (existing) {
          // 기존 스냅샷 업데이트
          await db.update(postSnapshots)
            .set({
              snapshot_type: snapshotType,
              snapshot_at: new Date(),
              likes,
              comments,
              shares,
              saves: 0,
              clicks: 0,
              conversions: 0,
              revenue: 0,
              engagement_velocity: velocity.engagement_velocity,
              click_velocity: velocity.click_velocity,
              conversion_velocity: velocity.conversion_velocity,
              post_views: viewCount || null,
              comment_views: null,
            })
            .where(eq(postSnapshots.id, existing.id));
          snapshotCount++;
          log(`  스냅샷 업데이트 (${existing.id})`);
        } else {
          // 신규 스냅샷
          await db.insert(postSnapshots).values({
            id: snapId,
            post_id: entry.id,
            snapshot_type: snapshotType,
            snapshot_at: new Date(),
            likes,
            comments,
            shares,
            saves: 0,
            clicks: 0,
            conversions: 0,
            revenue: 0,
            engagement_velocity: velocity.engagement_velocity,
            click_velocity: velocity.click_velocity,
            conversion_velocity: velocity.conversion_velocity,
            post_views: viewCount || null,
            comment_views: null,
          });
          snapshotCount++;
          log(`  스냅샷 저장 완료 (${snapId})`);
        }
      } catch (err) {
        log(`  스냅샷 저장 실패: ${(err as Error).message}`);
      }

      // Update content_lifecycle
      const impressions = viewCount > 0 ? viewCount : likes + comments + shares;
      try {
        await db.update(contentLifecycle).set({
          maturity,
          current_impressions: impressions,
          current_clicks: 0,
        }).where(eq(contentLifecycle.id, entry.id));
        log(`  lifecycle 업데이트: maturity=${maturity}, impressions=${impressions}`);
      } catch (err) {
        log(`  lifecycle 업데이트 실패: ${(err as Error).message}`);
      }

      // Compute engagement rate
      const totalEngagement = likes + comments + shares;
      const engagementRate = viewCount > 0
        ? (totalEngagement / viewCount) * 100
        : 0;

      results.push({
        postId,
        text: postText,
        viewCount,
        likes,
        comments,
        shares,
        engagementRate,
        snapshotType,
      });

      // Anti-bot delay between posts
      if (i < lifecycleEntries.length - 1) {
        const delay = await humanDelay(2000, 4000);
        log(`  다음 포스트까지 대기: ${(delay / 1000).toFixed(1)}초`);
      }
    }
  } finally {
    await browser.close();
    log('\n브라우저 disconnect 완료');
  }

  // ─── Output Summary ────────────────────────────────────

  console.log('\n== @duribeon231 성과 추적 결과 ==\n');
  console.log('| 포스트 | 조회수 | 좋아요 | 답글 | 리포스트 | 참여율 | 스냅샷 |');
  console.log('|--------|--------|--------|------|----------|--------|--------|');

  let totalViews = 0;
  let totalEngagement = 0;
  let topPost: TrackResult | null = null;

  for (const r of results) {
    const textPreview = r.text.slice(0, 15).replace(/\n/g, ' ');
    const views = r.viewCount.toLocaleString();
    const engagement = r.engagementRate.toFixed(2);
    console.log(`| "${textPreview}..." | ${views} | ${r.likes} | ${r.comments} | ${r.shares} | ${engagement}% | ${r.snapshotType} |`);

    totalViews += r.viewCount;
    totalEngagement += r.engagementRate;
    if (!topPost || r.viewCount > topPost.viewCount) {
      topPost = r;
    }
  }

  console.log(`\n총 포스트: ${results.length}개`);
  console.log(`새 스냅샷: ${snapshotCount}개`);

  const avgEngagement = results.length > 0
    ? (totalEngagement / results.length).toFixed(2)
    : '0.00';
  console.log(`평균 참여율: ${avgEngagement}%`);

  // Telegram notification
  if (results.length > 0 && topPost) {
    const topViews = topPost.viewCount.toLocaleString();
    const topText = topPost.text.slice(0, 30);
    await sendAlert(
      `✅ 성과 추적 완료\n\n@duribeon231 포스트 ${results.length}개\n새 스냅샷: ${snapshotCount}개\n\n최고 조회: "${topText}..." (${topViews}회)\n평균 참여율: ${avgEngagement}%`,
    );
  } else {
    log('결과 없음 — 텔레그램 알림 건너뜀');
  }

  log('\n=== 성과 추적 완료 ===');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
