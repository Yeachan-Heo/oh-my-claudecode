#!/usr/bin/env tsx
/**
 * collect-homefeed.ts — Threads 홈피드 스크롤 기반 포스트 수집
 *
 * 로그인된 Chrome의 홈피드를 스크롤하면서 조회수 높은 포스트만 수집.
 * GraphQL interceptor로 정확한 지표 캡처, 조회수는 상세 페이지에서 확인.
 *
 * Usage:
 *   npx tsx scripts/collect-homefeed.ts                    # 기본: 조회수 5K+, 50개
 *   npx tsx scripts/collect-homefeed.ts --min-views 10000  # 만 조회 이상만
 *   npx tsx scripts/collect-homefeed.ts --limit 100        # 100개까지
 *   npx tsx scripts/collect-homefeed.ts --scroll-rounds 20 # 스크롤 20회
 *   npx tsx scripts/collect-homefeed.ts --preview          # 캡처 포스트 미리보기 (--verbose 동일)
 *   npx tsx scripts/collect-homefeed.ts --help
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectBrowser } from '../src/utils/browser.js';
import { humanDelay } from '../src/utils/timing.js';
import { db } from '../src/db/index.js';
import { threadPosts } from '../src/db/schema.js';
import { createGraphQLInterceptor } from '../src/scraper/graphql-interceptor.js';
import type { Page } from 'playwright';
import type { GraphQLExtractedPost } from '../src/scraper/graphql-interceptor.js';

// ─── Constants ───────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(path.dirname(__dirname), 'data');
const SEEN_POSTS_PATH = path.join(DATA_DIR, 'seen_posts.json');
const HOMEFEED_URL = 'https://www.threads.com';

const DEFAULT_MIN_VIEWS = 5000;
const DEFAULT_LIMIT = 50;
const DEFAULT_SCROLL_ROUNDS = 10;
const DEFAULT_MAX_AGE_DAYS = 3;

// ─── Types ───────────────────────────────────────────────

interface CliOptions {
  minViews: number;
  limit: number;
  scrollRounds: number;
  maxAgeDays: number;
  search: string | null;
  current: boolean;
  resetSeen: boolean;
  preview: boolean;
}

interface SelfReplyDetail {
  replyText: string;
  replyMediaUrls: string[];
  linkUrl: string | null;
  linkDomain: string | null;
  linkLocation: string | null;
  hasAffiliate: boolean;
}

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── CLI ─────────────────────────────────────────────────

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Threads 홈피드 수집기

Usage:
  npx tsx scripts/collect-homefeed.ts [options]

Options:
  --min-views <n>      최소 조회수 필터 (default: ${DEFAULT_MIN_VIEWS})
  --limit <n>          최대 수집 포스트 수 (default: ${DEFAULT_LIMIT})
  --scroll-rounds <n>  스크롤 횟수 (default: ${DEFAULT_SCROLL_ROUNDS})
  --max-age-days <n>   최근 N일 이내만 수집 (default: ${DEFAULT_MAX_AGE_DAYS})
  --search <keyword>   키워드 검색 결과 수집 (threads.com/search?q=키워드)
  --current            현재 열린 탭 그대로 스크롤 (page.goto 생략)
  --reset-seen         seen_posts.json 초기화 후 수집 (중복 필터 리셋)
  --preview, --verbose 캡처된 포스트 미리보기 출력 (전체 텍스트 포함)
  --help, -h           도움말
`);
    process.exit(0);
  }

  let minViews = DEFAULT_MIN_VIEWS;
  let limit = DEFAULT_LIMIT;
  let scrollRounds = DEFAULT_SCROLL_ROUNDS;
  let maxAgeDays = DEFAULT_MAX_AGE_DAYS;
  let search: string | null = null;
  let current = false;
  let resetSeen = false;
  let preview = false;

  const safeParseInt = (val: string, fallback: number): number => {
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? fallback : parsed;
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--min-views' && args[i + 1]) {
      minViews = safeParseInt(args[i + 1], DEFAULT_MIN_VIEWS);
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = safeParseInt(args[i + 1], DEFAULT_LIMIT);
      i++;
    } else if (args[i] === '--scroll-rounds' && args[i + 1]) {
      scrollRounds = safeParseInt(args[i + 1], DEFAULT_SCROLL_ROUNDS);
      i++;
    } else if (args[i] === '--max-age-days' && args[i + 1]) {
      maxAgeDays = safeParseInt(args[i + 1], DEFAULT_MAX_AGE_DAYS);
      i++;
    } else if (args[i] === '--search' && args[i + 1]) {
      search = args[i + 1];
      i++;
    } else if (args[i] === '--current') {
      current = true;
    } else if (args[i] === '--reset-seen') {
      resetSeen = true;
    } else if (args[i] === '--preview' || args[i] === '--verbose') {
      preview = true;
    }
  }

  return { minViews, limit, scrollRounds, maxAgeDays, search, current, resetSeen, preview };
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
  fs.writeFileSync(tmp, JSON.stringify({
    version: '1.0',
    updated_at: new Date().toISOString(),
    posts: _seenPosts,
  }, null, 2), 'utf-8');
  fs.renameSync(tmp, SEEN_POSTS_PATH);
}

function isPostSeen(postId: string): boolean {
  for (const key of Object.keys(_seenPosts)) {
    if (key.endsWith(`_${postId}`)) return true;
  }
  return _seenPosts[`homefeed_${postId}`] === true;
}

function markPostSeen(postId: string, author: string): void {
  _seenPosts[`${author}_${postId}`] = true;
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

      // Korean: "조회 N회"
      const koMatch = allText.match(/조회\s*([\d,.]+(?:\.\d+)?[만천]?)\s*회/);
      if (koMatch) return parseNum(koMatch[1]);

      // English: "N views"
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

// ─── Self-Reply + Affiliate Extraction (detail page already loaded) ───

async function extractSelfReply(page: Page, author: string): Promise<SelfReplyDetail> {
  const empty: SelfReplyDetail = { replyText: '', replyMediaUrls: [], linkUrl: null, linkDomain: null, linkLocation: null, hasAffiliate: false };
  try {
    return await page.evaluate((chId: string): SelfReplyDetail => {
      // ── l.threads.com redirect unwrap (from collect.ts:500-510) ──
      const decodeRedirect = (href: string): string => {
        try {
          const u = new URL(href);
          if (u.hostname === 'l.threads.com' || u.hostname === 'l.threads.net') {
            const real = u.searchParams.get('u');
            if (real) return decodeURIComponent(real);
          }
        } catch {}
        return href;
      };

      // ── Affiliate link extraction (from collect.ts:512-526) ──
      const affDomains = ['coupang.com','coupa.ng','link.coupang.com','musinsa.com','smartstore.naver.com','ali.ski','bit.ly','han.gl'];
      const extractAffLinks = (container: Element): string[] => {
        const links: string[] = [];
        container.querySelectorAll('a[href]').forEach(a => {
          const realHref = decodeRedirect((a as HTMLAnchorElement).href);
          for (const d of affDomains) {
            if (realHref.includes(d)) { links.push(realHref); break; }
          }
        });
        return [...new Set(links)];
      };

      // ── Clean text extraction (from collect.ts:528-568) ──
      const extractCleanText = (block: Element): string => {
        const skipExact = new Set([chId, '팔로우', '더 보기', '좋아요', '답글', '리포스트', '공유하기', '수정됨', '작성자', '·']);
        const skipContains = ['님의 프로필 사진', '오디오 소리', 'Threads 사용자'];
        const parts: string[] = [];
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const text = (node.textContent || '').trim();
          if (!text || text.length < 2) continue;
          const el = node.parentElement;
          if (!el || el.closest('time') || el.closest('button')) continue;
          if (el.closest(`a[href*="/@${chId}"]`)) continue;
          if (skipExact.has(text)) continue;
          if (skipContains.some(p => text.includes(p))) continue;
          if (/^\d+$/.test(text) || text === '/') continue;
          parts.push(text);
        }
        const deduped: string[] = [];
        for (const p of parts) {
          if (!deduped.length || deduped[deduped.length - 1] !== p) deduped.push(p);
        }
        return deduped.join('\n').substring(0, 1500);
      };

      // ── Media extraction (from collect.ts:571-583) ──
      const extractMedia = (block: Element): string[] => {
        const urls: string[] = [];
        block.querySelectorAll('img[src*="cdninstagram"], img[src*="scontent"]').forEach(img => {
          const imgEl = img as HTMLImageElement;
          if (imgEl.width > 100 && imgEl.height > 100) urls.push(imgEl.src);
        });
        block.querySelectorAll('video source[src], video[src]').forEach(v => {
          const videoEl = v as HTMLVideoElement | HTMLSourceElement;
          if (videoEl.src) urls.push(videoEl.src);
        });
        return [...new Set(urls)].slice(0, 10);
      };

      // ── Find hook block + self-reply block (from collect.ts:663-708) ──
      const pageUrl = window.location.href;
      const pagePostIdMatch = pageUrl.match(/\/post\/([A-Za-z0-9_-]+)/);
      const pagePostId = pagePostIdMatch ? pagePostIdMatch[1] : '';

      const blockMap = new Map<string, Element>();
      document.querySelectorAll('a[href*="/post/"]').forEach(link => {
        const href = (link as HTMLAnchorElement).href;
        const m = href.match(/\/post\/([A-Za-z0-9_-]+)/);
        if (!m) return;
        const postId = m[1];
        let el: Element | null = link as Element;
        for (let i = 0; i < 8; i++) {
          el = el.parentElement;
          if (!el) break;
          const hasProfile = el.querySelector(`button[aria-label*="${chId}"]`) ||
                             el.querySelector(`img[alt*="${chId}"]`);
          if (hasProfile && !blockMap.has(postId)) { blockMap.set(postId, el); break; }
        }
      });

      let hookBlock: Element | null = null;
      let replyBlock: Element | null = null;

      const sorted = [...blockMap.entries()].sort((a, b) => {
        const pos = a[1].compareDocumentPosition(b[1]);
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });

      for (const [postId, block] of sorted) {
        if (postId === pagePostId) hookBlock = block;
        else if (hookBlock && !replyBlock) replyBlock = block;
      }

      // Fallback: pressable containers
      if (!hookBlock) {
        const pressables = document.querySelectorAll('[data-pressable-container]');
        if (pressables.length > 0) hookBlock = pressables[0];
        if (pressables.length > 1) {
          const second = pressables[1];
          if (second.querySelectorAll(`a[href*="/@${chId}"]`).length > 0) replyBlock = second;
        }
      }

      // ── Extract + determine affiliate location (from collect.ts:824-956) ──
      const affKeywords = ['쿠팡파트너스','수수료를 제공','파트너스 활동','link.coupang','coupa.ng'];

      const hookAffLinks = hookBlock ? extractAffLinks(hookBlock) : [];
      const hookText = hookBlock ? extractCleanText(hookBlock) : '';
      const hookHasAff = affKeywords.some(kw => hookText.includes(kw)) || hookAffLinks.length > 0;

      let replyText = '';
      let replyMediaUrls: string[] = [];
      let replyAffLinks: string[] = [];
      let replyHasAff = false;

      if (replyBlock) {
        replyText = extractCleanText(replyBlock);
        replyMediaUrls = extractMedia(replyBlock);
        replyAffLinks = extractAffLinks(replyBlock);
        replyHasAff = affKeywords.some(kw => replyText.includes(kw)) || replyAffLinks.length > 0;
      }

      const hasAff = hookHasAff || replyHasAff;
      let linkLocation: string | null = null;
      let linkUrl: string | null = null;
      let linkDomain: string | null = null;

      if (hasAff) {
        if (hookHasAff && replyHasAff) linkLocation = 'both';
        else if (replyHasAff) linkLocation = '답글';
        else linkLocation = '본문';

        const allLinks = [...hookAffLinks, ...replyAffLinks];
        if (allLinks.length > 0) {
          linkUrl = allLinks[0];
          try { linkDomain = new URL(linkUrl).hostname.replace('www.', ''); } catch {}
        }
        if (!linkDomain) {
          const combined = hookText + ' ' + replyText;
          if (combined.includes('coupang.com') || combined.includes('link.coupang')) linkDomain = 'coupang.com';
          else if (combined.includes('musinsa')) linkDomain = 'musinsa.com';
          else if (combined.includes('smartstore.naver')) linkDomain = 'smartstore.naver.com';
        }
      }

      return { replyText, replyMediaUrls, linkUrl, linkDomain, linkLocation, hasAffiliate: hasAff };
    }, author);
  } catch {
    return empty;
  }
}

// ─── Homefeed Detection ─────────────────────────────────

async function detectHomefeed(page: Page): Promise<{ ok: boolean; reason?: string }> {
  const url = page.url();

  // 로그인 페이지 리다이렉트 감지
  if (url.includes('/login') || url.includes('/accounts/login')) {
    return { ok: false, reason: '로그인 페이지로 리다이렉트됨 — 브라우저에서 먼저 로그인 필요' };
  }

  // For you / Following 탭 존재 확인
  const hasFeedTabs = await page.evaluate((): boolean => {
    const text = document.body.innerText || '';
    // 한국어: "For you" / "팔로잉", English: "For you" / "Following"
    const hasForYou = /For you/i.test(text) || text.includes('추천');
    const hasFollowing = /Following/i.test(text) || text.includes('팔로잉');
    return hasForYou || hasFollowing;
  });

  if (!hasFeedTabs) {
    return { ok: false, reason: '홈피드 탭(For you/Following)을 찾을 수 없음 — 올바른 페이지가 아닐 수 있음' };
  }

  return { ok: true };
}

// ─── Homefeed Scroll & Collect ───────────────────────────

async function scrollAndCollect(
  page: Page,
  scrollRounds: number,
  opts: { search: string | null; current: boolean },
): Promise<GraphQLExtractedPost[]> {
  const interceptor = createGraphQLInterceptor(page);
  const source = opts.search ? `검색: "${opts.search}"` : opts.current ? '현재 탭' : '홈피드';

  try {
    if (opts.current) {
      // --current: page.goto 생략, 현재 탭 그대로 사용
      log(`현재 탭 스크롤 시작: ${page.url()}`);
    } else if (opts.search) {
      // --search: 키워드 검색 결과 페이지로 이동
      const searchUrl = `https://www.threads.com/search?q=${encodeURIComponent(opts.search)}&serp_type=default`;
      log(`검색 페이지 로드: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await humanDelay(3000, 5000);
    } else {
      // 기본: 홈피드 이동 + 감지
      log(`홈피드 로드: ${HOMEFEED_URL}`);
      await page.goto(HOMEFEED_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await humanDelay(3000, 5000);

      const detection = await detectHomefeed(page);
      if (!detection.ok) {
        console.error(`홈피드 감지 실패: ${detection.reason}`);
        process.exit(1);
      }
      log('홈피드 감지 성공 ✓');
    }

    log(`${source} 스크롤 시작: ${scrollRounds}회`);
    for (let i = 0; i < scrollRounds; i++) {
      const scrollAmt = 600 + Math.floor(Math.random() * 600);
      await page.mouse.wheel(0, scrollAmt);
      await humanDelay(2000, 4000);

      // 사람처럼 가끔 위로 살짝 스크롤
      if (Math.random() < 0.15) {
        await page.mouse.wheel(0, -scrollAmt * 0.2);
        await humanDelay(500, 1000);
      }

      const collected = interceptor.getCollectedPosts().length;
      if ((i + 1) % 5 === 0) {
        log(`  스크롤 ${i + 1}/${scrollRounds} — GraphQL 캡처: ${collected}개`);
      }
    }

    const posts = interceptor.getCollectedPosts();
    log(`${source} GraphQL 캡처 완료: ${posts.length}개`);
    return posts;
  } finally {
    interceptor.destroy();
  }
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCliArgs();
  const timestamp = Date.now();
  const runId = `homefeed_${timestamp}`;

  const source = opts.search ? `검색:"${opts.search}"` : opts.current ? '현재탭' : '홈피드';
  log(`=== Threads ${source} 수집 시작 (run: ${runId}) ===`);
  log(`조회수 ${opts.minViews.toLocaleString()}+ 필터, 최대 ${opts.limit}개, 최근 ${opts.maxAgeDays}일, 스크롤 ${opts.scrollRounds}회`);

  if (opts.resetSeen) {
    _seenPosts = {};
    log('--reset-seen: seen_posts.json 초기화됨');
  } else {
    loadSeenPosts();
  }

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

  let totalCaptured = 0;
  let totalFiltered = 0;
  let totalInserted = 0;

  try {
    // Step 1: Scroll and capture posts via GraphQL
    const rawPosts = await scrollAndCollect(page, opts.scrollRounds, {
      search: opts.search,
      current: opts.current,
    });
    totalCaptured = rawPosts.length;

    // Preview: 캡처된 포스트 미리보기 출력
    if (rawPosts.length > 0) {
      log(`\n── 캡처 포스트 미리보기 (${rawPosts.length}개) ──`);
      for (let i = 0; i < rawPosts.length; i++) {
        const p = rawPosts[i];
        const textPreview = opts.preview
          ? p.text
          : (p.text.length > 50 ? p.text.slice(0, 50) + '…' : p.text);
        const line = textPreview.replace(/\n/g, ' ');
        log(`  ${String(i + 1).padStart(3)}. @${p.author}  ❤${p.like_count} 💬${p.reply_count}  ${line}`);
      }
      log(`── 미리보기 끝 ──\n`);
    }

    // Step 2: Filter by age and dedup
    const cutoffMs = Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000;
    const candidates: GraphQLExtractedPost[] = [];

    for (const post of rawPosts) {
      if (isPostSeen(post.post_id)) continue;

      // Age filter: GraphQL provides accurate unix timestamp
      if (post.timestamp_unix && post.timestamp_unix * 1000 < cutoffMs) continue;

      candidates.push(post);
    }

    log(`후보 포스트: ${candidates.length}개 (중복/오래된 포스트 제외)`);

    // Step 3: Visit each post detail for view count, filter by minViews
    for (const post of candidates) {
      if (totalInserted >= opts.limit) {
        log(`수집 한도 도달 (${opts.limit}개)`);
        break;
      }

      totalFiltered++;
      log(`  [${totalFiltered}/${candidates.length}] 상세 조회: @${post.author}/${post.post_id}`);
      const viewCount = await fetchViewCount(page, post.permalink);

      if (viewCount === null || viewCount < opts.minViews) {
        log(`    조회수 ${viewCount?.toLocaleString() ?? '?'} — 스킵 (${opts.minViews.toLocaleString()}+ 필요)`);
        markPostSeen(post.post_id, post.author);
        await humanDelay(3000, 6000);
        continue;
      }

      // 상세 페이지 이미 로드됨 — 셀프리플라이 + 제휴링크 추출
      const detail = await extractSelfReply(page, post.author);
      const affInfo = detail.hasAffiliate ? ` [제휴:${detail.linkLocation}]` : '';
      const replyInfo = detail.replyText ? ' [답글✓]' : '';
      log(`    조회수 ${viewCount.toLocaleString()} ✓${replyInfo}${affInfo} — DB 저장`);

      // Build comments from self-reply (collect.ts 패턴 재사용)
      const comments = detail.replyText ? [{
        text: detail.replyText,
        has_affiliate_link: detail.linkLocation === '답글' || detail.linkLocation === 'both',
        link_url: (detail.linkLocation === '답글' || detail.linkLocation === 'both') ? detail.linkUrl : null,
        media_urls: detail.replyMediaUrls,
      }] : [];

      // Insert to DB
      try {
        const rows = await db
          .insert(threadPosts)
          .values({
            post_id: post.post_id,
            channel_id: post.author,
            author: post.author,
            text: post.text,
            permalink: post.permalink,
            timestamp: post.timestamp_unix ? new Date(post.timestamp_unix * 1000) : undefined,
            view_count: viewCount,
            like_count: post.like_count,
            reply_count: post.reply_count,
            repost_count: post.repost_count,
            has_image: post.has_image,
            media_urls: post.media_urls?.length ? post.media_urls : undefined,
            link_url: detail.linkUrl ?? post.link_url ?? undefined,
            link_domain: detail.linkDomain ?? undefined,
            link_location: detail.linkLocation ?? undefined,
            comments,
            post_source: opts.search ? 'keyword_search' : 'homefeed',
            crawl_at: new Date(),
            run_id: runId,
          })
          .onConflictDoNothing()
          .returning({ post_id: threadPosts.post_id });

        if (rows.length > 0) {
          totalInserted++;
        }
      } catch (err) {
        log(`    DB 저장 실패: ${(err as Error).message}`);
      }

      markPostSeen(post.post_id, post.author);

      // Anti-bot delay between detail page visits
      await humanDelay(8000, 15000);
    }
  } finally {
    saveSeenPosts();
    await browser.close();
    log('\n브라우저 disconnect 완료');
  }

  log('\n=== 홈피드 수집 완료 ===');
  log(`GraphQL 캡처: ${totalCaptured}개`);
  log(`상세 조회: ${totalFiltered}개`);
  log(`DB 신규 저장: ${totalInserted}개`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
