/**
 * @file strategy-archive.ts — 전략 버전 관리 + 롤백 CRUD
 *
 * CEO 전용 태그 [CREATE_STRATEGY_VERSION] 파싱 후 이 모듈을 호출.
 * 버전 관리: active(1개) → archived(n개) → rollback 시 target=active, current=deprecated
 */

import { db as defaultDb } from './index.js';
import { strategyArchive } from './schema.js';
import { eq, desc } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

// ─── Types ────────────────────────────────────────────────────

export interface StrategyInput {
  version: string;
  parent_version?: string;
  strategy: Record<string, unknown>;
  performance?: {
    avg_roi?: number;
    avg_views?: number;
    revenue_target?: number;
    revenue_actual?: number;
  } | null;
}

export interface StrategyRecord {
  id: string;
  version: string;
  parent_version: string | null;
  strategy: Record<string, unknown>;
  performance: Record<string, unknown> | null;
  status: string;
  created_at: Date;
  evaluated_at: Date | null;
}

export interface RevertResult {
  success: boolean;
  targetVersion: string;
  previousVersion: string | null;
}

// ─── CRUD ─────────────────────────────────────────────────────

/**
 * 새 전략 버전 생성.
 * 이전 active 버전은 'archived'로 전환 후 신규 버전을 'active'로 삽입.
 */
export async function createStrategyVersion(
  input: StrategyInput,
  db: AnyDb = defaultDb,
): Promise<StrategyRecord> {
  // 기존 active → archived
  await db
    .update(strategyArchive)
    .set({ status: 'archived' })
    .where(eq(strategyArchive.status, 'active'))
    .returning();

  const [created] = await db
    .insert(strategyArchive)
    .values({
      version: input.version,
      parent_version: input.parent_version ?? null,
      strategy: input.strategy,
      performance: input.performance ?? null,
      status: 'active',
    })
    .returning();

  return created as StrategyRecord;
}

/**
 * 현재 active 전략 반환. 없으면 null.
 */
export async function getActiveStrategy(
  db: AnyDb = defaultDb,
): Promise<StrategyRecord | null> {
  const rows = await db
    .select()
    .from(strategyArchive)
    .where(eq(strategyArchive.status, 'active'))
    .limit(1);

  return (rows[0] as StrategyRecord) ?? null;
}

/**
 * 전략 롤백 — 대상 버전을 'active'로, 현재 active를 'deprecated'로.
 */
export async function revertStrategy(
  targetVersion: string,
  db: AnyDb = defaultDb,
): Promise<RevertResult> {
  // 현재 active 버전 파악
  const currentRows = await db
    .select()
    .from(strategyArchive)
    .where(eq(strategyArchive.status, 'active'))
    .limit(1);
  const previous = currentRows[0]?.version ?? null;

  // 현재 active → deprecated
  await db
    .update(strategyArchive)
    .set({ status: 'deprecated' })
    .where(eq(strategyArchive.status, 'active'))
    .returning();

  // 대상 → active
  await db
    .update(strategyArchive)
    .set({ status: 'active', evaluated_at: new Date() })
    .where(eq(strategyArchive.version, targetVersion))
    .returning();

  return {
    success: true,
    targetVersion,
    previousVersion: previous,
  };
}

/**
 * 전략 목록 반환 (최신 순).
 */
export async function listStrategyVersions(
  db: AnyDb = defaultDb,
): Promise<StrategyRecord[]> {
  const rows = await db
    .select()
    .from(strategyArchive)
    .orderBy(desc(strategyArchive.created_at))
    .limit(50);

  return rows as StrategyRecord[];
}
