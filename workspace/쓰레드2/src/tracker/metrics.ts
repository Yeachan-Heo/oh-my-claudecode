/**
 * @file Velocity-based metrics calculation and TOP/BOTTOM 10% classification.
 *
 * All comparisons use speed-normalized metrics (engagement per hour) rather than
 * absolute counts, enabling fair comparison across posts of different ages.
 * See plan.md section 6 (Post Maturity Model) and section 7 (Sampling Strategy).
 */

import { eq, and, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contentLifecycle, postSnapshots } from '../db/schema.js';
import type { ContentLifecycle, WeeklyCohort } from '../types.js';

// ─── Velocity Calculation ────────────────────────────────

export interface VelocityInput {
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  conversions: number;
}

export interface VelocityResult {
  engagement_velocity: number;
  click_velocity: number;
  conversion_velocity: number;
}

/**
 * Calculate velocity metrics for a post snapshot.
 *
 * engagement_velocity = (likes + comments + shares) / ageHours
 * click_velocity      = clicks / ageHours
 * conversion_velocity = conversions / ageHours
 *
 * Returns 0 for all velocities if ageHours <= 0.
 */
export function calculateVelocity(
  snapshot: VelocityInput,
  ageHours: number,
): VelocityResult {
  if (ageHours <= 0) {
    return { engagement_velocity: 0, click_velocity: 0, conversion_velocity: 0 };
  }

  return {
    engagement_velocity: (snapshot.likes + snapshot.comments + snapshot.shares) / ageHours,
    click_velocity: snapshot.clicks / ageHours,
    conversion_velocity: snapshot.conversions / ageHours,
  };
}

// ─── Performance Classification ──────────────────────────

export interface ClassificationResult {
  top: ContentLifecycle[];
  bottom: ContentLifecycle[];
  middle: ContentLifecycle[];
}

/**
 * Classify posts into TOP 10%, BOTTOM 10%, and MIDDLE 80% by engagement_velocity.
 *
 * Only considers posts with maturity === 'mature' or 'final' (48h+ age).
 * Queries postSnapshots for each post's latest engagement_velocity for ranking.
 */
export async function classifyPerformance(posts: ContentLifecycle[]): Promise<ClassificationResult> {
  // Filter to mature/final posts only
  const maturePosts = posts.filter(
    p => p.maturity === 'mature' || p.maturity === 'final',
  );

  if (maturePosts.length === 0) {
    return { top: [], bottom: [], middle: [] };
  }

  // Query latest snapshot per post for engagement_velocity
  const postIds = maturePosts.map(p => p.id);
  const snapshots = await db
    .select({
      post_id: postSnapshots.post_id,
      engagement_velocity: postSnapshots.engagement_velocity,
      snapshot_at: postSnapshots.snapshot_at,
    })
    .from(postSnapshots)
    .where(sql`${postSnapshots.post_id} IN (${sql.join(postIds.map(id => sql`${id}`), sql`, `)})`);

  // Build map: postId -> latest engagement_velocity
  const velocityMap = new Map<string, number>();
  for (const snap of snapshots) {
    const existing = velocityMap.get(snap.post_id);
    if (existing === undefined || snap.engagement_velocity > existing) {
      velocityMap.set(snap.post_id, snap.engagement_velocity);
    }
  }

  // Sort descending by engagement_velocity (fallback to 0 if no snapshot)
  const sorted = [...maturePosts].sort((a, b) => {
    const velA = velocityMap.get(a.id) ?? 0;
    const velB = velocityMap.get(b.id) ?? 0;
    return velB - velA;
  });

  const topCount = Math.max(1, Math.ceil(sorted.length * 0.1));
  const bottomCount = Math.max(1, Math.ceil(sorted.length * 0.1));

  const top = sorted.slice(0, topCount);
  const bottom = sorted.slice(sorted.length - bottomCount);
  const middle = sorted.slice(topCount, sorted.length - bottomCount);

  return { top, bottom, middle };
}

// ─── Weekly Cohort ───────────────────────────────────────

/**
 * Build a weekly cohort: all posts published in the given week that have
 * reached 'mature' or 'final' status.
 *
 * @param weekStart - Monday 00:00 of the target week (Date or ISO string)
 */
export async function getWeeklyCohort(weekStart: Date): Promise<WeeklyCohort> {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const rows = await db
    .select()
    .from(contentLifecycle)
    .where(
      and(
        gte(contentLifecycle.posted_at, weekStart),
        lte(contentLifecycle.posted_at, weekEnd),
        sql`${contentLifecycle.maturity} IN ('mature', 'final')`,
      ),
    );

  // Map DB rows to ContentLifecycle interface
  const posts: ContentLifecycle[] = rows.map(mapRowToLifecycle);

  const { top, bottom } = await classifyPerformance(posts);

  return {
    week_start: weekStart.toISOString(),
    week_end: weekEnd.toISOString(),
    posts,
    top_performers: top,
    bottom_performers: bottom,
  };
}

// ─── Weekly Stats ────────────────────────────────────────

export interface WeeklyStats {
  weekStart: string;
  weekEnd: string;
  totalPosts: number;
  avgCtr: number;
  avgConversionRate: number;
  avgRevenuePerPost: number;
  avgReach: number;
  avgProductRelevance: number;
  categoryPerformance: Record<string, {
    count: number;
    avgCtr: number;
    avgConversion: number;
    avgRevenue: number;
  }>;
}

/**
 * Aggregate weekly statistics for the diagnosis engine.
 *
 * Queries content_lifecycle for posts published in the target week,
 * computes averages for CTR, conversion rate, revenue, and reach,
 * then breaks down performance by need_category.
 */
export async function getWeeklyStats(weekStart: Date): Promise<WeeklyStats> {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const rows = await db
    .select()
    .from(contentLifecycle)
    .where(
      and(
        gte(contentLifecycle.posted_at, weekStart),
        lte(contentLifecycle.posted_at, weekEnd),
      ),
    );

  const posts = rows.map(mapRowToLifecycle);

  if (posts.length === 0) {
    return {
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      totalPosts: 0,
      avgCtr: 0,
      avgConversionRate: 0,
      avgRevenuePerPost: 0,
      avgReach: 0,
      avgProductRelevance: 0,
      categoryPerformance: {},
    };
  }

  // Compute aggregate metrics
  let totalImpressions = 0;
  let totalClicks = 0;
  let totalConversions = 0;
  let totalRevenue = 0;
  let totalRelevance = 0;

  const categoryMap = new Map<string, {
    count: number;
    impressions: number;
    clicks: number;
    conversions: number;
    revenue: number;
  }>();

  for (const post of posts) {
    const impressions = post.current_impressions || 0;
    const clicks = post.current_clicks || 0;
    const conversions = post.current_conversions || 0;
    const revenue = post.current_revenue || 0;

    totalImpressions += impressions;
    totalClicks += clicks;
    totalConversions += conversions;
    totalRevenue += revenue;
    totalRelevance += post.match_relevance || 0;

    // Category breakdown
    const cat = post.need_category || 'unknown';
    const existing = categoryMap.get(cat) || {
      count: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0,
    };
    existing.count += 1;
    existing.impressions += impressions;
    existing.clicks += clicks;
    existing.conversions += conversions;
    existing.revenue += revenue;
    categoryMap.set(cat, existing);
  }

  const n = posts.length;
  const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
  const avgConversionRate = totalClicks > 0 ? totalConversions / totalClicks : 0;

  const categoryPerformance: WeeklyStats['categoryPerformance'] = {};
  for (const [cat, data] of categoryMap) {
    categoryPerformance[cat] = {
      count: data.count,
      avgCtr: data.impressions > 0 ? data.clicks / data.impressions : 0,
      avgConversion: data.clicks > 0 ? data.conversions / data.clicks : 0,
      avgRevenue: data.count > 0 ? data.revenue / data.count : 0,
    };
  }

  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    totalPosts: n,
    avgCtr,
    avgConversionRate,
    avgRevenuePerPost: totalRevenue / n,
    avgReach: totalImpressions / n,
    avgProductRelevance: totalRelevance / n,
    categoryPerformance,
  };
}

// ─── Absolute Metrics ────────────────────────────────────

export interface AbsoluteMetrics {
  views: number;
  likes: number;
  comments: number;
  reposts: number;
  saves: number;
  engagement_rate: number;  // (likes+comments+reposts)/views
}

export interface PostRanking {
  post_id: string;
  text: string;
  metrics: AbsoluteMetrics;
  rank: number;           // 조회수 기준 순위
  posted_at: string;
}

/**
 * Rank posts by absolute view count (descending).
 * Assigns 1-based rank to each post.
 */
export function rankPostsByAbsolute(posts: PostRanking[]): PostRanking[] {
  return [...posts].sort((a, b) => b.metrics.views - a.metrics.views)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

/**
 * Calculate growth percentage between two values.
 * Returns 100 if yesterday was 0 and today > 0, 0 if both are 0.
 */
export function calculateGrowth(today: number, yesterday: number): number {
  if (yesterday === 0) return today > 0 ? 100 : 0;
  return ((today - yesterday) / yesterday) * 100;
}

// ─── Row Mapping Helper ──────────────────────────────────

function mapRowToLifecycle(row: typeof contentLifecycle.$inferSelect): ContentLifecycle {
  return {
    id: row.id,
    source_post_id: row.source_post_id,
    source_channel_id: row.source_channel_id,
    source_engagement: row.source_engagement,
    source_relevance: row.source_relevance,
    extracted_need: row.extracted_need,
    need_category: row.need_category,
    need_confidence: row.need_confidence,
    matched_product_id: row.matched_product_id,
    match_relevance: row.match_relevance,
    content_text: row.content_text,
    content_style: row.content_style,
    hook_type: row.hook_type,
    posted_account_id: row.posted_account_id,
    posted_at: row.posted_at?.toISOString() ?? '',
    maturity: row.maturity,
    current_impressions: row.current_impressions,
    current_clicks: row.current_clicks,
    current_conversions: row.current_conversions,
    current_revenue: row.current_revenue,
    diagnosis: row.diagnosis,
    diagnosed_at: row.diagnosed_at?.toISOString() ?? null,
  };
}
