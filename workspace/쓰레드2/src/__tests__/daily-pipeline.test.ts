/**
 * @file daily-pipeline.test.ts — buildDirective + phase gate content validation tests.
 *
 * TDD: buildDirective 공통 함수 추출 + gatePhase2/3 내용 검증.
 * Mocking: client (postgres.js tagged template) + sendMessage + logDecision + getDiversityReport
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── vi.hoisted: define mock functions before vi.mock hoisting ──────────────
const { mockClient } = vi.hoisted(() => ({
  mockClient: vi.fn(),
}));

// ─── Mock: postgres.js client (tagged template literal) ─────────────────────
vi.mock('../db/index.js', () => ({
  client: mockClient,
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'mock-id' }]),
      }),
    }),
  },
}));

vi.mock('../db/schema.js', () => ({
  agentMessages: {},
}));

// ─── Mock: sendMessage ──────────────────────────────────────────────────────
vi.mock('../db/agent-messages.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({ id: 'mock-msg-id' }),
}));

// ─── Mock: learning modules ─────────────────────────────────────────────────
vi.mock('../learning/strategy-logger.js', () => ({
  logDecision: vi.fn(),
  updatePlaybook: vi.fn(),
}));

vi.mock('../learning/diversity-checker.js', () => ({
  getDiversityReport: vi.fn().mockReturnValue({ warnings: [] }),
}));

// ─── Mock: safety gates ─────────────────────────────────────────────────────
vi.mock('../safety/gates.js', () => ({
  runSafetyGates: vi.fn().mockResolvedValue({ allPassed: true, results: [] }),
}));

// ─── Mock: meeting ──────────────────────────────────────────────────────────
vi.mock('../orchestrator/meeting.js', () => ({
  startMeeting: vi.fn().mockResolvedValue({ meetingId: 'mock-meeting-id' }),
  concludeMeeting: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock: memory ───────────────────────────────────────────────────────────
vi.mock('../db/memory.js', () => ({
  logEpisode: vi.fn(),
}));

import { buildDirective, gatePhase2, gatePhase3, runQA } from '../orchestrator/daily-pipeline.js';
import type { ContentDraft } from '../orchestrator/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Setup mockClient to return appropriate data for fetchPhase2Data queries.
 * client is called as tagged template 4 times inside buildDirective:
 *   1. fetchPhase2Data: category stats query
 *   2. fetchPhase2Data: brand events count query
 *   3. content_lifecycle diversity check
 *   4. recycle candidates
 *
 * postgres.js tagged template calls client(strings, ...values).
 * We mock at the top level — fetchPhase2Data uses Promise.all so
 * queries 1 & 2 are resolved in order of mockResolvedValueOnce.
 */
function setupMockClient(overrides?: {
  categoryStats?: Array<{ category: string; avg_views: number; engagement_rate: number }>;
  brandEventsCount?: number;
}) {
  const categoryStats = overrides?.categoryStats ?? [
    { category: '뷰티', avg_views: 5000, engagement_rate: 0.05 },
    { category: '건강', avg_views: 3000, engagement_rate: 0.03 },
    { category: '생활', avg_views: 2000, engagement_rate: 0.02 },
    { category: '다이어트', avg_views: 1000, engagement_rate: 0.01 },
  ];
  const brandEventsCount = overrides?.brandEventsCount ?? 5;

  mockClient
    // fetchPhase2Data — category stats query
    .mockResolvedValueOnce(categoryStats)
    // fetchPhase2Data — brand events count query
    .mockResolvedValueOnce([{ cnt: brandEventsCount }])
    // diversity check — content_lifecycle query
    .mockResolvedValueOnce([])
    // recycle candidates query
    .mockResolvedValueOnce([]);
}

// ─── Task 2: buildDirective ─────────────────────────────────────────────────

describe('buildDirective', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return a DailyDirective with correct structure', async () => {
    setupMockClient();
    const directive = await buildDirective(10, '2026-03-25');
    expect(directive).toHaveProperty('date', '2026-03-25');
    expect(directive).toHaveProperty('total_posts', 10);
    expect(directive).toHaveProperty('category_allocation');
    expect(directive).toHaveProperty('time_slots');
    expect(directive).toHaveProperty('roi_summary');
    expect(Object.values(directive.category_allocation).reduce((a: number, b: number) => a + b, 0)).toBe(10);
  });

  it('should allocate 70% regular and 30% experiment', async () => {
    setupMockClient();
    const directive = await buildDirective(10, '2026-03-25');
    expect(directive.regular_posts).toBe(7);
    expect(directive.experiment_posts).toBe(3);
  });

  it('should generate time_slots matching totalPosts count', async () => {
    setupMockClient();
    const directive = await buildDirective(10, '2026-03-25');
    expect(directive.time_slots).toHaveLength(10);
  });

  it('should include roi_summary for all default categories', async () => {
    setupMockClient();
    const directive = await buildDirective(10, '2026-03-25');
    expect(directive.roi_summary).toHaveProperty('뷰티');
    expect(directive.roi_summary).toHaveProperty('건강');
    expect(directive.roi_summary).toHaveProperty('생활');
    expect(directive.roi_summary).toHaveProperty('다이어트');
  });

  it('should add diversity warning when brandEventsCount < 3', async () => {
    setupMockClient({ brandEventsCount: 1 });
    const directive = await buildDirective(10, '2026-03-25');
    expect(directive.diversity_warnings).toContain('브랜드 이벤트 3개 미만 — research-brands.ts 재실행 필요');
  });

  it('should assign experiment_id to experiment-type slots', async () => {
    setupMockClient();
    const directive = await buildDirective(10, '2026-03-25');
    const experimentSlots = directive.time_slots.filter((s) => s.type === 'experiment');
    for (const slot of experimentSlots) {
      expect(slot.experiment_id).toMatch(/^EXP-\d{8}-\d{3}$/);
    }
  });
});

// ─── Task 3: Phase Gate content validation ──────────────────────────────────

describe('gatePhase3 content validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fail when no CEO message exists', async () => {
    // No messages for today
    mockClient.mockResolvedValueOnce([]);
    const result = await gatePhase3();
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('스탠드업 메시지 없음');
  });

  it('should fail when CEO message has no directive in metadata', async () => {
    // Message exists but metadata has no 'directive' key
    mockClient.mockResolvedValueOnce([
      { message: 'test standup', metadata: {} },
    ]);
    const result = await gatePhase3();
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('directive');
  });

  it('should fail when CEO message metadata is null', async () => {
    mockClient.mockResolvedValueOnce([
      { message: 'test standup', metadata: null },
    ]);
    const result = await gatePhase3();
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('directive');
  });

  it('should pass when CEO message has directive in metadata', async () => {
    mockClient.mockResolvedValueOnce([
      { message: '[daily_directive] 10개 슬롯', metadata: { directive: { date: '2026-03-25' } } },
    ]);
    const result = await gatePhase3();
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe('gatePhase2 content validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fail when no analyst message exists', async () => {
    mockClient.mockResolvedValueOnce([]);
    const result = await gatePhase2();
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('분석 메시지 없음');
  });

  it('should fail when analyst message is too short (< 20 chars)', async () => {
    mockClient.mockResolvedValueOnce([
      { message: '짧은 메시지' },
    ]);
    const result = await gatePhase2();
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('20자 미만');
  });

  it('should fail when analyst message is empty string', async () => {
    mockClient.mockResolvedValueOnce([
      { message: '' },
    ]);
    const result = await gatePhase2();
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('비어있거나 너무 짧음');
  });

  it('should pass when analyst message has sufficient content', async () => {
    mockClient.mockResolvedValueOnce([
      { message: '전일 성과 분석 완료: 뷰티 카테고리 평균 조회수 5,000회, 참여율 5% 기록' },
    ]);
    const result = await gatePhase2();
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ─── Task 4: buildDirective post_contracts ──────────────────────────────────

describe('buildDirective post_contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should generate post_contracts matching time_slots count', async () => {
    setupMockClient();
    const directive = await buildDirective(10, '2026-03-25');
    expect(directive.post_contracts).toBeDefined();
    expect(directive.post_contracts!.length).toBe(directive.time_slots.length);
  });

  it('should assign varied strategies across contracts', async () => {
    setupMockClient();
    const directive = await buildDirective(10, '2026-03-25');
    const strategies = new Set(directive.post_contracts!.map(c => c.strategy));
    expect(strategies.size).toBeGreaterThan(1);
  });

  it('should set lower thresholds for experiment slots', async () => {
    setupMockClient();
    const directive = await buildDirective(10, '2026-03-25');
    const experimentContracts = directive.post_contracts!.filter(
      (_, idx) => directive.time_slots[idx]!.type === 'experiment',
    );
    for (const contract of experimentContracts) {
      expect(contract.min_hook_score).toBe(5);
      expect(contract.min_originality_score).toBe(4);
    }
  });
});
