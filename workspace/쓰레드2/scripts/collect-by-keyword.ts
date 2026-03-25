#!/usr/bin/env tsx
/**
 * collect-by-keyword.ts — Threads 키워드 검색 기반 포스트 수집
 *
 * 상품 카테고리 키워드로 Threads 검색 → 검색 결과 포스트 직접 수집.
 * 채널 발굴 없이 검색 결과 포스트 자체를 DB에 저장한다.
 *
 * Usage:
 *   npx tsx scripts/collect-by-keyword.ts
 *   npx tsx scripts/collect-by-keyword.ts --keywords "선크림,영양제"
 *   npx tsx scripts/collect-by-keyword.ts --posts-per-keyword 15
 */

import fs from 'fs';
import path from 'path';
import { connectBrowser } from '../src/utils/browser.js';
import { humanDelay } from '../src/utils/timing.js';
import { db } from '../src/db/index.js';
import { threadPosts, threadComments } from '../src/db/schema.js';
import { createGraphQLInterceptor } from '../src/scraper/graphql-interceptor.js';
import type { Page } from 'playwright';

// ─── Constants ───────────────────────────────────────────

const BASE_URL = 'https://www.threads.com';
const DATA_DIR = path.join(process.cwd(), 'data');
const SEEN_POSTS_PATH = path.join(DATA_DIR, 'seen_posts.json');

const DEFAULT_KEYWORDS = [
  '선크림', '영양제', '클렌징', '에어프라이어', '공기청정기', '마사지건',
  '콜라겐', '유산균', '단백질쉐이크', '닭가슴살', '요가매트', '무선이어폰',
  '보조배터리', '로봇청소기', '곤약젤리', '쿠션파운데이션', '치아미백',
  '제모기', '전기주전자', '디퓨저', '폼롤러', '립밤', '트리트먼트',
];

const DEFAULT_POSTS_PER_KEYWORD = 30;
const DEFAULT_MAX_AGE_DAYS = 7;

// ─── Types ───────────────────────────────────────────────

interface ExtractedPost {
  post_id: string;
  author: string;
  text: string;
  permalink: string;
  like_count: number;
  reply_count: number;
  repost_count: number;
  has_image: boolean;
  time_text: string | null;
  source: 'graphql' | 'dom';
  timestamp_unix?: number | null;
  media_urls?: string[];
  link_url?: string | null;
}

interface CliOptions {
  keywords: string[];
  postsPerKeyword: number;
  maxAgeDays: number;
  withComments: boolean;
  source: 'brand' | 'keyword_search' | 'x_trend' | 'benchmark';
}

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── CLI ─────────────────────────────────────────────────

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  let keywords = DEFAULT_KEYWORDS;
  let postsPerKeyword = DEFAULT_POSTS_PER_KEYWORD;
  let maxAgeDays = DEFAULT_MAX_AGE_DAYS;
  let withComments = false;
  let source: CliOptions['source'] = 'keyword_search';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keywords' && args[i + 1]) {
      keywords = args[i + 1].split(',').map(k => k.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--posts-per-keyword' && args[i + 1]) {
      postsPerKeyword = parseInt(args[i + 1], 10) || DEFAULT_POSTS_PER_KEYWORD;
      i++;
    } else if (args[i] === '--max-age-days' && args[i + 1]) {
      maxAgeDays = parseInt(args[i + 1], 10) || DEFAULT_MAX_AGE_DAYS;
      i++;
    } else if (args[i] === '--with-comments') {
      withComments = true;
    } else if (args[i] === '--source' && args[i + 1]) {
      const valid = ['brand', 'keyword_search', 'x_trend', 'benchmark'] as const;
      const val = args[i + 1] as typeof valid[number];
      if ((valid as readonly string[]).includes(val)) {
        source = val;
      }
      i++;
    }
  }

  return { keywords, postsPerKeyword, maxAgeDays, withComments, source };
}

// ─── Deduplication ───────────────────────────────────────

let _seenPosts: Record<string, boolean> = {};

function loadSeenPosts(): void {
  try {
    if (fs.existsSync(SEEN_POSTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SEEN_POSTS_PATH, 'utf-8'));
      _seenPosts = data.posts || {};
      log(`dedup 로드: ${Object.keys(_seenPosts).length}개 기록`);
    }
  } catch {
    log('seen_posts.json 로드 실패 — 빈 상태로 초기화');
    _seenPosts = {};
  }
}

function saveSeenPosts(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SEEN_POSTS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: '1.0', updated_at: new Date().toISOString(), posts: _seenPosts }, null, 2), 'utf-8');
  fs.renameSync(tmp, SEEN_POSTS_PATH);
}

function isPostSeen(postId: string): boolean {
  for (const key of Object.keys(_seenPosts)) {
    if (key.endsWith(`_${postId}`)) return true;
  }
  return _seenPosts[`search_${postId}`] === true;
}

function markPostSeen(postId: string, channelId: string): void {
  _seenPosts[`${channelId}_${postId}`] = true;
}

// ─── Relative Time Parsing ───────────────────────────────

/**
 * Threads의 상대 시간 텍스트("2시간 전", "3일 전", "3월 5일" 등)를 Date로 변환.
 * 변환 실패 시 null 반환.
 */
function parseRelativeTime(timeText: string): Date | null {
  const now = new Date();
  const t = timeText.trim();

  // "N초 전", "N분 전", "Ns ago", "Nm ago"
  const secMatch = t.match(/(\d+)\s*초\s*전/) || t.match(/(\d+)\s*s\s*ago/i);
  if (secMatch) { now.setSeconds(now.getSeconds() - parseInt(secMatch[1])); return now; }

  const minMatch = t.match(/(\d+)\s*분\s*전/) || t.match(/(\d+)\s*m\s*ago/i);
  if (minMatch) { now.setMinutes(now.getMinutes() - parseInt(minMatch[1])); return now; }

  // "N시간 전", "Nh ago"
  const hourMatch = t.match(/(\d+)\s*시간\s*전/) || t.match(/(\d+)\s*h\s*ago/i);
  if (hourMatch) { now.setHours(now.getHours() - parseInt(hourMatch[1])); return now; }

  // "N일 전", "Nd ago"
  const dayMatch = t.match(/(\d+)\s*일\s*전/) || t.match(/(\d+)\s*d\s*ago/i);
  if (dayMatch) { now.setDate(now.getDate() - parseInt(dayMatch[1])); return now; }

  // "N주 전", "Nw ago"
  const weekMatch = t.match(/(\d+)\s*주\s*전/) || t.match(/(\d+)\s*w\s*ago/i);
  if (weekMatch) { now.setDate(now.getDate() - parseInt(weekMatch[1]) * 7); return now; }

  // "3월 5일", "1월 15일" (올해)
  const koDateMatch = t.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (koDateMatch) {
    return new Date(now.getFullYear(), parseInt(koDateMatch[1]) - 1, parseInt(koDateMatch[2]));
  }

  // "2026년 1월 5일" or "2025년 12월"
  const koFullMatch = t.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (koFullMatch) {
    return new Date(parseInt(koFullMatch[1]), parseInt(koFullMatch[2]) - 1, parseInt(koFullMatch[3]));
  }

  // "Mar 5", "Jan 15"
  const enDateMatch = t.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/i);
  if (enDateMatch) {
    const months: Record<string, number> = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    return new Date(now.getFullYear(), months[enDateMatch[1].toLowerCase()], parseInt(enDateMatch[2]));
  }

  return null;
}

/**
 * 포스트가 maxAgeDays 이내인지 확인.
 */
function isWithinAge(timeText: string | null, maxAgeDays: number): boolean {
  if (!timeText) return true; // 시간 정보 없으면 일단 포함
  const postDate = parseRelativeTime(timeText);
  if (!postDate) return true; // 파싱 실패하면 일단 포함
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  return postDate >= cutoff;
}

// ─── View Count — Post Detail Page ───────────────────────

async function fetchViewCount(page: Page, permalink: string): Promise<number | null> {
  try {
    await page.goto(permalink, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await humanDelay(2000, 4000);

    const viewCount = await page.evaluate((): number | null => {
      const parseNum = (str: string): number => {
        str = str.trim().replace(/,/g, '');
        if (str.includes('만')) return Math.round(parseFloat(str) * 10000);
        if (str.includes('천')) return Math.round(parseFloat(str) * 1000);
        if (/[Kk]$/.test(str)) return Math.round(parseFloat(str) * 1000);
        if (/[Mm]$/.test(str)) return Math.round(parseFloat(str) * 1000000);
        return parseInt(str, 10) || 0;
      };

      const allText = document.body.innerText || '';

      // Korean pattern: "조회 N회"
      const koMatch = allText.match(/조회\s*([\d,.]+(?:\.\d+)?[만천]?)\s*회/);
      if (koMatch) return parseNum(koMatch[1]);

      // English pattern: "N views"
      const enMatch = allText.match(/([\d,.]+(?:\.\d+)?[KkMm]?)\s*views?/i);
      if (enMatch) {
        const v = enMatch[1].replace(/,/g, '');
        if (/[Kk]$/.test(v)) return Math.round(parseFloat(v) * 1000);
        if (/[Mm]$/.test(v)) return Math.round(parseFloat(v) * 1000000);
        return parseInt(v, 10) || 0;
      }

      return null;
    });

    return viewCount && viewCount > 0 ? viewCount : null;
  } catch {
    return null;
  }
}

// ─── Search Page Extraction ───────────────────────────────

async function extractPostsFromSearch(
  page: Page,
  keyword: string,
  maxPosts: number,
): Promise<ExtractedPost[]> {
  const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(keyword)}&serp_type=default`;
  log(`  URL: ${searchUrl}`);

  // Create GraphQL interceptor BEFORE navigation
  const interceptor = createGraphQLInterceptor(page);

  try {
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await humanDelay(3000, 6000);

      // Switch to "최근" (Recent) tab for trending/latest posts
      const recentClicked = await page.evaluate(() => {
        const allElements = document.querySelectorAll('a, button, [role="tab"], [role="button"]');
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          if (text === '최근' || text === 'Recent' || text === '최신') {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (recentClicked) {
        log(`  최신순 탭 전환 성공`);
        await humanDelay(2000, 4000);
      } else {
        log(`  최신순 탭 없음 — 기본 정렬로 진행`);
      }
    } catch (err) {
      log(`  로드 실패: ${(err as Error).message}`);
      return [];
    }

    // Scroll to load more results (up to 10 rounds for better coverage)
    const scrollRounds = Math.min(Math.ceil(maxPosts / 3), 10);
    for (let i = 0; i < scrollRounds; i++) {
      const scrollAmt = 400 + Math.floor(Math.random() * 400);
      await page.mouse.wheel(0, scrollAmt);
      await humanDelay(2000, 4000);
      if (Math.random() < 0.2) {
        await page.mouse.wheel(0, -scrollAmt * 0.2);
        await humanDelay(500, 1000);
      }
    }

    // ── Strategy 1: GraphQL intercepted posts (preferred — accurate data) ──
    const gqlPosts = interceptor.getCollectedPosts();
    if (gqlPosts.length > 0) {
      log(`  GraphQL 캡처: ${gqlPosts.length}개 (정확한 데이터)`);
      return gqlPosts.slice(0, maxPosts);
    }

    // ── Strategy 2: DOM fallback (less accurate, but works without GraphQL) ──
    log(`  GraphQL 응답 없음 — DOM 파싱 폴백`);
    const posts = await extractPostsFromDOM(page);
    return posts.slice(0, maxPosts);
  } finally {
    interceptor.destroy();
  }
}

// ─── DOM Fallback Extraction ─────────────────────────────

async function extractPostsFromDOM(page: Page): Promise<ExtractedPost[]> {
  const posts = await page.evaluate((baseUrl: string): Array<{
    post_id: string;
    author: string;
    text: string;
    permalink: string;
    like_count: number;
    reply_count: number;
    repost_count: number;
    has_image: boolean;
    time_text: string | null;
  }> => {
    const results: Array<{
      post_id: string;
      author: string;
      text: string;
      permalink: string;
      like_count: number;
      reply_count: number;
      repost_count: number;
      has_image: boolean;
      time_text: string | null;
    }> = [];

    const seen = new Set<string>();

    const parseNum = (str: string): number => {
      if (!str) return 0;
      str = str.trim();
      if (str.includes('만')) return Math.round(parseFloat(str.replace('만', '')) * 10000);
      if (str.includes('천')) return Math.round(parseFloat(str.replace('천', '')) * 1000);
      if (str.includes('K') || str.includes('k')) return Math.round(parseFloat(str) * 1000);
      if (str.includes('M') || str.includes('m')) return Math.round(parseFloat(str) * 1000000);
      return parseInt(str.replace(/,/g, ''), 10) || 0;
    };

    const postLinks = document.querySelectorAll('a[href*="/post/"]');

    for (const link of postLinks) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/@([^/]+)\/post\/([^/?#]+)/);
      if (!match) continue;

      const author = match[1];
      const postId = match[2];
      if (seen.has(postId)) continue;
      seen.add(postId);

      // Find container
      let container: Element | null = link.closest('[data-pressable-container]')
        || link.closest('article')
        || null;

      if (!container) {
        let el: HTMLElement | null = link as HTMLElement;
        for (let i = 0; i < 10; i++) {
          el = el?.parentElement || null;
          if (!el) break;
          if ((el.textContent || '').length > 30) { container = el; break; }
        }
      }

      if (!container) continue;

      // Extract text
      const skipExact = new Set([
        author, '팔로우', '더 보기', '좋아요', '답글', '리포스트', '공유하기',
        '인기순', '활동 보기', '수정됨', '작성자', '·',
        'Follow', 'Like', 'Reply', 'Repost', 'Share', 'More',
      ]);

      const textParts: string[] = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const t = (node.textContent || '').trim();
        if (!t || t.length < 2) continue;
        const el = node.parentElement;
        if (!el) continue;
        if (el.closest('time') || el.closest('button')) continue;
        if (el.closest(`a[href*="/@${author}"]`) && t === author) continue;
        if (skipExact.has(t)) continue;
        if (/^\d+$/.test(t) || t === '/') continue;
        if (t.includes('님의 프로필 사진') || t.includes('profile picture')) continue;
        textParts.push(t);
      }

      const deduped: string[] = [];
      for (const part of textParts) {
        if (deduped.length === 0 || deduped[deduped.length - 1] !== part) deduped.push(part);
      }

      const postText = deduped.join('\n').trim();
      if (postText.length < 10) continue;

      // Metrics from buttons
      let likeCount = 0;
      let replyCount = 0;
      let repostCount = 0;

      const buttons = container.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const ariaLabel = btn.getAttribute('aria-label') || '';
        if (ariaLabel.includes('좋아요') || ariaLabel.includes('Like')) {
          const m = ariaLabel.match(/([\d,.]+[만천KkMm]?)/);
          if (m) likeCount = parseNum(m[1]);
        } else if (ariaLabel.includes('답글') || ariaLabel.includes('Reply')) {
          const m = ariaLabel.match(/([\d,.]+[만천KkMm]?)/);
          if (m) replyCount = parseNum(m[1]);
        } else if (ariaLabel.includes('리포스트') || ariaLabel.includes('Repost')) {
          const m = ariaLabel.match(/([\d,.]+[만천KkMm]?)/);
          if (m) repostCount = parseNum(m[1]);
        }
      }

      const hasImage = container.querySelectorAll('img:not([alt*="프로필"]):not([alt*="profile"])').length > 0;

      // Extract time text from <time> element or relative time text
      let timeText: string | null = null;
      const timeEl = container.querySelector('time');
      if (timeEl) {
        timeText = timeEl.textContent?.trim() || timeEl.getAttribute('datetime') || null;
      }

      results.push({
        post_id: postId,
        author,
        text: postText,
        permalink: `${baseUrl}/@${author}/post/${postId}`,
        like_count: likeCount,
        reply_count: replyCount,
        repost_count: repostCount,
        has_image: hasImage,
        time_text: timeText,
      });
    }

    return results;
  }, BASE_URL);

  return posts.map(p => ({ ...p, source: 'dom' as const }));
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCliArgs();
  const timestamp = Date.now();
  const runId = `search_${timestamp}`;

  log(`=== Threads 키워드 검색 수집 시작 (run: ${runId}) ===`);
  log(`키워드 ${opts.keywords.length}개, 키워드당 최대 ${opts.postsPerKeyword}개, 최근 ${opts.maxAgeDays}일 이내만 수집`);

  // Load dedup state
  loadSeenPosts();

  // Connect browser
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

  // Polyfill: tsx/esbuild __name() calls don't exist in browser context
  await context.addInitScript({ content: 'window.__name = (fn, _name) => fn;' });
  await page.evaluate('window.__name = (fn, _name) => fn');

  let totalFound = 0;
  let totalInserted = 0;
  const collectedPosts: ExtractedPost[] = [];

  try {
    for (let ki = 0; ki < opts.keywords.length; ki++) {
      const keyword = opts.keywords[ki];
      log(`\n▶ [${ki + 1}/${opts.keywords.length}] 키워드: "${keyword}"`);

      const rawPosts = await extractPostsFromSearch(page, keyword, opts.postsPerKeyword);
      const gqlCount = rawPosts.filter(p => p.source === 'graphql').length;
      const domCount = rawPosts.filter(p => p.source === 'dom').length;
      log(`  검색 결과: ${rawPosts.length}개 (GraphQL: ${gqlCount}, DOM: ${domCount})`);
      totalFound += rawPosts.length;

      let newCount = 0;
      let skipCount = 0;
      let tooOldCount = 0;

      for (const raw of rawPosts) {
        if (isPostSeen(raw.post_id)) {
          skipCount++;
          continue;
        }

        // 날짜 필터: maxAgeDays 이내 포스트만 수집
        // GraphQL 소스: 정확한 unix timestamp로 직접 비교
        // DOM 소스: 상대시간 텍스트 파싱 (isWithinAge)
        const cutoffMs = Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000;
        if (raw.source === 'graphql' && raw.timestamp_unix) {
          if (raw.timestamp_unix * 1000 < cutoffMs) {
            tooOldCount++;
            log(`  스킵 (${opts.maxAgeDays}일 이상): ${raw.post_id} (${new Date(raw.timestamp_unix * 1000).toISOString()})`);
            continue;
          }
        } else if (!isWithinAge(raw.time_text, opts.maxAgeDays)) {
          tooOldCount++;
          log(`  스킵 (${opts.maxAgeDays}일 이상): ${raw.post_id} (${raw.time_text})`);
          continue;
        }

        // Visit post detail page to get view count
        log(`  포스트 상세 조회: ${raw.post_id}`);
        const viewCount = await fetchViewCount(page, raw.permalink);

        // Insert to DB
        try {
          const rows = await db
            .insert(threadPosts)
            .values({
              post_id: raw.post_id,
              channel_id: raw.author,
              author: raw.author,
              text: raw.text,
              permalink: raw.permalink,
              timestamp: raw.timestamp_unix ? new Date(raw.timestamp_unix * 1000) : undefined,
              view_count: viewCount,
              like_count: raw.like_count,
              reply_count: raw.reply_count,
              repost_count: raw.repost_count,
              has_image: raw.has_image,
              media_urls: raw.media_urls?.length ? raw.media_urls : undefined,
              link_url: raw.link_url ?? undefined,
              post_source: opts.source,
              crawl_at: new Date(),
              run_id: runId,
            })
            .onConflictDoNothing()
            .returning({ post_id: threadPosts.post_id });

          if (rows.length > 0) {
            totalInserted++;
            newCount++;
            collectedPosts.push(raw);
          }
        } catch (err) {
          log(`  DB 저장 실패 (${raw.post_id}): ${(err as Error).message}`);
        }

        markPostSeen(raw.post_id, raw.author);

        // Anti-bot: 15–30s delay between posts
        const postDelay = await humanDelay(15000, 30000);
        log(`  다음 포스트까지 대기: ${(postDelay / 1000).toFixed(1)}초`);
      }

      log(`  신규: ${newCount}개, 중복 스킵: ${skipCount}개, 오래된 포스트: ${tooOldCount}개`);
      saveSeenPosts();

      // Anti-bot: 60–120s delay between keywords
      if (ki < opts.keywords.length - 1) {
        const kwDelay = await humanDelay(60000, 120000);
        log(`  다음 키워드까지 대기: ${(kwDelay / 1000).toFixed(1)}초`);
      }
    }

    // After the main post collection loop, if --with-comments
    if (opts.withComments) {
      log('\n== 댓글 수집 시작 (reply_count >= 10 포스트만) ==');

      // Get posts with high reply count from this run
      const highReplyPosts = collectedPosts.filter(p => p.reply_count >= 10);
      log(`답글 10개 이상 포스트: ${highReplyPosts.length}개`);

      for (const post of highReplyPosts) {
        log(`  댓글 수집: ${post.post_id} (답글 ${post.reply_count}개)`);

        // Navigate to post page
        await page.goto(post.permalink, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await humanDelay(3000, 5000);

        // Scroll to load comments
        for (let s = 0; s < 5; s++) {
          await page.keyboard.press('End');
          await humanDelay(1500, 2500);
        }

        // Extract comments via DOM
        const comments = await page.evaluate((_postAuthor: string) => {
          const results: Array<{
            author: string;
            text: string;
            like_count: number;
          }> = [];
          const seen = new Set<string>();

          const containers = document.querySelectorAll('[data-pressable-container]');
          for (const container of containers) {
            // Get author
            const authorLink = container.querySelector('a[href*="/@"]');
            const author = authorLink?.getAttribute('href')?.replace('/@', '').split('/')[0] || '';

            // Get text via TreeWalker
            const skipExact = new Set([
              '팔로우', '더 보기', '좋아요', '답글', '리포스트', '공유하기',
              '작성자', '인기순', '활동 보기', '원본 작성자가 좋아함', '·',
            ]);

            const textParts: string[] = [];
            const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
              const t = (node.textContent || '').trim();
              if (!t || t.length < 2) continue;
              const el = node.parentElement;
              if (!el) continue;
              if (el.closest('time') || el.closest('button')) continue;
              if (skipExact.has(t)) continue;
              if (/^\d+$/.test(t) || t === '/') continue;
              if (t.includes('프로필 사진')) continue;
              if (/^\d+시간$/.test(t) || /^\d+분$/.test(t)) continue;
              textParts.push(t);
            }

            const text = textParts.filter(t => !skipExact.has(t) && t !== author).join(' ').trim();
            if (!text || text.length < 5 || seen.has(text)) continue;
            seen.add(text);

            // Get like count from aria-label
            let likeCount = 0;
            const likeBtn = container.querySelector('button[aria-label*="좋아요"], button[aria-label*="Like"]');
            if (likeBtn) {
              const match = likeBtn.getAttribute('aria-label')?.match(/(\d+)/);
              if (match) likeCount = parseInt(match[1]);
            }
            // Also try button text content
            if (likeCount === 0) {
              const btns = container.querySelectorAll('button');
              for (const btn of btns) {
                const label = btn.textContent || '';
                if ((label.includes('좋아요') || label.includes('Like')) && /\d/.test(label)) {
                  const m = label.match(/(\d+)/);
                  if (m) likeCount = parseInt(m[1]);
                }
              }
            }

            if (author) {
              results.push({ author, text: text.slice(0, 500), like_count: likeCount });
            }
          }

          return results;
        }, '');

        // Save to thread_comments table
        let savedCount = 0;
        for (const comment of comments) {
          const commentId = `${post.post_id}_${comment.author}_${Date.now()}`;
          try {
            await db.insert(threadComments).values({
              comment_id: commentId,
              post_id: post.post_id,
              author: comment.author,
              text: comment.text,
              like_count: comment.like_count,
              crawl_at: new Date(),
            }).onConflictDoNothing();
            savedCount++;
          } catch {}
        }

        log(`  저장: ${savedCount}개 댓글`);
        await humanDelay(2000, 4000);
      }
    }
  } finally {
    saveSeenPosts();
    await browser.close();
    log('\n브라우저 disconnect 완료');
  }

  log('\n=== 수집 완료 ===');
  log(`총 발견: ${totalFound}개`);
  log(`DB 신규 저장: ${totalInserted}개`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
