/**
 * @file account-manager.ts
 * 발행 계정의 등록, 조회, 상태 관리.
 * 1개 계정으로 시작, 추후 10개 확장 대비.
 *
 * Usage:
 *   import { registerAccount, getAccountForPosting } from './account-manager.js';
 */

import { db } from '../db/index.js';
import { accounts, contentLifecycle } from '../db/schema.js';
import { eq, or, sql, asc } from 'drizzle-orm';
import type { Account, NewAccount } from '../types.js';
import { generateId } from '../utils/id.js';

// ─── Config ──────────────────────────────────────────────

/** 마지막 포스팅 후 최소 대기 시간 (ms) — 30분 */
const MIN_POST_INTERVAL_MS = 30 * 60 * 1000;

/** health_score 감소량 (ban 1회당) */
const BAN_PENALTY = 20;

/** 최근 7일 성과 기반 health 보너스 (포스트당) */
const PERFORMANCE_BONUS_PER_POST = 1;

/** health_score 최대/최소 */
const HEALTH_MAX = 100;
const HEALTH_MIN = 0;

function toAccount(row: typeof accounts.$inferSelect): Account {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    status: row.status,
    proxy_id: row.proxy_id,
    fingerprint_id: row.fingerprint_id,
    created_at: row.created_at.toISOString(),
    last_posted_at: row.last_posted_at?.toISOString() ?? null,
    post_count: row.post_count,
    ban_count: row.ban_count,
    health_score: row.health_score,
  };
}

// ─── Core Functions ──────────────────────────────────────

/**
 * 새 계정을 등록한다.
 * 초기 status: 'warming_up', health_score: 100
 */
export async function registerAccount(account: NewAccount): Promise<Account> {
  const id = generateId('acc');
  const now = new Date();

  const [inserted] = await db
    .insert(accounts)
    .values({
      id,
      username: account.username,
      email: account.email,
      status: 'warming_up',
      proxy_id: account.proxyId ?? '',
      fingerprint_id: account.fingerprintId ?? '',
      created_at: now,
      last_posted_at: null,
      post_count: 0,
      ban_count: 0,
      health_score: HEALTH_MAX,
    })
    .returning();

  return toAccount(inserted);
}

/**
 * 활성 계정 목록을 반환한다 (status가 'active' 또는 'warming_up').
 */
export async function getActiveAccounts(): Promise<Account[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(
      or(
        eq(accounts.status, 'active'),
        eq(accounts.status, 'warming_up'),
      ),
    );

  return rows.map(toAccount);
}

/**
 * 계정의 health_score를 재계산한다.
 * - ban 경험 있으면 ban_count * BAN_PENALTY 만큼 감소
 * - 최근 7일 포스트 수에 따라 소량 보너스
 */
export async function updateAccountHealth(accountId: string): Promise<void> {
  // 현재 계정 조회
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId));

  if (!account) return;

  // 최근 7일 포스트 수 조회
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [recentPosts] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentLifecycle)
    .where(
      sql`${contentLifecycle.posted_account_id} = ${accountId}
          AND ${contentLifecycle.posted_at} >= ${sevenDaysAgo}`,
    );

  const recentPostCount = recentPosts?.count ?? 0;

  // health 계산: 기본 100 - ban 패널티 + 활동 보너스
  let health = HEALTH_MAX - (account.ban_count * BAN_PENALTY);
  health += recentPostCount * PERFORMANCE_BONUS_PER_POST;
  health = Math.max(HEALTH_MIN, Math.min(HEALTH_MAX, health));

  // status 변경 판단 (health <= 0 을 먼저 체크해야 banned가 dead code가 되지 않음)
  let newStatus = account.status;
  if (health <= 0) {
    newStatus = 'banned';
  } else if (health <= 20) {
    newStatus = 'restricted';
  }

  await db
    .update(accounts)
    .set({ health_score: health, status: newStatus })
    .where(eq(accounts.id, accountId));
}

/**
 * 포스팅에 사용할 계정을 선택한다.
 * - 활성 계정 중 가장 오래전에 포스팅한 계정
 * - 최소 발행 간격(30분) 체크
 * - 1개 계정이면 그 계정 반환
 */
export async function getAccountForPosting(): Promise<Account | null> {
  const activeAccounts = await db
    .select()
    .from(accounts)
    .where(
      or(
        eq(accounts.status, 'active'),
        eq(accounts.status, 'warming_up'),
      ),
    )
    .orderBy(asc(accounts.last_posted_at));

  if (activeAccounts.length === 0) return null;

  const now = Date.now();

  for (const account of activeAccounts) {
    // 최소 발행 간격 체크
    if (account.last_posted_at) {
      const elapsed = now - account.last_posted_at.getTime();
      if (elapsed < MIN_POST_INTERVAL_MS) {
        continue; // 아직 30분이 안 지남
      }
    }
    return toAccount(account);
  }

  // 모든 계정이 간격 제한에 걸림
  return null;
}

/**
 * 계정을 폐기(retired) 처리한다.
 * Phase 3에서 삭제/재생성 로직 추가 예정.
 */
export async function retireAccount(accountId: string): Promise<void> {
  await db
    .update(accounts)
    .set({ status: 'retired' })
    .where(eq(accounts.id, accountId));
}
