/**
 * @file Snapshot collector — captures post performance at 6h/48h/7d intervals.
 *
 * Connects to Chrome via Playwright CDP to scrape current engagement metrics
 * from the Threads post page, then stores the snapshot in the DB.
 */

import type { Browser, Page } from 'playwright';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { postSnapshots, contentLifecycle } from '../db/schema.js';
import type { PostSnapshot, PostMaturity } from '../types.js';
import { calculateVelocity } from './metrics.js';
import { connectBrowser } from '../utils/browser.js';
import { generateId } from '../utils/id.js';

// ─── Config ──────────────────────────────────────────────

const THREADS_BASE = 'https://www.threads.net';

const MATURITY_HOURS = {
  warmup: 0,
  early: 6,
  mature: 48,
  final: 168, // 7 days
} as const;

// ─── Utility ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] [snapshot] ${msg}`);
}

function hoursSince(date: Date): number {
  return (Date.now() - date.getTime()) / (1000 * 60 * 60);
}

// ─── DOM Metric Extraction ───────────────────────────────

interface RawMetrics {
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  postViews: number;
  commentViews: number;
}

/**
 * 포스트 상세 페이지 상단의 "조회 N회" / "조회 N천회" / "조회 N만회" 추출
 */
async function extractViewCount(page: Page): Promise<number> {
  const views = await page.evaluate(() => {
    const bodyText = document.body.innerText || '';

    // Korean: "조회 N회", "조회 N천회", "조회 N만회", "조회 N.N천회"
    const koMatch = bodyText.match(/조회\s*([\d,.]+(?:\.\d+)?)\s*(만|천)?\s*회/);
    if (koMatch) {
      const num = parseFloat(koMatch[1].replace(/,/g, ''));
      if (koMatch[2] === '만') return Math.round(num * 10000);
      if (koMatch[2] === '천') return Math.round(num * 1000);
      return Math.round(num);
    }

    // English: "N views", "N.NK views"
    const enMatch = bodyText.match(/([\d,.]+(?:\.\d+)?)\s*[KkMm]?\s*views/i);
    if (enMatch) {
      let v = enMatch[1].replace(/,/g, '');
      const full = enMatch[0].toLowerCase();
      if (full.includes('k')) return Math.round(parseFloat(v) * 1000);
      if (full.includes('m')) return Math.round(parseFloat(v) * 1000000);
      return Math.round(parseFloat(v));
    }

    return 0;
  });

  return views;
}

async function extractMetricsFromPage(page: Page): Promise<RawMetrics> {
  // Wait for content to load
  await page.waitForLoadState('domcontentloaded');
  await new Promise(r => setTimeout(r, 3000));

  // Extract view count from page header ("스레드 조회 N회")
  const postViews = await extractViewCount(page);

  const metrics = await page.evaluate(() => {
    function parseCount(text: string | null | undefined): number {
      if (!text) return 0;
      const cleaned = text.replace(/[,\s]/g, '').toLowerCase();
      const match = cleaned.match(/([\d.]+)([kmb])?/);
      if (!match) return 0;
      const num = parseFloat(match[1]);
      const suffix = match[2];
      if (suffix === 'k') return Math.round(num * 1000);
      if (suffix === 'm') return Math.round(num * 1000000);
      if (suffix === 'b') return Math.round(num * 1000000000);
      return Math.round(num);
    }

    // Try to find metric elements using common Threads patterns
    const ariaLabels = Array.from(document.querySelectorAll('[aria-label]'));
    let likes = 0;
    let comments = 0;
    let shares = 0;
    let saves = 0;

    for (const el of ariaLabels) {
      const label = el.getAttribute('aria-label') || '';
      const lower = label.toLowerCase();

      if (lower.includes('like') || lower.includes('좋아요')) {
        likes = parseCount(label.match(/\d[\d,.]*[kmb]?/i)?.[0]);
      }
      if (lower.includes('comment') || lower.includes('reply') || lower.includes('댓글') || lower.includes('답글')) {
        comments = parseCount(label.match(/\d[\d,.]*[kmb]?/i)?.[0]);
      }
      if (lower.includes('repost') || lower.includes('share') || lower.includes('공유')) {
        shares = parseCount(label.match(/\d[\d,.]*[kmb]?/i)?.[0]);
      }
      if (lower.includes('save') || lower.includes('저장') || lower.includes('bookmark')) {
        saves = parseCount(label.match(/\d[\d,.]*[kmb]?/i)?.[0]);
      }
    }

    return { likes, comments, shares, saves };
  });

  return { ...metrics, postViews, commentViews: 0 };
}

// ─── Post Maturity ───────────────────────────────────────

/**
 * Determine post maturity based on age since posting.
 *
 * - 0~6h: warmup
 * - 6~48h: early
 * - 48h~7d: mature
 * - 7d+: final
 */
export function getPostMaturity(postedAt: Date): PostMaturity {
  const ageHours = hoursSince(postedAt);

  if (ageHours < MATURITY_HOURS.early) return 'warmup';
  if (ageHours < MATURITY_HOURS.mature) return 'early';
  if (ageHours < MATURITY_HOURS.final) return 'mature';
  return 'final';
}

// ─── Snapshot Collection ─────────────────────────────────

/**
 * Collect a performance snapshot for a specific post.
 *
 * Navigates to the post's Threads page via CDP, extracts engagement metrics,
 * calculates velocity values, and stores the snapshot in the DB.
 */
export async function collectSnapshot(
  postId: string,
  snapshotType: 'early' | 'mature' | 'final',
): Promise<PostSnapshot> {
  log(`수집 시작: post=${postId} type=${snapshotType}`);

  // Look up the lifecycle entry to get posted_at and permalink
  const [lifecycle] = await db
    .select()
    .from(contentLifecycle)
    .where(eq(contentLifecycle.id, postId))
    .limit(1);

  if (!lifecycle) {
    throw new Error(`ContentLifecycle not found: ${postId}`);
  }

  const postedAt = lifecycle.posted_at
    ? new Date(lifecycle.posted_at)
    : new Date(lifecycle.created_at);

  const ageHours = hoursSince(postedAt);

  // Connect to browser and navigate to post
  let rawMetrics: RawMetrics;
  let browser: Browser | null = null;

  try {
    browser = await connectBrowser();
    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) throw new Error('BrowserContext가 없습니다.');

    const pages = context.pages();
    const page = pages[0] || await context.newPage();

    // Navigate to the post page
    // Threads post URLs follow the pattern: https://www.threads.net/@username/post/<postId>
    const postUrl = lifecycle.threads_post_url
      ? lifecycle.threads_post_url
      : `${THREADS_BASE}/post/${postId}`;
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    rawMetrics = await extractMetricsFromPage(page);

    // Collect self-comment view count if post has a self-comment with affiliate link
    // Self-comment URLs are typically the first reply by the same author
    try {
      const selfCommentUrl = await page.evaluate(() => {
        // Find reply links under the post — look for /post/ links that are different from current
        const replyLinks = Array.from(document.querySelectorAll('a[href*="/post/"]'));
        const currentPath = window.location.pathname;
        for (const link of replyLinks) {
          const href = link.getAttribute('href') || '';
          if (href !== currentPath && href.includes('/post/')) {
            return href;
          }
        }
        return null;
      });

      if (selfCommentUrl) {
        const commentFullUrl = selfCommentUrl.startsWith('http')
          ? selfCommentUrl
          : `${THREADS_BASE}${selfCommentUrl}`;
        await page.goto(commentFullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));
        const commentViews = await extractViewCount(page);
        rawMetrics.commentViews = commentViews;
        log(`셀프댓글 조회수: ${commentViews}`);
      }
    } catch (commentErr) {
      log(`셀프댓글 조회수 수집 실패 (무시): ${(commentErr as Error).message}`);
    }
  } catch (e) {
    const err = e as Error;
    log(`메트릭 수집 실패: ${err.message}`);
    // Use zeroed metrics on failure
    rawMetrics = { likes: 0, comments: 0, shares: 0, saves: 0, postViews: 0, commentViews: 0 };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore disconnect errors */ }
    }
  }

  // clicks = 셀프댓글 조회수 (제휴링크 노출 프록시)
  // conversions, revenue = 추후 제휴 플랫폼 API 연동 시 실제 값 사용
  const clicks = rawMetrics.commentViews;
  const conversions = 0;
  const revenue = 0;

  // Calculate velocity metrics
  const velocities = calculateVelocity(
    {
      likes: rawMetrics.likes,
      comments: rawMetrics.comments,
      shares: rawMetrics.shares,
      clicks,
      conversions,
    },
    ageHours,
  );

  const snapshot: PostSnapshot = {
    id: generateId('snap'),
    post_id: postId,
    snapshot_type: snapshotType,
    snapshot_at: new Date().toISOString(),
    likes: rawMetrics.likes,
    comments: rawMetrics.comments,
    shares: rawMetrics.shares,
    saves: rawMetrics.saves,
    clicks,
    conversions,
    revenue,
    engagement_velocity: velocities.engagement_velocity,
    click_velocity: velocities.click_velocity,
    conversion_velocity: velocities.conversion_velocity,
    post_views: rawMetrics.postViews,
    comment_views: rawMetrics.commentViews,
  };

  // Insert into DB
  await db.insert(postSnapshots).values({
    id: snapshot.id,
    post_id: snapshot.post_id,
    snapshot_type: snapshot.snapshot_type,
    snapshot_at: new Date(snapshot.snapshot_at),
    likes: snapshot.likes,
    comments: snapshot.comments,
    shares: snapshot.shares,
    saves: snapshot.saves,
    clicks: snapshot.clicks,
    conversions: snapshot.conversions,
    revenue: snapshot.revenue,
    engagement_velocity: snapshot.engagement_velocity,
    click_velocity: snapshot.click_velocity,
    conversion_velocity: snapshot.conversion_velocity,
    post_views: snapshot.post_views,
    comment_views: snapshot.comment_views,
  });

  // Update maturity + performance metrics in content_lifecycle
  // current_impressions = 본문 조회수 (실제 도달), fallback = 좋아요+댓글+공유
  const maturity = getPostMaturity(postedAt);
  const impressions = rawMetrics.postViews > 0
    ? rawMetrics.postViews
    : rawMetrics.likes + rawMetrics.comments + rawMetrics.shares;
  await db
    .update(contentLifecycle)
    .set({
      maturity,
      current_impressions: impressions,
      current_clicks: clicks,
      current_conversions: conversions,
      current_revenue: revenue,
    })
    .where(eq(contentLifecycle.id, postId));

  // 전환율 프록시 로깅
  const ctrProxy = rawMetrics.postViews > 0
    ? ((rawMetrics.commentViews / rawMetrics.postViews) * 100).toFixed(1)
    : 'N/A';
  log(`수집 완료: post=${postId} type=${snapshotType} views=${rawMetrics.postViews} commentViews=${rawMetrics.commentViews} CTR=${ctrProxy}%`);

  return snapshot;
}

// ─── Snapshot Scheduling ─────────────────────────────────

export interface SnapshotTarget {
  postId: string;
  snapshotType: 'early' | 'mature' | 'final';
  ageHours: number;
}

/**
 * Query content_lifecycle for posts that are due for a snapshot but haven't
 * been collected yet.
 *
 * Rules:
 * - posted_at + 6h elapsed & no 'early' snapshot  -> early target
 * - posted_at + 48h elapsed & no 'mature' snapshot -> mature target
 * - posted_at + 7d elapsed & no 'final' snapshot   -> final target
 */
export async function scheduleSnapshots(): Promise<SnapshotTarget[]> {
  const now = new Date();
  const targets: SnapshotTarget[] = [];

  // Get all lifecycle entries with a posted_at timestamp
  const allPosts = await db
    .select({
      id: contentLifecycle.id,
      posted_at: contentLifecycle.posted_at,
    })
    .from(contentLifecycle)
    .where(sql`${contentLifecycle.posted_at} IS NOT NULL`);

  // Get all existing snapshots grouped by post
  const existingSnapshots = await db
    .select({
      post_id: postSnapshots.post_id,
      snapshot_type: postSnapshots.snapshot_type,
    })
    .from(postSnapshots);

  // Build a set of "postId:type" for quick lookup
  const snapshotSet = new Set(
    existingSnapshots.map(s => `${s.post_id}:${s.snapshot_type}`),
  );

  for (const post of allPosts) {
    if (!post.posted_at) continue;

    const postedAt = new Date(post.posted_at);
    const ageHours = hoursSince(postedAt);

    // Check each snapshot tier
    if (ageHours >= MATURITY_HOURS.early && !snapshotSet.has(`${post.id}:early`)) {
      targets.push({ postId: post.id, snapshotType: 'early', ageHours });
    }
    if (ageHours >= MATURITY_HOURS.mature && !snapshotSet.has(`${post.id}:mature`)) {
      targets.push({ postId: post.id, snapshotType: 'mature', ageHours });
    }
    if (ageHours >= MATURITY_HOURS.final && !snapshotSet.has(`${post.id}:final`)) {
      targets.push({ postId: post.id, snapshotType: 'final', ageHours });
    }
  }

  log(`스케줄 조회 완료: ${targets.length}건 수집 대상`);
  return targets;
}
