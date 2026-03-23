/**
 * @file experiments - A/B 실험 CRUD 헬퍼.
 *
 * Usage:
 *   import { createExperiment, getActiveExperiments, evaluateExperiment, closeExperiment } from './db/experiments.js';
 */

import { db as defaultDb } from './index.js';
import { experiments, postSnapshots } from './schema.js';
import { eq, and, desc } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

/**
 * 실험 생성 — experiments 테이블에 저장.
 */
export async function createExperiment(
  hypothesis: string,
  variable: string,
  variant_a: string,
  variant_b: string,
  db: DbLike = defaultDb,
) {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(experiments)
    .values({
      id,
      hypothesis,
      variable,
      variant_a,
      variant_b,
    })
    .returning();
  return row;
}

/**
 * 활성 실험 조회 — status='active' 필터.
 */
export async function getActiveExperiments(db: DbLike = defaultDb) {
  return db
    .select()
    .from(experiments)
    .where(eq(experiments.status, 'active'))
    .orderBy(desc(experiments.created_at));
}

/**
 * 실험 평가 — 48h 후 post_snapshots에서 두 포스트 성과 비교.
 * post_id_a, post_id_b가 없으면 null 반환.
 */
export async function evaluateExperiment(
  id: string,
  db: DbLike = defaultDb,
): Promise<{
  variant_a_views: number;
  variant_b_views: number;
  winner: 'variant_a' | 'variant_b' | 'no_difference';
} | null> {
  const [exp] = await db
    .select()
    .from(experiments)
    .where(eq(experiments.id, id));

  if (!exp || !exp.post_id_a || !exp.post_id_b) return null;

  const snapA = await db
    .select({ post_views: postSnapshots.post_views, likes: postSnapshots.likes })
    .from(postSnapshots)
    .where(and(
      eq(postSnapshots.post_id, exp.post_id_a),
      eq(postSnapshots.snapshot_type, 'mature'),
    ))
    .limit(1);

  const snapB = await db
    .select({ post_views: postSnapshots.post_views, likes: postSnapshots.likes })
    .from(postSnapshots)
    .where(and(
      eq(postSnapshots.post_id, exp.post_id_b),
      eq(postSnapshots.snapshot_type, 'mature'),
    ))
    .limit(1);

  const viewsA = snapA[0]?.post_views ?? 0;
  const viewsB = snapB[0]?.post_views ?? 0;

  const diff = Math.abs(viewsA - viewsB);
  const threshold = Math.max(viewsA, viewsB) * 0.1; // 10% 차이 이상이면 승자 결정

  let winner: 'variant_a' | 'variant_b' | 'no_difference';
  if (diff < threshold) {
    winner = 'no_difference';
  } else {
    winner = viewsA > viewsB ? 'variant_a' : 'variant_b';
  }

  return { variant_a_views: viewsA, variant_b_views: viewsB, winner };
}

/**
 * 실험 종료 — status='closed', verdict, end_date 업데이트.
 */
export async function closeExperiment(
  id: string,
  verdict: string,
  confidence: string,
  db: DbLike = defaultDb,
) {
  const [row] = await db
    .update(experiments)
    .set({
      status: 'closed',
      verdict,
      confidence,
      end_date: new Date(),
    })
    .where(eq(experiments.id, id))
    .returning();
  return row;
}
