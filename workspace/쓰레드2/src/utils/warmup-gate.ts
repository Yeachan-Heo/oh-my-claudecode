/**
 * @file warmup-gate — Warmup mode detection and content validation.
 *
 * isWarmupMode(): true while binilab__ has fewer than WARMUP_TARGET published posts.
 * validateContent(): rejects affiliate/ad content during warmup.
 * getWarmupProgress(): returns {current, target, remaining} progress.
 */

import { db as defaultDb } from '../db/index.js';
import { contentLifecycle } from '../db/schema.js';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { PRIMARY_ACCOUNT_ID, WARMUP_TARGET } from '../constants/accounts.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
const AFFILIATE_PATTERNS = /쿠팡|coupang|제휴|광고/i;

async function countPosted(db: AnyDb): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentLifecycle)
    .where(
      and(
        eq(contentLifecycle.posted_account_id, PRIMARY_ACCOUNT_ID),
        isNotNull(contentLifecycle.posted_at),
      ),
    );
  return result?.count ?? 0;
}

export async function isWarmupMode(db: AnyDb = defaultDb): Promise<boolean> {
  return (await countPosted(db)) < WARMUP_TARGET;
}

/**
 * 특정 계정의 워밍업 모드 확인.
 * warmupTarget 미지정 시 WARMUP_TARGET 기본값 사용.
 */
export async function isAccountWarmupMode(
  accountId: string,
  warmupTarget?: number,
  db: AnyDb = defaultDb,
): Promise<boolean> {
  const target = warmupTarget ?? WARMUP_TARGET;
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentLifecycle)
    .where(
      and(
        eq(contentLifecycle.posted_account_id, accountId),
        isNotNull(contentLifecycle.posted_at),
      ),
    );
  return (result?.count ?? 0) < target;
}

export function validateContent(
  text: string,
  isWarmup: boolean,
): { valid: boolean; reason?: string } {
  if (isWarmup && AFFILIATE_PATTERNS.test(text)) {
    return { valid: false, reason: '워밍업 모드: 제휴/광고 콘텐츠 금지' };
  }
  return { valid: true };
}

export async function getWarmupProgress(
  db: AnyDb = defaultDb,
): Promise<{ current: number; target: number; remaining: number }> {
  const current = await countPosted(db);
  return { current, target: WARMUP_TARGET, remaining: Math.max(0, WARMUP_TARGET - current) };
}
