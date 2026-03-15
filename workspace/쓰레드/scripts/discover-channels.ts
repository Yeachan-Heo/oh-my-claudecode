#!/usr/bin/env tsx
/**
 * discover-channels.ts — Threads 제휴마케팅 채널 자동 발굴
 *
 * 키워드 검색 → 프로필 방문 → 팔로워/광고 필터 → 채널 목록 생성.
 * 이미 로그인된 Playwright Page를 받아 실행.
 *
 * Usage:
 *   npx tsx scripts/discover-channels.ts --max 10
 *   npx tsx scripts/discover-channels.ts --max 20 --keywords "쿠팡파트너스,핫딜"
 */

import fs from 'fs';
import path from 'path';
import { chromium, type Page } from 'playwright';
import type { DiscoveredChannel, DiscoveryResult, CrawlCheckpoint } from './types.js';

// ─── Config ──────────────────────────────────────────────

const CDP_URL = 'http://127.0.0.1:9223';
const BASE_URL = 'https://www.threads.net';
const DATA_DIR = path.join(__dirname, '..', 'data');
const DISCOVERED_PATH = path.join(DATA_DIR, 'discovered_channels.json');
const SEEN_POSTS_PATH = path.join(DATA_DIR, 'seen_posts.json');
const CHECKPOINT_PATH = path.join(DATA_DIR, 'threads-watch-checkpoint.json');

const DEFAULT_KEYWORDS = [
  // --- Tier 1: 제휴마케팅 직접 ---
  '쿠팡파트너스',
  '제휴마케팅',
  '파트너스수익',
  '링크수익',
  '쿠팡추천',

  // --- Tier 2: 쇼핑 행동/핫딜 ---
  '핫딜',
  '최저가',
  '가성비템',
  '오늘만특가',
  '오늘의특가',
  '할인코드',
  '타임세일',
  '역대최저가',
  '추천템',
  '공구',

  // --- Tier 3: 니즈/카테고리 기반 ---
  '육아템추천',
  '자취필수템',
  '홈카페추천',
  '청소꿀팁',
  '다이어트식품',
  '여름준비템',
  '뷰티추천',
  '건강식품추천',
  '주방용품추천',
  '생활용품추천',
];

const TIMING = {
  betweenKeywords: { min: 30000, max: 60000 },
  betweenProfiles: { min: 5000, max: 15000 },
  postScan:        { min: 2000, max: 5000 },
  pageLoad:        { min: 3000, max: 6000 },
};

const MAX_DURATION_MS = 60 * 60 * 1000; // 60분

// ─── Affiliate detection patterns ────────────────────────

const AD_DOMAINS = [
  'coupang.com', 'coupa.ng', 'link.coupang.com',
  'musinsa.com', 'smartstore.naver.com', 'ali.ski',
];

const AD_KEYWORDS = [
  '#광고', '#협찬', '쿠팡파트너스', '할인코드',
  '공구', '파트너스 활동', '수수료를 제공',
];

const AD_PHRASES = [
  '댓글에 링크', '프로필 링크', '링크 남겨',
  '쿠팡에서 검색', '댓글에 남겨', '링크 남겨드',
];

function isAdText(text: string): boolean {
  const lower = text.toLowerCase();
  for (const domain of AD_DOMAINS) {
    if (lower.includes(domain)) return true;
  }
  for (const kw of AD_KEYWORDS) {
    if (text.includes(kw)) return true;
  }
  for (const phrase of AD_PHRASES) {
    if (text.includes(phrase)) return true;
  }
  return false;
}

// ─── Utility Functions ───────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanDelay(timing: { min: number; max: number }): Promise<number> {
  const ms = randInt(timing.min, timing.max);
  await new Promise(r => setTimeout(r, ms));
  return ms;
}

/**
 * 팔로워 수 파싱 — collect-posts.js parseNum 패턴 참고
 * "1.2만" → 12000, "12.5K" → 12500, "1,234" → 1234
 * "팔로워 N명" / "N followers" 패턴에서 N 추출
 */
function parseFollowerCount(text: string): number {
  // Korean: "팔로워 N명"
  const koMatch = text.match(/팔로워\s*([\d,.]+(?:\.\d+)?[만천]?)\s*명/);
  if (koMatch) {
    return parseKoreanNum(koMatch[1]);
  }
  // English: "N followers"
  const enMatch = text.match(/([\d,.]+(?:\.\d+)?[KkMm]?)\s*followers?/i);
  if (enMatch) {
    return parseEnglishNum(enMatch[1]);
  }
  return 0;
}

function parseKoreanNum(str: string): number {
  if (!str) return 0;
  str = str.trim();
  if (str.includes('만')) return Math.round(parseFloat(str.replace('만', '')) * 10000);
  if (str.includes('천')) return Math.round(parseFloat(str.replace('천', '')) * 1000);
  return parseInt(str.replace(/,/g, ''), 10) || 0;
}

function parseEnglishNum(str: string): number {
  if (!str) return 0;
  str = str.replace(/,/g, '');
  if (/[Kk]$/.test(str)) return Math.round(parseFloat(str) * 1000);
  if (/[Mm]$/.test(str)) return Math.round(parseFloat(str) * 1000000);
  return parseInt(str, 10) || 0;
}

function atomicWriteJSON(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ─── Exclusion Sets ──────────────────────────────────────

function loadExcludedChannels(checkpoint?: CrawlCheckpoint): Set<string> {
  const excluded = new Set<string>();

  // 1. Checkpoint: completed + blocked channels
  // Handle both new format (channels_completed) and old format (channels.completed)
  if (checkpoint) {
    const completed = checkpoint.channels_completed
      ?? (checkpoint as any).channels?.completed
      ?? [];
    for (const cc of completed) {
      if (cc.channel_id) excluded.add(cc.channel_id);
    }
    const blocked = checkpoint.blocked_channels ?? [];
    for (const bc of blocked) {
      excluded.add(bc);
    }
  }

  // 2. seen_posts.json — extract unique channel_ids
  // Key format: "channel_id_post_id" but both parts can contain underscores.
  // Strategy: build known channel_ids from checkpoint first, then match keys.
  // For unmatched keys, use a heuristic: Threads post_ids are 11-char Base64.
  try {
    if (fs.existsSync(SEEN_POSTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SEEN_POSTS_PATH, 'utf-8'));
      const posts: Record<string, boolean> = data.posts || {};
      for (const key of Object.keys(posts)) {
        // Try matching against known channel_ids first
        let matched = false;
        for (const knownId of excluded) {
          if (key.startsWith(knownId + '_')) {
            matched = true;
            break;
          }
        }
        if (matched) continue; // already excluded

        // Heuristic: Threads post_ids are typically 11-char alphanumeric+underscore.
        // Find the last segment that looks like a post_id (starts with uppercase letter).
        const lastUnderscoreIdx = key.lastIndexOf('_');
        if (lastUnderscoreIdx > 0) {
          const suffix = key.slice(lastUnderscoreIdx + 1);
          // If suffix looks like a Base64 post_id segment, try without it
          // But post_ids can span multiple underscore segments, so use a broader approach:
          // Match known Threads post_id pattern: starts with D or C, length >= 10
          const postIdMatch = key.match(/_([A-Z][A-Za-z0-9_]{9,})$/);
          if (postIdMatch) {
            const channelId = key.slice(0, key.length - postIdMatch[0].length);
            if (channelId) excluded.add(channelId);
          }
        }
      }
    }
  } catch {
    log('seen_posts.json 로드 실패 — 무시');
  }

  // 3. Existing discovered channels
  try {
    if (fs.existsSync(DISCOVERED_PATH)) {
      const data = JSON.parse(fs.readFileSync(DISCOVERED_PATH, 'utf-8'));
      const channels: DiscoveredChannel[] = data.channels || [];
      const reviewQueue: DiscoveredChannel[] = data.review_queue || [];
      for (const ch of [...channels, ...reviewQueue]) {
        excluded.add(ch.channel_id);
      }
    }
  } catch {
    log('discovered_channels.json 로드 실패 — 무시');
  }

  return excluded;
}

function loadCheckpoint(): CrawlCheckpoint | undefined {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8'));
    }
  } catch {
    log('checkpoint 로드 실패 — 무시');
  }
  return undefined;
}

// ─── Profile Scraping ────────────────────────────────────

interface ProfileData {
  channel_id: string;
  display_name: string;
  follower_count: number;
  bio: string;
  is_private: boolean;
}

async function scrapeProfile(page: Page, channelId: string): Promise<ProfileData | null> {
  try {
    await page.goto(`${BASE_URL}/@${channelId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await humanDelay(TIMING.pageLoad);

    const result = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';

      // Check private / not found
      if (bodyText.includes('Page not found') || bodyText.includes('페이지를 찾을 수 없습니다')) {
        return { error: 'not_found' };
      }
      if (bodyText.includes('This account is private') || bodyText.includes('비공개 계정')) {
        return { error: 'private' };
      }

      // Display name
      const headingEl = document.querySelector('h1, [role="heading"]');
      const displayName = headingEl ? headingEl.textContent?.trim() || '' : '';

      // Follower count — Korean "팔로워 N명"
      let followers = 0;
      const fmKo = bodyText.match(/팔로워\s*([\d,.]+(?:\.\d+)?[만천]?)\s*명/);
      if (fmKo) {
        const v = fmKo[1];
        if (v.includes('만')) followers = Math.round(parseFloat(v.replace('만', '')) * 10000);
        else if (v.includes('천')) followers = Math.round(parseFloat(v.replace('천', '')) * 1000);
        else followers = parseInt(v.replace(/,/g, ''), 10) || 0;
      }
      // Fallback: English "N followers"
      if (followers === 0) {
        const fmEn = bodyText.match(/([\d,.]+[KkMm]?)\s*followers?/i);
        if (fmEn) {
          let v = fmEn[1].replace(/,/g, '');
          if (/[Kk]$/.test(v)) followers = Math.round(parseFloat(v) * 1000);
          else if (/[Mm]$/.test(v)) followers = Math.round(parseFloat(v) * 1000000);
          else followers = parseInt(v, 10) || 0;
        }
      }

      // Bio — typically in a meta tag or visible paragraph
      let bio = '';
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) {
        bio = metaDesc.getAttribute('content') || '';
      }
      // Fallback: look for bio-like text blocks
      if (!bio) {
        const bioSelectors = [
          '[data-testid="user-bio"]',
          'header + div',
        ];
        for (const sel of bioSelectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent && el.textContent.length > 5) {
            bio = el.textContent.trim().slice(0, 500);
            break;
          }
        }
      }

      return {
        display_name: displayName,
        follower_count: followers,
        bio,
        is_private: false,
      };
    });

    if ('error' in result) {
      log(`  ${channelId}: ${result.error}`);
      return null;
    }

    return {
      channel_id: channelId,
      ...(result as Omit<ProfileData, 'channel_id'>),
    };
  } catch (err) {
    log(`  ${channelId} 프로필 스크래핑 실패: ${(err as Error).message}`);
    return null;
  }
}

// ─── Recent Posts Scan ───────────────────────────────────

interface RecentPostScan {
  adCount: number;
  totalScanned: number;
  hasRecentPost: boolean; // 최근 7일 내 포스트
}

async function scanRecentPosts(page: Page, channelId: string): Promise<RecentPostScan> {
  try {
    // Scroll to load more posts (need ~20)
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('End');
      await humanDelay({ min: 800, max: 1500 });
    }

    // We should already be on the profile page
    const result = await page.evaluate(() => {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      let hasRecentPost = false;

      // Find post containers — look for links to individual posts
      const postLinks = document.querySelectorAll('a[href*="/post/"]');
      const postTexts: string[] = [];
      const seenHrefs = new Set<string>();

      for (const link of postLinks) {
        const href = link.getAttribute('href') || '';
        if (seenHrefs.has(href)) continue;
        seenHrefs.add(href);

        // Find the parent post container and get its text
        let container = link.closest('[data-pressable-container]') || link.parentElement?.parentElement;
        if (container) {
          const text = container.textContent || '';
          if (text.length > 10) {
            postTexts.push(text);
          }
        }
      }

      // Check date proximity — look for time elements
      const timeEls = document.querySelectorAll('time');
      for (const t of timeEls) {
        const dt = t.getAttribute('datetime');
        if (dt) {
          const ts = new Date(dt).getTime();
          if (ts > sevenDaysAgo) {
            hasRecentPost = true;
            break;
          }
        }
      }

      // Fallback date check — relative time text
      if (!hasRecentPost) {
        const bodyText = document.body.innerText || '';
        const recentPatterns = [
          /\d+분\s*전/, /\d+시간\s*전/, /\d+\s*h\b/i, /\d+\s*m\b/i,
          /방금/, /just now/i,
          /1일\s*전/, /2일\s*전/, /3일\s*전/, /4일\s*전/, /5일\s*전/, /6일\s*전/, /7일\s*전/,
          /1d/, /2d/, /3d/, /4d/, /5d/, /6d/, /7d/,
        ];
        for (const pat of recentPatterns) {
          if (pat.test(bodyText)) {
            hasRecentPost = true;
            break;
          }
        }
      }

      // Limit to first 20 posts
      const limitedTexts = postTexts.slice(0, 20);

      return {
        postTexts: limitedTexts,
        hasRecentPost,
        totalScanned: limitedTexts.length,
      };
    });

    // Ad detection — run in Node for full pattern access
    let adCount = 0;
    for (const text of result.postTexts) {
      if (isAdText(text)) {
        adCount++;
      }
    }

    return {
      adCount,
      totalScanned: result.totalScanned,
      hasRecentPost: result.hasRecentPost,
    };
  } catch (err) {
    log(`  ${channelId} 포스트 스캔 실패: ${(err as Error).message}`);
    return { adCount: 0, totalScanned: 0, hasRecentPost: false };
  }
}

// ─── Search + Extract Channels ───────────────────────────

async function searchAndExtractProfiles(page: Page, keyword: string): Promise<string[]> {
  const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(keyword)}&serp_type=default`;
  log(`  검색: ${keyword} → ${searchUrl}`);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await humanDelay(TIMING.pageLoad);

    // Scroll more to load more results (was 3, now 10)
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('End');
      await humanDelay({ min: 1500, max: 3000 });
    }

    // Extract profile links from search results
    const channelIds = await page.evaluate((baseUrl: string) => {
      const ids: string[] = [];
      // Look for profile links: /@username
      const allLinks = document.querySelectorAll('a[href*="/@"]');
      const seen = new Set<string>();

      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        // Match /@channel_id — extract channel_id
        const match = href.match(/\/@([^/?]+)/);
        if (match && match[1]) {
          const channelId = match[1];
          // Skip navigation links, search links, etc.
          if (channelId === 'about' || channelId === 'legal' || channelId.startsWith('search')) continue;
          if (!seen.has(channelId)) {
            seen.add(channelId);
            ids.push(channelId);
          }
        }
      }

      return ids;
    }, BASE_URL);

    log(`  ${keyword}: ${channelIds.length}개 프로필 발견`);
    return channelIds;
  } catch (err) {
    log(`  검색 실패 (${keyword}): ${(err as Error).message}`);
    return [];
  }
}

// ─── Main Discovery Function ────────────────────────────

export async function discoverChannels(
  page: Page,
  maxChannels: number,
  existingCheckpoint?: CrawlCheckpoint,
): Promise<DiscoveryResult> {
  const startTime = Date.now();
  const excluded = loadExcludedChannels(existingCheckpoint);
  log(`제외 채널: ${excluded.size}개 (checkpoint + seen_posts + 기존 발굴)`);

  const channels: DiscoveredChannel[] = [];
  const reviewQueue: DiscoveredChannel[] = [];
  let searched = 0;
  let passed = 0;
  let filtered = 0;

  const keywords = DEFAULT_KEYWORDS;

  for (const keyword of keywords) {
    // Timeout check
    if (Date.now() - startTime > MAX_DURATION_MS) {
      log(`30분 초과 — 탐색 중단 (${channels.length}채널 발굴)`);
      break;
    }

    // Already have enough channels
    if (channels.length >= maxChannels) {
      log(`목표 채널 수 도달 (${maxChannels}개) — 탐색 종료`);
      break;
    }

    // Search for profiles with this keyword
    const candidateIds = await searchAndExtractProfiles(page, keyword);

    for (const channelId of candidateIds) {
      // Check limits
      if (channels.length >= maxChannels) break;
      if (Date.now() - startTime > MAX_DURATION_MS) break;

      // Skip excluded
      if (excluded.has(channelId)) {
        log(`  ${channelId}: 제외 (이미 수집/차단)`);
        continue;
      }

      // Mark as searched
      searched++;

      // Visit profile
      const profile = await scrapeProfile(page, channelId);
      if (!profile) {
        filtered++;
        continue;
      }

      if (profile.is_private) {
        log(`  ${channelId}: 비공개 — skip`);
        filtered++;
        continue;
      }

      // Scan recent posts for ad detection
      await humanDelay(TIMING.postScan);
      const scan = await scanRecentPosts(page, channelId);

      const discovered: DiscoveredChannel = {
        channel_id: channelId,
        display_name: profile.display_name,
        follower_count: profile.follower_count,
        bio: profile.bio,
        recent_ad_count: scan.adCount,
        source_keyword: keyword,
        discovered_at: new Date().toISOString(),
      };

      // Filter logic
      const hasEnoughFollowers = profile.follower_count >= 100;
      const hasAdPosts = scan.adCount >= 1;
      const isActive = scan.hasRecentPost;
      const adRatio = scan.totalScanned > 0 ? scan.adCount / scan.totalScanned : 0;

      // Ambiguous: followers 50~99 or uncertain ad detection
      const isAmbiguous = (
        (profile.follower_count >= 50 && profile.follower_count < 100) ||
        (scan.totalScanned > 0 && scan.adCount === 0 && profile.follower_count >= 100)
      );

      if (hasEnoughFollowers && hasAdPosts && isActive) {
        // Passed all filters
        channels.push(discovered);
        excluded.add(channelId);
        passed++;
        log(`  ${channelId}: 선정 (팔로워 ${profile.follower_count}, 광고 ${scan.adCount}/${scan.totalScanned}, 비율 ${(adRatio * 100).toFixed(0)}%)`);
      } else if (isAmbiguous && isActive) {
        // Ambiguous — add to review queue
        reviewQueue.push(discovered);
        excluded.add(channelId);
        log(`  ${channelId}: 리뷰큐 (팔로워 ${profile.follower_count}, 광고 ${scan.adCount}/${scan.totalScanned})`);
      } else {
        filtered++;
        const reasons: string[] = [];
        if (!hasEnoughFollowers) reasons.push(`팔로워 ${profile.follower_count}<100`);
        if (!hasAdPosts) reasons.push(`광고 ${scan.adCount}/${scan.totalScanned}`);
        if (!isActive) reasons.push('비활성');
        log(`  ${channelId}: 필터링 (${reasons.join(', ')})`);
      }

      // Anti-bot delay between profiles
      await humanDelay(TIMING.betweenProfiles);
    }

    // Anti-bot delay between keywords
    if (channels.length < maxChannels && keyword !== keywords[keywords.length - 1]) {
      const delay = await humanDelay(TIMING.betweenKeywords);
      log(`키워드 간 대기: ${(delay / 1000).toFixed(1)}초`);
    }
  }

  const result: DiscoveryResult = {
    channels,
    review_queue: reviewQueue,
    stats: { searched, passed, filtered },
  };

  // Save results
  atomicWriteJSON(DISCOVERED_PATH, result);
  log(`\n발굴 완료: 선정 ${channels.length}개, 리뷰큐 ${reviewQueue.length}개, 필터링 ${filtered}개`);
  log(`결과 저장: ${DISCOVERED_PATH}`);

  return result;
}

// ─── CLI Mode ────────────────────────────────────────────

interface CliOptions {
  max: number;
  keywords: string[] | null;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = { max: 10, keywords: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max' && args[i + 1]) {
      opts.max = parseInt(args[i + 1], 10) || 10;
      i++;
    } else if (args[i] === '--keywords' && args[i + 1]) {
      opts.keywords = args[i + 1].split(',').map(k => k.trim());
      i++;
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseCliArgs();
  log(`=== Threads 채널 발굴 시작 (최대 ${opts.max}개) ===`);

  // Override keywords if provided
  if (opts.keywords) {
    DEFAULT_KEYWORDS.length = 0;
    DEFAULT_KEYWORDS.push(...opts.keywords);
    log(`커스텀 키워드: ${opts.keywords.join(', ')}`);
  }

  // CDP connect
  log(`CDP 연결: ${CDP_URL}`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.error(`CDP 연결 실패: ${(err as Error).message}`);
    console.error('Chrome이 --remote-debugging-port=9223 으로 실행 중인지 확인하세요.');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error('브라우저 컨텍스트를 찾을 수 없습니다.');
    await browser.close();
    process.exit(1);
  }

  const page = context.pages()[0] || await context.newPage();

  // Load checkpoint if exists
  const checkpoint = loadCheckpoint();

  try {
    const result = await discoverChannels(page, opts.max, checkpoint);

    // Print result to stdout as JSON
    console.log('\n=== 발굴 결과 ===');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`발굴 실패: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    // Disconnect only — never close the user's browser
    await browser.close();
    log('브라우저 disconnect 완료');
  }
}

// Run CLI if executed directly
const isDirectRun = process.argv[1] &&
  (process.argv[1].endsWith('discover-channels.ts') ||
   process.argv[1].includes('discover-channels'));

if (isDirectRun) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
