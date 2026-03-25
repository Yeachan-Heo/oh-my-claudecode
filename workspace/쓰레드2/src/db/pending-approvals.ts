/**
 * @file pending-approvals.ts — 시훈(오너) 승인 대기 CRUD
 *
 * approval_type: 'ops_change' | 'new_agent' | 'system_change' | 'rollback' | 'budget' | 'new_category'
 * CEO/팀장이 생성 → 시훈이 대시보드에서 승인/거부.
 */

import { db as defaultDb } from './index.js';
import { pendingApprovals } from './schema.js';
import { eq, desc } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

// ─── Types ────────────────────────────────────────────────────

export type ApprovalType =
  | 'ops_change'
  | 'new_agent'
  | 'system_change'
  | 'rollback'
  | 'budget'
  | 'new_category';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalInput {
  requested_by: string;
  approval_type: string;
  description: string;
  details?: Record<string, unknown> | null;
}

export interface ApprovalRecord {
  id: string;
  requested_by: string;
  approval_type: string;
  description: string;
  details: Record<string, unknown> | null;
  status: string;
  created_at: Date;
  resolved_at: Date | null;
}

// ─── CRUD ─────────────────────────────────────────────────────

/**
 * 승인 요청 생성.
 */
export async function createApproval(
  input: ApprovalInput,
  db: AnyDb = defaultDb,
): Promise<ApprovalRecord> {
  const [created] = await db
    .insert(pendingApprovals)
    .values({
      requested_by: input.requested_by,
      approval_type: input.approval_type,
      description: input.description,
      details: input.details ?? null,
      status: 'pending',
    })
    .returning();

  return created as ApprovalRecord;
}

/**
 * 승인 목록 조회.
 * @param status - 필터 (undefined = 전체)
 */
export async function getApprovals(
  status?: ApprovalStatus,
  db: AnyDb = defaultDb,
): Promise<ApprovalRecord[]> {
  const query = db
    .select()
    .from(pendingApprovals);

  const rows = status
    ? await query.where(eq(pendingApprovals.status, status))
    : await query.orderBy(desc(pendingApprovals.created_at)).limit(50);

  return rows as ApprovalRecord[];
}

/**
 * 승인 처리 (approved | rejected).
 */
export async function resolveApproval(
  id: string,
  status: 'approved' | 'rejected',
  db: AnyDb = defaultDb,
): Promise<ApprovalRecord> {
  const [updated] = await db
    .update(pendingApprovals)
    .set({ status, resolved_at: new Date() })
    .where(eq(pendingApprovals.id, id))
    .returning();

  return updated as ApprovalRecord;
}
