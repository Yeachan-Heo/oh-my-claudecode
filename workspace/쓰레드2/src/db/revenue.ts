/**
 * @file revenue - 클릭/구매/수익 추적 CRUD 헬퍼.
 *
 * 워밍업 완료(isWarmupMode()=false) 후 활성화.
 * Usage:
 *   import { trackClick, trackPurchase, getRevenueByPost } from './db/revenue.js';
 */

import { db as defaultDb } from './index.js';
import { revenueTracking } from './schema.js';
import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

function today(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * 클릭 추적 — 포스트 링크 클릭 1회 기록.
 */
export async function trackClick(
  postId: string,
  productId: string | null,
  coupangLink: string | null,
  db: DbLike = defaultDb,
) {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(revenueTracking)
    .values({
      id,
      post_id: postId,
      product_id: productId,
      coupang_link: coupangLink,
      click_count: 1,
      purchase_count: 0,
      revenue: '0',
      commission: '0',
      tracked_date: today(),
    })
    .returning();
  return row;
}

/**
 * 구매 추적 — 쿠팡 파트너스 구매 전환 1회 기록.
 */
export async function trackPurchase(
  postId: string,
  amount: number,
  commission: number,
  db: DbLike = defaultDb,
) {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(revenueTracking)
    .values({
      id,
      post_id: postId,
      product_id: null,
      coupang_link: null,
      click_count: 0,
      purchase_count: 1,
      revenue: amount.toFixed(2),
      commission: commission.toFixed(2),
      tracked_date: today(),
    })
    .returning();
  return row;
}

/**
 * 포스트별 수익 조회.
 */
export async function getRevenueByPost(postId: string, db: DbLike = defaultDb) {
  return db
    .select()
    .from(revenueTracking)
    .where(eq(revenueTracking.post_id, postId))
    .orderBy(desc(revenueTracking.created_at));
}

/**
 * 기간별 수익 조회 (start, end: 'YYYY-MM-DD').
 */
export async function getRevenueByDate(
  start: string,
  end: string,
  db: DbLike = defaultDb,
) {
  return db
    .select()
    .from(revenueTracking)
    .where(
      and(
        gte(revenueTracking.tracked_date, start),
        lte(revenueTracking.tracked_date, end),
      ),
    )
    .orderBy(desc(revenueTracking.tracked_date));
}

/**
 * 일별 클릭/구매/수익 요약.
 */
export async function getDailyRevenueSummary(db: DbLike = defaultDb) {
  return db
    .select({
      tracked_date: revenueTracking.tracked_date,
      total_clicks: sql<number>`sum(${revenueTracking.click_count})::int`,
      total_purchases: sql<number>`sum(${revenueTracking.purchase_count})::int`,
      total_revenue: sql`sum(${revenueTracking.revenue})`,
      total_commission: sql`sum(${revenueTracking.commission})`,
    })
    .from(revenueTracking)
    .groupBy(revenueTracking.tracked_date)
    .orderBy(desc(revenueTracking.tracked_date));
}
