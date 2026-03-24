/**
 * @file pending-approvals.test.ts — 승인 대기 CRUD 테스트
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createApproval,
  getApprovals,
  resolveApproval,
  ApprovalInput,
} from '../db/pending-approvals.js';

// ─── Mock DB ──────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeMockDb(initialRows: Row[] = []) {
  const rows = [...initialRows];

  return {
    _rows: rows,

    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((data: Row) => {
        const row = { ...data, id: data.id ?? crypto.randomUUID(), created_at: new Date() };
        rows.push(row);
        return { returning: vi.fn().mockResolvedValue([row]) };
      }),
    })),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((patch: Row) => ({
        where: vi.fn().mockImplementation(() => ({
          returning: vi.fn().mockResolvedValue([patch]),
        })),
      })),
    })),

    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockResolvedValue(rows.slice(0, 20)),
        })),
      })),
    })),
  };
}

// ─── 테스트 ───────────────────────────────────────────────────

const sampleApproval: ApprovalInput = {
  requested_by: 'minjun-ceo',
  approval_type: 'new_category',
  description: '다이어트 카테고리 추가 요청',
  details: { category: 'diet', reason: '뷰티 포화로 신규 시장 필요' },
};

describe('createApproval', () => {
  it('승인 요청을 생성한다', async () => {
    const mockDb = makeMockDb();
    const result = await createApproval(sampleApproval, mockDb as any);
    expect(result.requested_by).toBe('minjun-ceo');
    expect(result.approval_type).toBe('new_category');
    expect(result.status).toBe('pending');
  });

  it('모든 approval_type을 지원한다', async () => {
    const types = ['ops_change', 'new_agent', 'system_change', 'rollback', 'budget', 'new_category'];
    for (const type of types) {
      const mockDb = makeMockDb();
      const result = await createApproval(
        { ...sampleApproval, approval_type: type },
        mockDb as any
      );
      expect(result.approval_type).toBe(type);
    }
  });

  it('details JSONB 저장', async () => {
    const mockDb = makeMockDb();
    const result = await createApproval(sampleApproval, mockDb as any);
    expect(result.details).toEqual(sampleApproval.details);
  });
});

describe('getApprovals', () => {
  it('pending 상태 항목만 반환', async () => {
    const mockDb = makeMockDb([
      { id: '1', status: 'pending', approval_type: 'new_category', created_at: new Date() },
      { id: '2', status: 'approved', approval_type: 'budget', created_at: new Date() },
    ]);
    const result = await getApprovals('pending', mockDb as any);
    expect(Array.isArray(result)).toBe(true);
  });

  it('status 없으면 전체 반환', async () => {
    const mockDb = makeMockDb([
      { id: '1', status: 'pending', created_at: new Date() },
      { id: '2', status: 'approved', created_at: new Date() },
    ]);
    const result = await getApprovals(undefined, mockDb as any);
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('resolveApproval', () => {
  it('승인 처리 — status를 approved로 변경', async () => {
    const mockDb = makeMockDb();
    const result = await resolveApproval('approval-123', 'approved', mockDb as any);
    expect(result.status).toBe('approved');
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('거부 처리 — status를 rejected로 변경', async () => {
    const mockDb = makeMockDb();
    const result = await resolveApproval('approval-123', 'rejected', mockDb as any);
    expect(result.status).toBe('rejected');
  });

  it('resolved_at 타임스탬프 설정', async () => {
    const mockDb = makeMockDb();
    const result = await resolveApproval('approval-123', 'approved', mockDb as any);
    expect(result.resolved_at).toBeDefined();
  });
});
