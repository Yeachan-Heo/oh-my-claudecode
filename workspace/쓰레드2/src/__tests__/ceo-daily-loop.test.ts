/**
 * @file src/__tests__/ceo-daily-loop.test.ts
 * CEO 일일 브리핑 루프 — 브리핑 생성 + dispatch 호출 검증
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────

/**
 * DB 쿼리 체이닝 mock builder.
 * db.select().from().where().orderBy().limit() 패턴을 지원한다.
 * resolvedRows: 마지막 await 시 반환할 rows
 */
function chainMock(resolvedRows: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.where = vi.fn(self);
  chain.orderBy = vi.fn(self);
  chain.limit = vi.fn(() => Promise.resolve(resolvedRows));
  // select().from().where() — limit 없이 바로 await 하는 경우
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(resolvedRows).then(resolve);
  return chain;
}

// 각 쿼리별 응답 설정용 카운터
let selectCallIndex = 0;
const selectResponses: unknown[][] = [];

vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn((..._args: unknown[]) => {
      const rows = selectResponses[selectCallIndex] ?? [];
      selectCallIndex++;
      return chainMock(rows);
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    }),
  },
}));

vi.mock('../db/schema.js', () => ({
  threadPosts: { crawl_at: 'crawl_at' },
  dailyPerformanceReports: { report_date: 'report_date' },
  agentTasks: { status: 'status' },
  meetings: {
    created_at: 'created_at',
    agenda: 'agenda',
    meeting_type: 'meeting_type',
    created_by: 'created_by',
    status: 'status',
  },
}));

// dispatchToAgent mock
const mockDispatch = vi.fn().mockResolvedValue('mock-msg-id');
vi.mock('../orchestrator/agent-actions.js', () => ({
  dispatchToAgent: (...args: unknown[]) => mockDispatch(...args),
}));

// drizzle-orm mock
vi.mock('drizzle-orm', () => ({
  sql: Object.assign((..._args: unknown[]) => 'sql-tag', { raw: (s: string) => s }),
  desc: vi.fn(() => 'desc'),
  gte: vi.fn(() => 'gte'),
}));

import {
  formatBriefing,
  runCeoDailyLoop,
  gatherBriefingData,
  type DailyBriefingData,
} from '../../scripts/ceo-daily-loop.js';

// ─── Helpers ─────────────────────────────────────────────────

function makeBriefingData(overrides: Partial<DailyBriefingData> = {}): DailyBriefingData {
  return {
    postsLast24h: 12,
    latestReport: {
      reportDate: '2026-03-29',
      totalPosts: 45,
      totalViews: 8500,
      totalLikes: 320,
      avgEngagementRate: 0.045,
      topPostText: '요즘 피부 건조해서 세라마이드 크림 쓰기 시작했는데 진짜 다름',
    },
    pendingTaskCount: 3,
    recentMeetings: [
      { agenda: '주간 콘텐츠 전략', type: 'weekly', createdBy: 'minjun-ceo', status: 'concluded' },
    ],
    ...overrides,
  };
}

/**
 * gatherBriefingData가 호출하는 4개 쿼리에 대응하는 mock 응답 설정.
 * 순서: countRecentPosts, getLatestReport, countPendingTasks, getRecentMeetings
 */
function setupDbResponses(data: DailyBriefingData) {
  selectCallIndex = 0;
  selectResponses.length = 0;
  // 1. countRecentPosts
  selectResponses.push([{ count: data.postsLast24h }]);
  // 2. getLatestReport
  selectResponses.push(data.latestReport ? [{
    report_date: new Date(data.latestReport.reportDate),
    total_posts: data.latestReport.totalPosts,
    total_views: data.latestReport.totalViews,
    total_likes: data.latestReport.totalLikes,
    avg_engagement_rate: data.latestReport.avgEngagementRate,
    top_post_text: data.latestReport.topPostText,
  }] : []);
  // 3. countPendingTasks
  selectResponses.push([{ count: data.pendingTaskCount }]);
  // 4. getRecentMeetings
  selectResponses.push(data.recentMeetings.map(m => ({
    agenda: m.agenda,
    type: m.type,
    createdBy: m.createdBy,
    status: m.status,
  })));
}

// ─── formatBriefing ──────────────────────────────────────────

describe('formatBriefing', () => {
  it('핵심 지표가 포함된 브리핑 메시지를 생성한다', () => {
    const data = makeBriefingData();
    const result = formatBriefing(data);

    // 포스트 현황
    expect(result).toContain('최근 24h 수집: 12건');
    expect(result).toContain('누적 포스트: 45개');
    expect(result).toContain('총 조회수: 8,500');
    expect(result).toContain('총 좋아요: 320');
    expect(result).toContain('평균 참여율: 4.5%');
    expect(result).toContain('세라마이드 크림');

    // 미처리 태스크
    expect(result).toContain('대기/진행 중: 3건');

    // 최근 회의
    expect(result).toContain('주간 콘텐츠 전략');
    expect(result).toContain('weekly');

    // CEO 판단 요청 섹션
    expect(result).toContain('판단 요청');
    expect(result).toContain('_create-meeting.ts');
    expect(result).toContain('_dispatch.ts');
  });

  it('성과 리포트가 없으면 "아직 없음" 표시', () => {
    const data = makeBriefingData({ latestReport: null });
    const result = formatBriefing(data);

    expect(result).toContain('성과 리포트: 아직 없음');
    expect(result).not.toContain('누적 포스트');
  });

  it('미처리 태스크 5건 초과 시 경고 표시', () => {
    const data = makeBriefingData({ pendingTaskCount: 8 });
    const result = formatBriefing(data);

    expect(result).toContain('대기/진행 중: 8건');
    expect(result).toContain('태스크 적체');
  });

  it('최근 회의가 없으면 "최근 회의 없음" 표시', () => {
    const data = makeBriefingData({ recentMeetings: [] });
    const result = formatBriefing(data);

    expect(result).toContain('최근 회의 없음');
  });

  it('날짜가 포함된 헤더를 생성한다', () => {
    const data = makeBriefingData();
    const result = formatBriefing(data);
    const today = new Date().toISOString().slice(0, 10);

    expect(result).toContain(`일일 브리핑 (${today})`);
  });

  it('topPostText가 60자 초과 시 잘라서 표시', () => {
    const longText = 'a'.repeat(100);
    const data = makeBriefingData({
      latestReport: {
        reportDate: '2026-03-29',
        totalPosts: 10,
        totalViews: 100,
        totalLikes: 5,
        avgEngagementRate: 0.01,
        topPostText: longText,
      },
    });
    const result = formatBriefing(data);

    expect(result).toContain('a'.repeat(60) + '...');
    expect(result).not.toContain('a'.repeat(61) + '...');
  });
});

// ─── gatherBriefingData ──────────────────────────────────────

describe('gatherBriefingData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DB에서 4개 지표를 수집하여 반환한다', async () => {
    const expected = makeBriefingData();
    setupDbResponses(expected);

    const result = await gatherBriefingData();

    expect(result.postsLast24h).toBe(12);
    expect(result.latestReport).not.toBeNull();
    expect(result.latestReport!.totalViews).toBe(8500);
    expect(result.pendingTaskCount).toBe(3);
    expect(result.recentMeetings).toHaveLength(1);
  });

  it('성과 리포트가 없으면 null 반환', async () => {
    const expected = makeBriefingData({ latestReport: null });
    setupDbResponses(expected);

    const result = await gatherBriefingData();
    expect(result.latestReport).toBeNull();
  });
});

// ─── runCeoDailyLoop (dispatch 호출 검증) ─────────────────────

describe('runCeoDailyLoop dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dry-run 모드에서는 dispatch를 호출하지 않는다', async () => {
    const data = makeBriefingData();
    setupDbResponses(data);

    const result = await runCeoDailyLoop({ dryRun: true });

    expect(result.dispatched).toBe(false);
    expect(result.message).toContain('일일 브리핑');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('일반 모드에서 CEO에게 dispatch한다', async () => {
    const data = makeBriefingData();
    setupDbResponses(data);

    const result = await runCeoDailyLoop({ dryRun: false });

    expect(result.dispatched).toBe(true);
    expect(result.msgId).toBe('mock-msg-id');
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    const callArgs = mockDispatch.mock.calls[0]![0];
    expect(callArgs.target).toBe('minjun-ceo');
    expect(callArgs.roomId).toMatch(/^ceo-daily-\d{4}-\d{2}-\d{2}$/);
    expect(callArgs.message).toContain('일일 브리핑');
    expect(callArgs.extra).toEqual({ dmRoom: true, dmParticipants: ['system', 'minjun-ceo'] });
  });
});
