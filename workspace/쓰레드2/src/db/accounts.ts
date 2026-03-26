/**
 * @file accounts CRUD helpers — 다중 계정 관리 (Phase 4-C).
 *
 * MULTI_ACCOUNT_MODE = false 동안은 PRIMARY_ACCOUNT_ID 단일 계정만 사용.
 * MULTI_ACCOUNT_MODE = true 전환 시 이 헬퍼로 계정 전환.
 *
 * Note: 계정 최초 등록은 account-manager.ts의 registerAccount() 사용.
 * 이 파일의 헬퍼는 카테고리/에디터 메타 관리 + 목록 조회 전용.
 */

import { db as defaultDb } from './index.js';
import { accounts } from './schema.js';
import { eq } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type AccountRow = typeof accounts.$inferSelect;

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * 계정 메타(카테고리/에디터/워밍업 목표) 등록 또는 업데이트.
 * 이미 존재하면 category/assigned_editor/warmup_target/display_name만 업데이트.
 * 존재하지 않으면 username/email 기본값으로 신규 삽입.
 */
export async function registerAccount(
  input: {
    id: string;
    displayName?: string;
    category?: string;
    assignedEditor?: string;
    warmupTarget?: number;
  },
  db: AnyDb = defaultDb,
): Promise<void> {
  await db
    .insert(accounts)
    .values({
      id: input.id,
      username: input.id,           // username 필수 컬럼 — id로 대체
      email: '',                     // email 필수 컬럼 — 다중계정 모드에서 별도 업데이트
      display_name: input.displayName ?? null,
      category: input.category ?? null,
      assigned_editor: input.assignedEditor ?? null,
      warmup_target: input.warmupTarget ?? 20,
    })
    .onConflictDoUpdate({
      target: accounts.id,
      set: {
        display_name: input.displayName ?? null,
        category: input.category ?? null,
        assigned_editor: input.assignedEditor ?? null,
        warmup_target: input.warmupTarget ?? 20,
      },
    });
}

/**
 * 계정 포스트 수 업데이트.
 */
export async function updatePostCount(
  accountId: string,
  count: number,
  db: AnyDb = defaultDb,
): Promise<void> {
  await db
    .update(accounts)
    .set({ post_count: count })
    .where(eq(accounts.id, accountId));
}

/**
 * 계정 비활성화.
 */
export async function deactivateAccount(
  accountId: string,
  db: AnyDb = defaultDb,
): Promise<void> {
  await db
    .update(accounts)
    .set({ is_active: false })
    .where(eq(accounts.id, accountId));
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * 활성 계정 전체 목록.
 */
export async function listActiveAccounts(db: AnyDb = defaultDb): Promise<AccountRow[]> {
  return db
    .select()
    .from(accounts)
    .where(eq(accounts.is_active, true));
}

/**
 * 카테고리별 활성 계정 조회.
 */
export async function getAccountsByCategory(
  category: string,
  db: AnyDb = defaultDb,
): Promise<AccountRow[]> {
  return db
    .select()
    .from(accounts)
    .where(eq(accounts.category, category));
}
