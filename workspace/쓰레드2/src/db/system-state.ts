/**
 * @file system-state.ts — system_state 테이블 CRUD 헬퍼.
 *
 * Usage:
 *   import { setState, getState, getAllState } from './db/system-state.js';
 */

import { db as defaultDb } from './index.js';
import { systemState } from './schema.js';
import { eq } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

/**
 * 상태 저장 (upsert) — key가 존재하면 value + updated_at 갱신, 없으면 INSERT.
 */
export async function setState(
  key: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
  updatedBy?: string,
  db: DbLike = defaultDb,
): Promise<void> {
  await db
    .insert(systemState)
    .values({
      key,
      value,
      updated_at: new Date(),
      updated_by: updatedBy ?? null,
    })
    .onConflictDoUpdate({
      target: systemState.key,
      set: {
        value,
        updated_at: new Date(),
        updated_by: updatedBy ?? null,
      },
    });
}

/**
 * 단일 키 상태 조회. 없으면 null 반환.
 */
export async function getState(
  key: string,
  db: DbLike = defaultDb,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const rows = await db
    .select({ value: systemState.value })
    .from(systemState)
    .where(eq(systemState.key, key))
    .limit(1);

  return rows[0]?.value ?? null;
}

/**
 * 전체 상태 조회 — { key: value } Record 반환.
 */
export async function getAllState(
  db: DbLike = defaultDb,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>> {
  const rows = await db
    .select({ key: systemState.key, value: systemState.value })
    .from(systemState);

  return Object.fromEntries(
    (rows as Array<{ key: string; value: unknown }>).map(r => [r.key, r.value]),
  );
}
