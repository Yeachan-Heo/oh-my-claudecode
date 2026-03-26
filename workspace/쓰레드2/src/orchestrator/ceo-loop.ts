/**
 * @file ceo-loop.ts — 민준(CEO) 일일 오케스트레이션 루프.
 *
 * 아침에 한 번 실행: 어제 성과 확인 → 전략 로드 → 업무 할당 → 브리핑 기록
 *
 * Phase 4에서 텔레그램 전송 추가 예정. 현재는 DB 기록만.
 */

import { db } from '../db/index.js';
import { dailyPerformanceReports, agentEpisodes } from '../db/schema.js';
import { getActiveStrategy } from '../db/strategy-archive.js';
import { createTask } from '../db/agent-tasks.js';
import { sendStructuredMessage } from '../db/agent-messages.js';
import { logEpisode } from '../db/memory.js';
import { desc, gte } from 'drizzle-orm';

// ─── Types ───────────────────────────────────────────────

export interface DailyBriefing {
  date: string;
  performanceSummary: string;
  tasksCreated: number;
  directiveSummary: string;
}

interface PerformanceSnapshot {
  total_views: number;
  total_likes: number;
  total_comments: number;
  avg_engagement_rate: number;
  views_growth_pct: number | null;
  top_post_text: string | null;
  new_posts_today: number;
  report_date: Date;
}

interface EpisodeRow {
  agent_id: string;
  event_type: string;
  summary: string;
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * 성과 데이터를 Orient 분석 텍스트로 변환.
 */
function buildPerformanceSummary(
  report: PerformanceSnapshot | null,
  episodes: EpisodeRow[],
): string {
  if (!report) {
    return '성과 데이터 없음 (아직 게시 전 또는 수집 미완료)';
  }

  const growth =
    report.views_growth_pct != null
      ? `${report.views_growth_pct >= 0 ? '+' : ''}${report.views_growth_pct.toFixed(1)}%`
      : 'N/A';

  const agentStats: Record<string, { done: number; failed: number }> = {};
  for (const ep of episodes) {
    const key = ep.agent_id;
    if (!agentStats[key]) agentStats[key] = { done: 0, failed: 0 };
    if (ep.event_type === 'error') {
      agentStats[key].failed += 1;
    } else {
      agentStats[key].done += 1;
    }
  }

  const agentLines = Object.entries(agentStats)
    .map(([id, s]) => `  - ${id}: 완료 ${s.done} / 실패 ${s.failed}`)
    .join('\n');

  return [
    `[${report.report_date.toISOString().slice(0, 10)} 성과]`,
    `조회수: ${report.total_views.toLocaleString()} (${growth})`,
    `좋아요: ${report.total_likes} | 댓글: ${report.total_comments}`,
    `평균 참여율: ${(report.avg_engagement_rate * 100).toFixed(2)}%`,
    `신규 포스트: ${report.new_posts_today}건`,
    report.top_post_text ? `최고 포스트: ${report.top_post_text.slice(0, 60)}…` : '',
    agentLines ? `\n[에이전트 24h 활동]\n${agentLines}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 전략의 category_allocation을 기반으로 오늘 업무 생성.
 * 수집 → junho-researcher, 분석 → seoyeon-analyst, 콘텐츠 → 카테고리 에디터.
 */
async function allocateTasks(
  categoryAllocation: Record<string, number>,
  date: string,
): Promise<number> {
  const EDITOR_MAP: Record<string, string> = {
    뷰티: 'bini-beauty-editor',
    건강: 'hana-health-editor',
    생활: 'sora-life-editor',
    다이어트: 'jiwoo-diet-editor',
  };

  let created = 0;

  // 1. 수집 업무 — junho-researcher
  try {
    await createTask({
      title: `[${date}] 일일 포스트 수집`,
      description: '벤치마크 채널 + 키워드 기반 포스트 수집. collect.ts 루프 실행.',
      assigned_to: 'junho-researcher',
      assigned_by: 'minjun-ceo',
      priority: 8,
      input_data: { date, type: 'collection' },
    });
    created += 1;
  } catch (err) {
    console.error('[CEO] 수집 업무 생성 실패:', err);
  }

  // 2. 분석 업무 — seoyeon-analyst
  try {
    await createTask({
      title: `[${date}] 일일 성과 분석`,
      description: '어제 수집 데이터 니즈 분석 + 카테고리별 성과 리포트 생성.',
      assigned_to: 'seoyeon-analyst',
      assigned_by: 'minjun-ceo',
      priority: 7,
      input_data: { date, type: 'analysis' },
    });
    created += 1;
  } catch (err) {
    console.error('[CEO] 분석 업무 생성 실패:', err);
  }

  // 3. 콘텐츠 업무 — 카테고리별 에디터
  for (const [category, slots] of Object.entries(categoryAllocation)) {
    const editorId = EDITOR_MAP[category];
    if (!editorId || slots <= 0) continue;

    try {
      await createTask({
        title: `[${date}] ${category} 콘텐츠 ${slots}건 작성`,
        description: `오늘 ${category} 슬롯 ${slots}건. 포스트 토론 시스템 + 체크리스트 통과 필수.`,
        assigned_to: editorId,
        assigned_by: 'minjun-ceo',
        priority: 6,
        input_data: { date, category, slots, type: 'content' },
      });
      created += 1;
    } catch (err) {
      console.error(`[CEO] ${category} 콘텐츠 업무 생성 실패:`, err);
    }
  }

  return created;
}

// ─── Main ─────────────────────────────────────────────────

/**
 * CEO 일일 오케스트레이션 — 아침에 한 번 실행.
 *
 * 단계:
 *  1. 어제 성과 로드 (daily_performance_reports)
 *  2. 에이전트별 24h 에피소드 조회 (agent_episodes)
 *  3. 현재 전략 로드 (strategy_archive)
 *  4. Orient 분석 — 성과 텍스트 생성
 *  5. 업무 할당 (agent_tasks)
 *  6. CEO 브리핑 메시지 기록 (agent_messages)
 *  7. CEO 에피소드 로그 (agent_episodes)
 */
export async function runCeoMorningLoop(): Promise<DailyBriefing> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  let performanceSummary = '성과 데이터 없음';
  let tasksCreated = 0;
  let directiveSummary = '전략 없음';

  // ── Step 1: 어제 성과 로드 ────────────────────────────
  let report: PerformanceSnapshot | null = null;
  try {
    const [row] = await db
      .select()
      .from(dailyPerformanceReports)
      .orderBy(desc(dailyPerformanceReports.report_date))
      .limit(1);
    report = (row as PerformanceSnapshot | undefined) ?? null;
  } catch (err) {
    console.error('[CEO] 성과 데이터 조회 실패:', err);
  }

  // ── Step 2: 에이전트별 24h 에피소드 ──────────────────
  let episodes: EpisodeRow[] = [];
  try {
    episodes = (await db
      .select()
      .from(agentEpisodes)
      .where(gte(agentEpisodes.occurred_at, yesterday))) as EpisodeRow[];
  } catch (err) {
    console.error('[CEO] 에피소드 조회 실패:', err);
  }

  // ── Step 3: 현재 전략 로드 ───────────────────────────
  let strategy: Awaited<ReturnType<typeof getActiveStrategy>> = null;
  try {
    strategy = await getActiveStrategy();
  } catch (err) {
    console.error('[CEO] 전략 로드 실패:', err);
  }

  // ── Step 4: Orient 분석 ──────────────────────────────
  try {
    performanceSummary = buildPerformanceSummary(report, episodes);
  } catch (err) {
    console.error('[CEO] 성과 요약 생성 실패:', err);
  }

  // ── Step 5: 업무 할당 ────────────────────────────────
  try {
    const allocation = (
      strategy?.strategy as { category_allocation?: Record<string, number> } | null
    )?.category_allocation ?? { 뷰티: 2, 건강: 1, 생활: 1 };

    tasksCreated = await allocateTasks(allocation, today);
    directiveSummary = `카테고리 할당: ${JSON.stringify(allocation)} | 총 ${tasksCreated}건 업무 생성`;
  } catch (err) {
    console.error('[CEO] 업무 할당 실패:', err);
  }

  // ── Step 6: CEO 브리핑 메시지 DB 기록 ───────────────
  try {
    await sendStructuredMessage({
      sender: 'minjun-ceo',
      recipient: 'all-agents',
      channel: 'ceo-briefing',
      messageType: 'directive',
      message: `[CEO 모닝 브리핑 ${today}]\n\n${performanceSummary}\n\n${directiveSummary}`,
      payload: {
        date: today,
        performance: report
          ? {
              total_views: report.total_views,
              total_likes: report.total_likes,
              avg_engagement_rate: report.avg_engagement_rate,
              views_growth_pct: report.views_growth_pct,
            }
          : null,
        strategy_version: strategy?.version ?? null,
        tasks_created: tasksCreated,
        directive_summary: directiveSummary,
      },
    });
  } catch (err) {
    console.error('[CEO] 브리핑 메시지 기록 실패:', err);
  }

  // ── Step 7: CEO 에피소드 로그 ────────────────────────
  try {
    await logEpisode({
      agentId: 'minjun-ceo',
      eventType: 'decision',
      summary: `모닝 루프 완료: ${tasksCreated}건 업무 할당`,
      details: {
        date: today,
        tasks_created: tasksCreated,
        has_performance_data: report !== null,
        strategy_version: strategy?.version ?? null,
      },
    });
  } catch (err) {
    console.error('[CEO] 에피소드 로그 실패:', err);
  }

  return {
    date: today,
    performanceSummary,
    tasksCreated,
    directiveSummary,
  };
}
