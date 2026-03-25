/**
 * @file Bottleneck diagnosis engine — traces revenue problems back to their
 * root cause in the pipeline and generates tuning actions.
 *
 * Implements the decision tree from plan.md section 8:
 *
 *   수익 낮음
 *   ├─ 도달 낮음?          → 'publishing' (시간대/계정 제한)
 *   ├─ CTR 낮음?           → 'content' or 'matching'
 *   │   ├─ product_relevance 높음? → 'content' (글 스타일 변경)
 *   │   └─ product_relevance 낮음? → 'matching' (매칭 로직 수정)
 *   ├─ CTR 정상 + 전환 낮음? → 'product' (가격/리뷰/신뢰도)
 *   └─ 전체 저조?          → 'collection' (필터 강화)
 */

import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  diagnosisReports,
  tuningActions as tuningActionsTable,
  contentLifecycle,
} from '../db/schema.js';
import type {
  DiagnosisReport,
  TuningAction,
} from '../types.js';
import { getWeeklyStats } from './metrics.js';
import type { WeeklyStats } from './metrics.js';
import { generateId } from '../utils/id.js';

// ─── Thresholds ──────────────────────────────────────────

export const THRESHOLDS = {
  MIN_REACH: 100,                    // impressions — below = publishing issue
  MIN_CTR: 0.01,                     // click-through rate — below = content/matching issue
  MIN_CONVERSION: 0.001,             // conversion rate — below = product issue
  MIN_REVENUE_PER_POST: 100,         // KRW — below = overall underperformance
  PRODUCT_RELEVANCE_THRESHOLD: 0.5,  // above = matching OK, content problem
};

// ─── Diagnosis Types ─────────────────────────────────────

export type BottleneckType = 'collection' | 'analysis' | 'matching' | 'content' | 'publishing' | 'none';

export interface DiagnosisResult {
  bottleneck: BottleneckType;
  evidence: string;
  stats: WeeklyStats;
}

// ─── Utility ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] [diagnosis] ${msg}`);
}

// ─── Bottleneck Diagnosis ────────────────────────────────

/**
 * Diagnose the primary bottleneck in the pipeline based on weekly stats.
 *
 * Decision tree (plan.md section 8):
 * 1. Revenue OK? → 'none'
 * 2. Reach low? → 'publishing'
 * 3. CTR low?
 *    - product_relevance high → 'content'
 *    - product_relevance low  → 'matching'
 * 4. CTR OK + conversion low? → 'matching' (product issue mapped to matching target)
 * 5. Everything low? → 'collection'
 */
export function diagnoseBottleneck(weeklyStats: WeeklyStats): DiagnosisResult {
  const {
    avgRevenuePerPost,
    avgReach,
    avgCtr,
    avgConversionRate,
    avgProductRelevance,
    totalPosts,
  } = weeklyStats;

  // No data — cannot diagnose
  if (totalPosts === 0) {
    return {
      bottleneck: 'none',
      evidence: '진단할 포스트가 없습니다.',
      stats: weeklyStats,
    };
  }

  // Revenue is fine
  if (avgRevenuePerPost >= THRESHOLDS.MIN_REVENUE_PER_POST) {
    return {
      bottleneck: 'none',
      evidence: `포스트당 평균 수익 ${avgRevenuePerPost.toFixed(0)}원 — 정상 범위.`,
      stats: weeklyStats,
    };
  }

  // --- Revenue is below threshold — trace the cause ---

  // 1. Reach problem?
  if (avgReach < THRESHOLDS.MIN_REACH) {
    return {
      bottleneck: 'publishing',
      evidence: `평균 도달 ${avgReach.toFixed(0)}회 < 임계값 ${THRESHOLDS.MIN_REACH}. 발행 시간대/계정 상태 확인 필요.`,
      stats: weeklyStats,
    };
  }

  // 2. CTR problem?
  if (avgCtr < THRESHOLDS.MIN_CTR) {
    if (avgProductRelevance >= THRESHOLDS.PRODUCT_RELEVANCE_THRESHOLD) {
      // Product match is OK → content itself is the issue
      return {
        bottleneck: 'content',
        evidence: `CTR ${(avgCtr * 100).toFixed(2)}% < ${(THRESHOLDS.MIN_CTR * 100).toFixed(1)}% 이지만 상품 적합도 ${avgProductRelevance.toFixed(2)} 양호. 콘텐츠 스타일 변경 필요.`,
        stats: weeklyStats,
      };
    }
    // Product match is weak
    return {
      bottleneck: 'matching',
      evidence: `CTR ${(avgCtr * 100).toFixed(2)}% < ${(THRESHOLDS.MIN_CTR * 100).toFixed(1)}%, 상품 적합도 ${avgProductRelevance.toFixed(2)} 낮음. 매칭 로직 수정 필요.`,
      stats: weeklyStats,
    };
  }

  // 3. CTR OK but conversion low?
  if (avgConversionRate < THRESHOLDS.MIN_CONVERSION) {
    return {
      bottleneck: 'matching',
      evidence: `CTR ${(avgCtr * 100).toFixed(2)}% 정상이지만 전환율 ${(avgConversionRate * 100).toFixed(3)}% < ${(THRESHOLDS.MIN_CONVERSION * 100).toFixed(2)}%. 상품 자체 문제 (가격/리뷰/신뢰도). 전환율 낮은 상품 비활성화 필요.`,
      stats: weeklyStats,
    };
  }

  // 4. Everything is borderline low → collection issue
  return {
    bottleneck: 'collection',
    evidence: `전체 지표 저조 (수익 ${avgRevenuePerPost.toFixed(0)}원/포스트). 수집 필터 강화 및 소스 채널 재검토 필요.`,
    stats: weeklyStats,
  };
}

// ─── Tuning Action Generation ────────────────────────────

/**
 * Generate concrete tuning actions based on the diagnosis result.
 * Maps to the action table in plan.md section 8.
 */
export function generateTuningActions(diagnosis: DiagnosisResult): TuningAction[] {
  const actions: TuningAction[] = [];

  switch (diagnosis.bottleneck) {
    case 'collection':
      actions.push({
        target: 'scraper',
        action: '최소 engagement 임계값 상향 조정 (저품질 소스 필터링)',
        priority: 'high',
        applied: false,
        applied_at: null,
      });
      actions.push({
        target: 'scraper',
        action: '수집 키워드/채널 추가 또는 저성과 채널 제거',
        priority: 'medium',
        applied: false,
        applied_at: null,
      });
      break;

    case 'analysis':
      actions.push({
        target: 'analyzer',
        action: '니즈 추출 프롬프트 수정 (false positive 감소)',
        priority: 'high',
        applied: false,
        applied_at: null,
      });
      actions.push({
        target: 'analyzer',
        action: 'confidence 임계값 조정 (낮은 신뢰도 니즈 필터링)',
        priority: 'medium',
        applied: false,
        applied_at: null,
      });
      break;

    case 'matching':
      actions.push({
        target: 'matcher',
        action: '전환율 낮은 상품 비활성화',
        priority: 'high',
        applied: false,
        applied_at: null,
      });
      actions.push({
        target: 'matcher',
        action: '고전환 카테고리 가중치 상향',
        priority: 'medium',
        applied: false,
        applied_at: null,
      });
      break;

    case 'content':
      actions.push({
        target: 'content_generator',
        action: '성공 포스트 스타일 분석 → 생성 프롬프트 반영',
        priority: 'high',
        applied: false,
        applied_at: null,
      });
      actions.push({
        target: 'content_generator',
        action: 'A/B 테스트: 훅 타입별 성과 비교 실행',
        priority: 'medium',
        applied: false,
        applied_at: null,
      });
      break;

    case 'publishing':
      actions.push({
        target: 'publisher',
        action: '시간대별 최적 스케줄 업데이트 (성과 데이터 기반)',
        priority: 'high',
        applied: false,
        applied_at: null,
      });
      actions.push({
        target: 'publisher',
        action: '부진 계정 교체 우선순위 지정',
        priority: 'medium',
        applied: false,
        applied_at: null,
      });
      break;

    case 'none':
      // No actions needed
      break;
  }

  return actions;
}

// ─── Report Creation ─────────────────────────────────────

/**
 * Create a full weekly diagnosis report:
 * 1. Aggregate weekly stats
 * 2. Diagnose bottleneck
 * 3. Generate tuning actions
 * 4. Persist to diagnosis_reports + tuning_actions tables
 *
 * @param weekStart - Monday 00:00 of the target week
 */
export async function createDiagnosisReport(weekStart: Date): Promise<DiagnosisReport> {
  log(`주간 진단 시작: ${weekStart.toISOString()}`);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  // 1. Aggregate stats
  const stats = await getWeeklyStats(weekStart);

  // 2. Diagnose
  const diagnosis = diagnoseBottleneck(stats);

  // 3. Generate actions
  const actions = generateTuningActions(diagnosis);

  // 4. Count top/bottom for cohort stats
  // Re-fetch mature posts to compute top/bottom 10%
  const maturePosts = await db
    .select()
    .from(contentLifecycle)
    .where(
      sql`${contentLifecycle.posted_at} >= ${weekStart}
          AND ${contentLifecycle.posted_at} <= ${weekEnd}
          AND ${contentLifecycle.maturity} IN ('mature', 'final')`,
    );

  const topCount = Math.max(1, Math.ceil(maturePosts.length * 0.1));
  const bottomCount = Math.max(1, Math.ceil(maturePosts.length * 0.1));

  // 5. Build report
  const reportId = generateId('diag');
  const report: DiagnosisReport = {
    id: reportId,
    report_type: 'weekly',
    period_start: weekStart.toISOString(),
    period_end: weekEnd.toISOString(),
    created_at: new Date().toISOString(),
    total_posts: stats.totalPosts,
    top_10_percent_count: maturePosts.length > 0 ? topCount : 0,
    bottom_10_percent_count: maturePosts.length > 0 ? bottomCount : 0,
    avg_source_engagement: 0, // Would require additional query; set to 0 for now
    avg_need_confidence: 0,
    avg_ctr: stats.avgCtr,
    avg_conversion_rate: stats.avgConversionRate,
    avg_revenue_per_post: stats.avgRevenuePerPost,
    bottleneck: diagnosis.bottleneck,
    bottleneck_evidence: diagnosis.evidence,
    tuning_actions: actions,
    ai_analysis: null, // Populated by AI analysis step (weekly TOP/BOTTOM comparison)
  };

  // 6. Insert diagnosis report
  await db.insert(diagnosisReports).values({
    id: report.id,
    report_type: report.report_type,
    period_start: weekStart,
    period_end: weekEnd,
    total_posts: report.total_posts,
    top_10_percent_count: report.top_10_percent_count,
    bottom_10_percent_count: report.bottom_10_percent_count,
    avg_source_engagement: report.avg_source_engagement,
    avg_need_confidence: report.avg_need_confidence,
    avg_ctr: report.avg_ctr,
    avg_conversion_rate: report.avg_conversion_rate,
    avg_revenue_per_post: report.avg_revenue_per_post,
    bottleneck: report.bottleneck,
    bottleneck_evidence: report.bottleneck_evidence,
    ai_analysis: report.ai_analysis,
  });

  // 7. Insert tuning actions
  for (const action of actions) {
    const actionId = generateId('tune');
    await db.insert(tuningActionsTable).values({
      id: actionId,
      report_id: reportId,
      target: action.target,
      action: action.action,
      priority: action.priority,
      applied: action.applied,
      applied_at: null,
    });
  }

  log(`진단 완료: bottleneck=${report.bottleneck}, actions=${actions.length}건`);
  return report;
}

// ─── Latest Diagnosis Retrieval ──────────────────────────

/**
 * Retrieve the most recent diagnosis report with its unapplied tuning actions.
 * Returns null if no reports exist yet (graceful degradation).
 */
export async function getLatestDiagnosis(): Promise<DiagnosisReport | null> {
  const rows = await db
    .select()
    .from(diagnosisReports)
    .orderBy(desc(diagnosisReports.created_at))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0]!;

  // Fetch associated tuning actions
  const actionRows = await db
    .select()
    .from(tuningActionsTable)
    .where(eq(tuningActionsTable.report_id, row.id));

  const tuning_actions: TuningAction[] = actionRows.map((a) => ({
    target: a.target as TuningAction['target'],
    action: a.action,
    priority: a.priority as TuningAction['priority'],
    applied: a.applied,
    applied_at: a.applied_at ? a.applied_at.toISOString() : null,
  }));

  return {
    id: row.id,
    report_type: row.report_type as DiagnosisReport['report_type'],
    period_start: row.period_start.toISOString(),
    period_end: row.period_end.toISOString(),
    created_at: row.created_at.toISOString(),
    total_posts: row.total_posts,
    top_10_percent_count: row.top_10_percent_count,
    bottom_10_percent_count: row.bottom_10_percent_count,
    avg_source_engagement: row.avg_source_engagement,
    avg_need_confidence: row.avg_need_confidence,
    avg_ctr: row.avg_ctr,
    avg_conversion_rate: row.avg_conversion_rate,
    avg_revenue_per_post: row.avg_revenue_per_post,
    bottleneck: row.bottleneck as DiagnosisReport['bottleneck'],
    bottleneck_evidence: row.bottleneck_evidence,
    tuning_actions,
    ai_analysis: row.ai_analysis,
  };
}

// ─── Tuning Action Application ───────────────────────────

/**
 * Mark a tuning action as applied (sets applied=true and applied_at=now).
 */
export async function applyTuningAction(actionId: string): Promise<void> {
  await db
    .update(tuningActionsTable)
    .set({
      applied: true,
      applied_at: new Date(),
    })
    .where(eq(tuningActionsTable.id, actionId));

  log(`튜닝 액션 적용 완료: ${actionId}`);
}
