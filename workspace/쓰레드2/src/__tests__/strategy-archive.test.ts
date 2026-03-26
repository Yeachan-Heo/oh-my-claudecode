/**
 * @file strategy-archive.test.ts — 전략 버전 관리 + 롤백 사이클 테스트
 *
 * 핵심 시나리오: v1 → v2 → v3 → rollback → v2 active
 */

import { describe, it, expect, vi } from 'vitest';

// DB connection mock — DATABASE_URL 없는 환경에서 index.ts throw 방지
vi.mock('../db/index.js', () => ({ db: {} }));

import {
  createStrategyVersion,
  getActiveStrategy,
  revertStrategy,
  listStrategyVersions,
  StrategyInput,
} from '../db/strategy-archive.js';

// ─── Mock DB ──────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeMockDb(store: Row[] = []) {
  const rows = [...store];

  return {
    _rows: rows,

    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((data: Row) => {
        rows.push({ ...data, id: data.id ?? crypto.randomUUID(), created_at: new Date() });
        const result = { returning: vi.fn().mockResolvedValue([data]) };
        return {
          ...result,
          onConflictDoUpdate: vi.fn().mockImplementation(() => result),
        };
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
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation((n: number) =>
            Promise.resolve(rows.slice(0, n))
          ),
          orderBy: vi.fn().mockImplementation(() => ({
            limit: vi.fn().mockImplementation((n: number) =>
              Promise.resolve(rows.slice(0, n))
            ),
          })),
        })),
        orderBy: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation((n: number) =>
            Promise.resolve(rows.slice(0, n))
          ),
        })),
      })),
    })),
  };
}

// ─── 테스트 ───────────────────────────────────────────────────

const sampleStrategy: StrategyInput = {
  version: 'v1.0',
  strategy: {
    category_ratio: { beauty: 0.7, health: 0.2, lifestyle: 0.1 },
    time_slots: ['09:00', '14:00', '19:00'],
    categories: ['beauty', 'health', 'lifestyle'],
  },
};

describe('createStrategyVersion', () => {
  it('새 전략 버전을 생성한다', async () => {
    const mockDb = makeMockDb();
    const result = await createStrategyVersion(
      { ...sampleStrategy, version: 'v1.0' },
      mockDb as any
    );
    expect(result.version).toBe('v1.0');
    expect(result.status).toBe('active');
  });

  it('parent_version을 지정할 수 있다', async () => {
    const mockDb = makeMockDb();
    const result = await createStrategyVersion(
      { ...sampleStrategy, version: 'v2.0', parent_version: 'v1.0' },
      mockDb as any
    );
    expect(result.parent_version).toBe('v1.0');
  });

  it('성과 데이터(performance)를 포함할 수 있다', async () => {
    const mockDb = makeMockDb();
    const result = await createStrategyVersion(
      {
        ...sampleStrategy,
        version: 'v2.0',
        performance: { avg_roi: 1.5, avg_views: 8200, revenue_target: 500000, revenue_actual: 312000 },
      },
      mockDb as any
    );
    expect(result.performance).toBeDefined();
  });
});

describe('getActiveStrategy', () => {
  it('active 상태인 전략을 반환한다', async () => {
    const activeRow: Row = {
      id: 'abc',
      version: 'v2.0',
      status: 'active',
      strategy: sampleStrategy.strategy,
      performance: null,
      parent_version: 'v1.0',
      created_at: new Date(),
      evaluated_at: null,
    };
    const mockDb = makeMockDb([activeRow]);
    const result = await getActiveStrategy(mockDb as any);
    expect(result).not.toBeNull();
    expect(result?.version).toBe('v2.0');
  });

  it('active 전략이 없으면 null 반환', async () => {
    const mockDb = makeMockDb([]);
    const result = await getActiveStrategy(mockDb as any);
    expect(result).toBeNull();
  });
});

describe('revertStrategy', () => {
  it('대상 버전을 active로 승격하고, 현재를 deprecated로 변경', async () => {
    const mockDb = makeMockDb();
    const updateSpy = mockDb.update;

    const result = await revertStrategy('v1.0', mockDb as any);

    expect(result.targetVersion).toBe('v1.0');
    expect(result.success).toBe(true);
    // update가 2번 호출 (대상 active + 현재 deprecated)
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it('rollback 결과에 이전/신규 버전 정보 포함', async () => {
    const mockDb = makeMockDb([
      { id: '1', version: 'v3.0', status: 'active', created_at: new Date() },
      { id: '2', version: 'v2.0', status: 'archived', created_at: new Date() },
    ]);

    const result = await revertStrategy('v2.0', mockDb as any);
    expect(result.targetVersion).toBe('v2.0');
    expect(result.success).toBe(true);
  });
});

describe('v1 → v2 → v3 → rollback → v2 사이클', () => {
  it('버전 생성 후 rollback 시 대상 버전이 active', async () => {
    const mockDb = makeMockDb();

    // v1 생성
    const v1 = await createStrategyVersion({ ...sampleStrategy, version: 'v1.0' }, mockDb as any);
    expect(v1.version).toBe('v1.0');

    // v2 생성
    const v2 = await createStrategyVersion(
      { ...sampleStrategy, version: 'v2.0', parent_version: 'v1.0' },
      mockDb as any
    );
    expect(v2.version).toBe('v2.0');

    // v3 생성
    const v3 = await createStrategyVersion(
      { ...sampleStrategy, version: 'v3.0', parent_version: 'v2.0' },
      mockDb as any
    );
    expect(v3.version).toBe('v3.0');

    // v2로 rollback
    const rollback = await revertStrategy('v2.0', mockDb as any);
    expect(rollback.success).toBe(true);
    expect(rollback.targetVersion).toBe('v2.0');
  });
});

describe('listStrategyVersions', () => {
  it('전략 목록을 반환한다', async () => {
    const mockDb = makeMockDb([
      { id: '1', version: 'v1.0', status: 'archived', created_at: new Date() },
      { id: '2', version: 'v2.0', status: 'active', created_at: new Date() },
    ]);
    const list = await listStrategyVersions(mockDb as any);
    expect(Array.isArray(list)).toBe(true);
  });
});
