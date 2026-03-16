#!/usr/bin/env tsx
/**
 * collect-by-keyword.ts — Threads 키워드 검색 기반 소비자 포스트 수집
 *
 * 카테고리별 소비자 니즈 키워드로 Threads 검색 → 포스트 직접 수집.
 * discover.ts(채널 발굴)와 달리 검색 결과의 포스트 자체를 수집한다.
 *
 * Usage:
 *   npx tsx scripts/collect-by-keyword.ts
 *   npx tsx scripts/collect-by-keyword.ts --categories "건강식품,뷰티"
 *   npx tsx scripts/collect-by-keyword.ts --max-per-keyword 15
 *   npx tsx scripts/collect-by-keyword.ts --dry-run
 */

import { chromium } from 'playwright';
import type { Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { execSync } from 'child_process';
import type { CanonicalPost, Tags } from '../src/types.js';
import { savePostsToDB } from '../src/scraper/db-adapter.js';

// ─── Config ──────────────────────────────────────────────

const CDP_URL = 'http://127.0.0.1:9223';
const BASE_URL = 'https://www.threads.net';
const DATA_DIR = path.join(__dirname, '..', 'data');
const KEYWORDS_PATH = path.join(DATA_DIR, 'consumer_keywords.json');
const OUTPUT_DIR = path.join(DATA_DIR, 'keyword_posts');
const SEEN_POSTS_PATH = path.join(DATA_DIR, 'seen_posts.json');
const COLLECTION_LOG_PATH = path.join(DATA_DIR, 'keyword_collection_log.json');

const TIMING = {
  pageLoad:        { min: 3000, max: 6000 },
  scrollPause:     { min: 2000, max: 4000 },
  betweenKeywords: { min: 30000, max: 60000 },
  betweenScrolls:  { min: 2000, max: 5000 },
  mouseMove:       { min: 100, max: 500 },
  postExtract:     { min: 1000, max: 2000 },
};

const DEFAULT_MAX_PER_KEYWORD = 12;

// ─── Types ───────────────────────────────────────────────

interface ConsumerKeyword {
  keyword: string;
  category: string;
  target_need: string;
  expected_post_type: string;
}

interface KeywordPlan {
  category: string;
  keywords: ConsumerKeyword[];
}

interface KeywordsPlanFile {
  keyword_plans: KeywordPlan[];
}

interface ExtractedPost {
  post_id: string;
  author: string;
  text: string;
  permalink: string;
  like_count: number;
  reply_count: number;
  repost_count: number;
  has_image: boolean;
  timestamp_text: string;
}

interface CollectionResult {
  keyword: string;
  category: string;
  posts_found: number;
  posts_new: number;
  posts_skipped: number;
}

interface CliOptions {
  categories: string[] | null;
  maxPerKeyword: number;
  dryRun: boolean;
  topCategories: number;
}

// ─── Utility Functions ───────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function gaussRandom(min: number, max: number): number {
  const mean = (min + max) / 2;
  const stddev = (max - min) / 6;
  let u: number, v: number, s: number;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; }
  while (s >= 1 || s === 0);
  const mul = Math.sqrt(-2 * Math.log(s) / s);
  return Math.round(Math.max(min, Math.min(max, mean + stddev * u * mul)));
}

async function humanDelay(timing: { min: number; max: number }): Promise<number> {
  const ms = gaussRandom(timing.min, timing.max);
  await new Promise(r => setTimeout(r, ms));
  return ms;
}

function getRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `kw_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function atomicWriteJSON(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ─── Seen Posts Dedup ────────────────────────────────────

let _seenPosts: Record<string, boolean> = {};

function loadSeenPosts(): void {
  try {
    if (fs.existsSync(SEEN_POSTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SEEN_POSTS_PATH, 'utf-8'));
      _seenPosts = data.posts || {};
      log(`dedup 원장 로드: ${Object.keys(_seenPosts).length}개 기록`);
    }
  } catch {
    log('seen_posts.json 로드 실패 — 빈 상태로 초기화');
    _seenPosts = {};
  }
}

function saveSeenPosts(): void {
  const data = {
    version: '1.0',
    updated_at: new Date().toISOString(),
    posts: _seenPosts,
  };
  atomicWriteJSON(SEEN_POSTS_PATH, data);
}

function isPostSeen(postId: string): boolean {
  // Check with wildcard channel (keyword search doesn't have channel_id upfront)
  for (const key of Object.keys(_seenPosts)) {
    if (key.endsWith(`_${postId}`)) return true;
  }
  return _seenPosts[`search_${postId}`] === true;
}

function markPostSeen(postId: string, channelId: string): void {
  _seenPosts[`${channelId}_${postId}`] = true;
}

// ─── Health Gate ─────────────────────────────────────────

async function healthGate(): Promise<void> {
  try {
    await new Promise<string>((resolve, reject) => {
      const req = http.get('http://127.0.0.1:9223/json/version', { timeout: 10000 }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) resolve(body);
          else reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    log('CDP 연결 확인 완료');
  } catch {
    log('CDP 연결 실패 — Chrome 자동 실행 시도...');
    try {
      execSync('cmd.exe /c start "" "C:\\Users\\campu\\OneDrive\\Desktop\\Chrome (Claude).lnk"', {
        timeout: 5000, stdio: 'pipe',
      });
      let connected = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          await new Promise<string>((resolve, reject) => {
            const req = http.get('http://127.0.0.1:9223/json/version', { timeout: 3000 }, (res) => {
              let body = '';
              res.on('data', (chunk: Buffer) => { body += chunk; });
              res.on('end', () => {
                if (res.statusCode === 200) resolve(body);
                else reject(new Error(`HTTP ${res.statusCode}`));
              });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          });
          connected = true;
          break;
        } catch { /* retry */ }
      }
      if (!connected) throw new Error('Chrome started but CDP not responding after 20s');
      log('Chrome 자동 실행 + CDP 연결 확인 완료');
    } catch (launchErr) {
      console.error(`Chrome 자동 실행 실패: ${(launchErr as Error).message}`);
      console.error('   Chrome을 --remote-debugging-port=9223 으로 수동 실행하세요.');
      process.exit(1);
    }
  }
}

// ─── Human-like Behavior ─────────────────────────────────

async function randomMouseMove(page: Page): Promise<void> {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const x = randInt(100, vp.width - 100);
  const y = randInt(100, vp.height - 100);
  await page.mouse.move(x, y, { steps: randInt(5, 15) });
  await humanDelay(TIMING.mouseMove);
}

async function humanScroll(page: Page): Promise<void> {
  const scrollAmount = randInt(300, 800);
  await page.mouse.wheel(0, scrollAmount);
  await humanDelay(TIMING.scrollPause);
  // Occasional small scroll-up (natural reading)
  if (Math.random() < 0.15) {
    await page.mouse.wheel(0, -scrollAmount * 0.2);
    await humanDelay({ min: 300, max: 700 });
  }
}

// ─── Post Extraction from Search Results ─────────────────

async function extractPostsFromSearch(
  page: Page,
  keyword: string,
  maxPosts: number,
): Promise<ExtractedPost[]> {
  const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(keyword)}&serp_type=default`;
  log(`  검색 URL: ${searchUrl}`);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await humanDelay(TIMING.pageLoad);
  } catch (err) {
    log(`  페이지 로드 실패: ${(err as Error).message}`);
    return [];
  }

  // Check if we need to click "Posts" tab (Threads search may default to "Top" or profiles)
  try {
    // Look for tab navigation and click on posts/recent tab if available
    const tabClicked = await page.evaluate(() => {
      // Polyfill: tsx/esbuild injects __name() calls that don't exist in browser context
      const __name = (fn: any, _name: string) => fn;

      // Try various tab selector patterns for Threads search
      const tabSelectors = [
        // Korean UI
        'span:has-text("최근")',
        'div[role="tab"]:has-text("최근")',
        // English UI
        'span:has-text("Recent")',
        'div[role="tab"]:has-text("Recent")',
      ];

      // Find visible tabs
      const allSpans = document.querySelectorAll('span, div[role="tab"]');
      for (const el of allSpans) {
        const text = el.textContent?.trim() || '';
        if (text === '최근' || text === 'Recent') {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    if (tabClicked) {
      log('  "최근" 탭 클릭');
      await humanDelay(TIMING.pageLoad);
    }
  } catch {
    // Tab click failed — continue with default view
  }

  // Scroll to load posts
  const scrollRounds = Math.min(Math.ceil(maxPosts / 3), 8);
  for (let i = 0; i < scrollRounds; i++) {
    await humanScroll(page);
    if (Math.random() < 0.3) {
      await randomMouseMove(page);
    }
    await humanDelay(TIMING.betweenScrolls);
  }

  // Extract posts from search results
  const posts = await page.evaluate((baseUrl: string) => {
    // Polyfill: tsx/esbuild injects __name() calls that don't exist in browser context
    const __name = (fn: any, _name: string) => fn;

    const results: Array<{
      post_id: string;
      author: string;
      text: string;
      permalink: string;
      like_count: number;
      reply_count: number;
      repost_count: number;
      has_image: boolean;
      timestamp_text: string;
    }> = [];

    const seen = new Set<string>();

    // Strategy 1: Find post links (/@author/post/POST_ID)
    const postLinks = document.querySelectorAll('a[href*="/post/"]');

    for (const link of postLinks) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/@([^/]+)\/post\/([^/?]+)/);
      if (!match) continue;

      const author = match[1];
      const postId = match[2];

      if (seen.has(postId)) continue;
      seen.add(postId);

      // Find the post container (traverse up to find the enclosing post block)
      let container = link.closest('[data-pressable-container]')
        || link.closest('article')
        || link.closest('div[style]');

      // Fallback: walk up DOM tree to find a meaningful container
      if (!container) {
        let el: HTMLElement | null = link as HTMLElement;
        for (let i = 0; i < 10; i++) {
          el = el?.parentElement || null;
          if (!el) break;
          // Look for a container with enough text
          if (el.textContent && el.textContent.length > 30) {
            container = el;
            break;
          }
        }
      }

      if (!container) continue;

      // Extract text — filter out UI elements
      const skipExact = new Set([
        author, '팔로우', '더 보기', '좋아요', '답글', '리포스트',
        '공유하기', '인기순', '활동 보기', '수정됨', '작성자', '·',
        'Follow', 'Like', 'Reply', 'Repost', 'Share', 'More',
      ]);

      const textParts: string[] = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = (node.textContent || '').trim();
        if (!text || text.length < 2) continue;
        const el = node.parentElement;
        if (!el) continue;
        if (el.closest('time')) continue;
        if (el.closest('button')) continue;
        if (el.closest(`a[href*="/@${author}"]`) && text === author) continue;
        if (skipExact.has(text)) continue;
        if (/^\d+$/.test(text)) continue;
        if (text === '/') continue;
        // Skip profile picture alt texts
        if (text.includes('님의 프로필 사진') || text.includes('profile picture')) continue;
        textParts.push(text);
      }

      // Deduplicate consecutive
      const deduped: string[] = [];
      for (const part of textParts) {
        if (deduped.length === 0 || deduped[deduped.length - 1] !== part) {
          deduped.push(part);
        }
      }

      const postText = deduped.join('\n').trim();
      if (postText.length < 10) continue; // Skip very short posts

      // Parse metrics from the container text
      const containerText = container.textContent || '';
      const parseNum = (str: string): number => {
        if (!str) return 0;
        str = str.trim();
        if (str.includes('만')) return Math.round(parseFloat(str.replace('만', '')) * 10000);
        if (str.includes('천')) return Math.round(parseFloat(str.replace('천', '')) * 1000);
        if (str.includes('K') || str.includes('k')) return Math.round(parseFloat(str) * 1000);
        if (str.includes('M') || str.includes('m')) return Math.round(parseFloat(str) * 1000000);
        return parseInt(str.replace(/,/g, ''), 10) || 0;
      };

      // Try to find like/reply/repost buttons and their counts
      let likeCount = 0;
      let replyCount = 0;
      let repostCount = 0;

      const buttons = container.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const ariaLabel = btn.getAttribute('aria-label') || '';
        const btnText = btn.textContent?.trim() || '';

        // Korean patterns
        if (ariaLabel.includes('좋아요') || ariaLabel.includes('Like')) {
          const numMatch = ariaLabel.match(/(\d[\d,.]*[만천KkMm]?)/);
          if (numMatch) likeCount = parseNum(numMatch[1]);
        }
        if (ariaLabel.includes('답글') || ariaLabel.includes('Reply') || ariaLabel.includes('Repl')) {
          const numMatch = ariaLabel.match(/(\d[\d,.]*[만천KkMm]?)/);
          if (numMatch) replyCount = parseNum(numMatch[1]);
        }
        if (ariaLabel.includes('리포스트') || ariaLabel.includes('Repost')) {
          const numMatch = ariaLabel.match(/(\d[\d,.]*[만천KkMm]?)/);
          if (numMatch) repostCount = parseNum(numMatch[1]);
        }
      }

      // Check for images
      const hasImage = container.querySelectorAll('img:not([alt*="프로필"]):not([alt*="profile"])').length > 0;

      // Timestamp
      let timestampText = '';
      const timeEl = container.querySelector('time');
      if (timeEl) {
        timestampText = timeEl.getAttribute('datetime') || timeEl.textContent?.trim() || '';
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
        timestamp_text: timestampText,
      });
    }

    return results;
  }, BASE_URL);

  return posts.slice(0, maxPosts);
}

// ─── Convert to CanonicalPost ────────────────────────────

function toCanonicalPost(
  post: ExtractedPost,
  keyword: string,
  category: string,
  runId: string,
): CanonicalPost {
  // Parse timestamp
  let timestamp = new Date().toISOString();
  if (post.timestamp_text) {
    const parsed = new Date(post.timestamp_text);
    if (!isNaN(parsed.getTime())) {
      timestamp = parsed.toISOString();
    }
  }

  // Auto-tag based on text content
  const tags: Tags = autoTag(post.text);

  return {
    post_id: post.post_id,
    channel_id: post.author,
    author: post.author,
    text: post.text,
    timestamp,
    permalink: post.permalink,
    metrics: {
      view_count: null, // Search results don't show view counts
      like_count: post.like_count,
      reply_count: post.reply_count,
      repost_count: post.repost_count,
    },
    media: {
      has_image: post.has_image,
      urls: [],
    },
    tags,
    thread_type: 'search_result',
    crawl_meta: {
      crawl_at: new Date().toISOString(),
      run_id: runId,
      selector_tier: 'fallback',
      login_status: true,
      block_detected: false,
    },
    channel_meta: {
      display_name: post.author,
      category: `search:${category}`,
    },
  };
}

// ─── Auto-tagging ────────────────────────────────────────

function autoTag(text: string): Tags {
  const lower = text.toLowerCase();

  // Affiliate detection
  const affDomains = ['coupang.com', 'coupa.ng', 'link.coupang.com', 'smartstore.naver.com'];
  const affKeywords = ['쿠팡파트너스', '제휴링크', '파트너스 활동', '수수료를 제공'];

  for (const d of affDomains) {
    if (lower.includes(d)) return { primary: 'affiliate', secondary: ['search_collected'] };
  }
  for (const k of affKeywords) {
    if (text.includes(k)) return { primary: 'affiliate', secondary: ['search_collected'] };
  }

  // Purchase signal detection
  const purchaseSignals = [
    '사고싶다', '살까', '구매', '주문', '장바구니', '결제',
    '어디서 사', '어디서사', '사야되', '사야지', '사려고',
  ];
  for (const sig of purchaseSignals) {
    if (text.includes(sig)) return { primary: 'purchase_signal', secondary: ['search_collected'] };
  }

  // Review detection
  const reviewSignals = ['써봤는데', '써본', '사용해봤', '후기', '리뷰', '솔직', '체험'];
  for (const sig of reviewSignals) {
    if (text.includes(sig)) return { primary: 'review', secondary: ['search_collected'] };
  }

  // Interest/recommendation request
  const interestSignals = ['추천', '뭐가 좋', '뭐가좋', '어떤게', '고민', '알려줘', '추천해줘'];
  for (const sig of interestSignals) {
    if (text.includes(sig)) return { primary: 'interest', secondary: ['search_collected'] };
  }

  // Complaint
  const complaintSignals = ['별로', '실망', '후회', '환불', '짜증', '짜릿', '최악'];
  for (const sig of complaintSignals) {
    if (text.includes(sig)) return { primary: 'complaint', secondary: ['search_collected'] };
  }

  return { primary: 'general', secondary: ['search_collected'] };
}

// ─── CLI Args ────────────────────────────────────────────

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    categories: null,
    maxPerKeyword: DEFAULT_MAX_PER_KEYWORD,
    dryRun: false,
    topCategories: 5,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--categories' && args[i + 1]) {
      opts.categories = args[i + 1].split(',').map(k => k.trim());
      i++;
    } else if (args[i] === '--max-per-keyword' && args[i + 1]) {
      opts.maxPerKeyword = parseInt(args[i + 1], 10) || DEFAULT_MAX_PER_KEYWORD;
      i++;
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--top' && args[i + 1]) {
      opts.topCategories = parseInt(args[i + 1], 10) || 5;
      i++;
    }
  }

  return opts;
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCliArgs();
  const runId = getRunId();
  log(`=== Threads 키워드 검색 수집 시작 (run: ${runId}) ===`);

  if (opts.dryRun) {
    log('*** DRY RUN 모드 — 브라우저 연결 없이 키워드 플랜만 출력 ***');
  }

  // Load keyword plan
  if (!fs.existsSync(KEYWORDS_PATH)) {
    console.error(`키워드 플랜 파일 없음: ${KEYWORDS_PATH}`);
    console.error('먼저 npx tsx scripts/analyze-categories.ts 를 실행하세요.');
    process.exit(1);
  }

  const keywordPlan: KeywordsPlanFile = JSON.parse(fs.readFileSync(KEYWORDS_PATH, 'utf-8'));
  let plans = keywordPlan.keyword_plans;

  // Filter categories if specified
  if (opts.categories) {
    plans = plans.filter(p => opts.categories!.includes(p.category));
    log(`카테고리 필터: ${opts.categories.join(', ')}`);
  }

  // Limit to top N categories (by product count, which is the plan order)
  plans = plans.slice(0, opts.topCategories);

  // Flatten keywords
  const allKeywords = plans.flatMap(p => p.keywords);
  log(`수집 대상: ${plans.length}개 카테고리, ${allKeywords.length}개 키워드`);
  log(`키워드당 최대 포스트: ${opts.maxPerKeyword}개`);
  log(`예상 총 포스트: ~${allKeywords.length * opts.maxPerKeyword}개\n`);

  for (const plan of plans) {
    log(`[${plan.category}] 키워드: ${plan.keywords.map(k => k.keyword).join(', ')}`);
  }

  if (opts.dryRun) {
    log('\n--- DRY RUN 완료 ---');
    return;
  }

  // Health gate
  await healthGate();

  // Load seen posts
  loadSeenPosts();

  // Connect to browser
  log(`\nCDP 연결: ${CDP_URL}`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.error(`CDP 연결 실패: ${(err as Error).message}`);
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error('브라우저 컨텍스트를 찾을 수 없습니다.');
    await browser.close();
    process.exit(1);
  }

  const page = context.pages()[0] || await context.newPage();

  // Inject __name polyfill: tsx/esbuild's keepNames transform injects __name() calls
  // that don't exist in the browser context, causing ReferenceError in page.evaluate().
  // addInitScript runs on every navigation, ensuring __name is always available.
  await context.addInitScript({ content: 'window.__name = (fn, _name) => fn;' });
  // Also set it on the current page immediately (addInitScript only fires on next nav)
  await page.evaluate('window.__name = (fn, _name) => fn');

  // Collection loop
  const results: CollectionResult[] = [];
  const allCollectedPosts: CanonicalPost[] = [];
  let totalNew = 0;
  let totalFound = 0;

  try {
    for (let planIdx = 0; planIdx < plans.length; planIdx++) {
      const plan = plans[planIdx];
      log(`\n━━━ [${plan.category}] 카테고리 수집 시작 (${planIdx + 1}/${plans.length}) ━━━`);

      for (let kwIdx = 0; kwIdx < plan.keywords.length; kwIdx++) {
        const kw = plan.keywords[kwIdx];
        log(`\n▶ 키워드: "${kw.keyword}" (${kwIdx + 1}/${plan.keywords.length})`);

        // Extract posts from search
        const rawPosts = await extractPostsFromSearch(page, kw.keyword, opts.maxPerKeyword);
        log(`  검색 결과: ${rawPosts.length}개 포스트 추출`);

        let newCount = 0;
        let skipCount = 0;

        for (const rawPost of rawPosts) {
          if (isPostSeen(rawPost.post_id)) {
            skipCount++;
            continue;
          }

          const canonical = toCanonicalPost(rawPost, kw.keyword, kw.category, runId);
          allCollectedPosts.push(canonical);
          markPostSeen(rawPost.post_id, rawPost.author);
          newCount++;
        }

        totalFound += rawPosts.length;
        totalNew += newCount;

        results.push({
          keyword: kw.keyword,
          category: kw.category,
          posts_found: rawPosts.length,
          posts_new: newCount,
          posts_skipped: skipCount,
        });

        log(`  신규: ${newCount}개, 중복 스킵: ${skipCount}개`);

        // Save seen posts after each keyword
        saveSeenPosts();

        // Anti-bot delay between keywords
        if (kwIdx < plan.keywords.length - 1 || planIdx < plans.length - 1) {
          const delay = await humanDelay(TIMING.betweenKeywords);
          log(`  키워드 간 대기: ${(delay / 1000).toFixed(1)}초`);
        }
      }
    }

    // Save all collected posts to JSON
    if (allCollectedPosts.length > 0) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const outputPath = path.join(OUTPUT_DIR, `${runId}.json`);
      atomicWriteJSON(outputPath, {
        meta: {
          run_id: runId,
          collected_at: new Date().toISOString(),
          total_posts: allCollectedPosts.length,
          keywords_searched: allKeywords.length,
          categories: plans.map(p => p.category),
        },
        posts: allCollectedPosts,
      });
      log(`\nJSON 저장: ${outputPath} (${allCollectedPosts.length}개 포스트)`);

      // Save to DB
      try {
        const dbInserted = await savePostsToDB(allCollectedPosts, runId);
        log(`DB 저장: ${dbInserted}/${allCollectedPosts.length}개 신규 포스트`);
      } catch (e) {
        log(`DB 저장 실패 (JSON은 정상 저장됨): ${(e as Error).message}`);
      }
    }

    // Save collection log
    const collectionLog = {
      run_id: runId,
      completed_at: new Date().toISOString(),
      total_keywords: allKeywords.length,
      total_posts_found: totalFound,
      total_posts_new: totalNew,
      categories: plans.map(p => p.category),
      results,
    };
    atomicWriteJSON(COLLECTION_LOG_PATH, collectionLog);

    // Print summary
    log('\n=== 수집 결과 요약 ===');
    log(`총 포스트 발견: ${totalFound}개`);
    log(`신규 포스트: ${totalNew}개`);
    log(`중복 스킵: ${totalFound - totalNew}개`);
    log('\n카테고리별 결과:');

    const categoryTotals = new Map<string, { found: number; new_posts: number }>();
    for (const r of results) {
      const existing = categoryTotals.get(r.category) || { found: 0, new_posts: 0 };
      existing.found += r.posts_found;
      existing.new_posts += r.posts_new;
      categoryTotals.set(r.category, existing);
    }

    for (const [cat, totals] of categoryTotals) {
      log(`  [${cat}] 발견 ${totals.found}개, 신규 ${totals.new_posts}개`);
    }

  } catch (err) {
    console.error(`수집 실패: ${(err as Error).message}`);
    // Save partial results
    if (allCollectedPosts.length > 0) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const outputPath = path.join(OUTPUT_DIR, `${runId}_partial.json`);
      atomicWriteJSON(outputPath, {
        meta: {
          run_id: runId,
          collected_at: new Date().toISOString(),
          total_posts: allCollectedPosts.length,
          partial: true,
          error: (err as Error).message,
        },
        posts: allCollectedPosts,
      });
      log(`부분 결과 저장: ${outputPath}`);

      try {
        await savePostsToDB(allCollectedPosts, runId);
      } catch { /* ignore DB errors on partial save */ }
    }
    saveSeenPosts();
  } finally {
    await browser.close();
    log('브라우저 disconnect 완료');
  }
}

// Run CLI if executed directly
const isDirectRun = process.argv[1] &&
  (process.argv[1].endsWith('collect-by-keyword.ts') ||
   process.argv[1].includes('collect-by-keyword'));

if (isDirectRun) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { extractPostsFromSearch, toCanonicalPost, autoTag };
