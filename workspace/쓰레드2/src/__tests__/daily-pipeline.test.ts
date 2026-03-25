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

import { buildDirective } from '../orchestrator/daily-pipeline.js';

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
