/**
 * @file auto-evolve.ts — AutoResearch 에이전트 진화 모듈 (Phase 4-B)
 *
 * 에이전트 프롬프트를 자동으로 평가하고 진화시키는 주간 루프.
 * - rollback: 자동 실행 (failureRate > 0.3)
 * - evolve: 스켈레톤 생성 + 수동 활성화 필요 (taskCompletionRate < 0.5)
 * - keep: 현행 유지
 */

import { db } from '../db/index.js';
import { agentTasks, agentEpisodes, agentPromptVersions } from '../db/schema.js';
import { createPromptVersion, activateVersion } from '../db/prompt-versions.js';
import { logEpisode } from '../db/memory.js';
import { setState } from '../db/system-state.js';
import { AGENT_REGISTRY } from './agent-spawner.js';
import { eq, and, gte, desc } from 'drizzle-orm';

// ─── Types ───────────────────────────────────────────────

export interface AgentMetrics {
  taskCompletionRate: number;  // 완료된 task / 전체 task
  avgTaskDuration: number;     // 평균 task 소요 시간 (ms)
  failureRate: number;         // error episode / 전체 episode
  qualityScore: number;        // 0~1, verified task 비율
}

export interface EvolutionReport {
  agentId: string;
  currentVersion: number;
  metrics: AgentMetrics;
  recommendation: 'keep' | 'evolve' | 'rollback';
  reason: string;
}

// ─── calculateAgentMetrics ───────────────────────────────

/**
 * 에이전트별 5-Layer 메트릭 계산.
 * 데이터 0건이면 기본값 반환 (taskCompletionRate=1, failureRate=0 등).
 */
export async function calculateAgentMetrics(
  agentId: string,
  periodDays: number = 7,
): Promise<AgentMetrics> {
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - periodDays);

  // ── 1. taskCompletionRate / qualityScore / avgTaskDuration ──
  const tasks = await db
    .select()
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.assigned_to, agentId),
        gte(agentTasks.created_at, periodStart),
      ),
    );

  let taskCompletionRate = 1;
  let qualityScore = 1;
  let avgTaskDuration = 0;

  if (tasks.length > 0) {
    const done = tasks.filter(
      (t) => t.status === 'done' || t.status === 'verified',
    );
    taskCompletionRate = done.length / tasks.length;

    const verified = tasks.filter((t) => t.status === 'verified');
    qualityScore = done.length > 0 ? verified.length / done.length : 0;

    // avgTaskDuration: started_at ~ completed_at 평균
    const durations = done
      .filter((t) => t.started_at != null && t.completed_at != null)
      .map(
        (t) =>
          new Date(t.completed_at!).getTime() -
          new Date(t.started_at!).getTime(),
      );
    avgTaskDuration =
      durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0;
  }

  // ── 2. failureRate ──
  const episodes = await db
    .select()
    .from(agentEpisodes)
    .where(
      and(
        eq(agentEpisodes.agent_id, agentId),
        gte(agentEpisodes.occurred_at, periodStart),
      ),
    );

  let failureRate = 0;
  if (episodes.length > 0) {
    const errors = episodes.filter((e) => e.event_type === 'error');
    failureRate = errors.length / episodes.length;
  }

  return { taskCompletionRate, avgTaskDuration, failureRate, qualityScore };
}

// ─── evaluateForEvolution ────────────────────────────────

/**
 * 메트릭 기반 진화 권장 — keep / evolve / rollback.
 * 결과는 agent_episodes에 기록된다.
 */
export async function evaluateForEvolution(
  agentId: string,
): Promise<EvolutionReport> {
  const metrics = await calculateAgentMetrics(agentId);

  // 현재 활성 버전 조회
  const activeRows = await db
    .select({
      version: agentPromptVersions.version,
      performance_score: agentPromptVersions.performance_score,
    })
    .from(agentPromptVersions)
    .where(
      and(
        eq(agentPromptVersions.agent_id, agentId),
        eq(agentPromptVersions.is_active, true),
      ),
    )
    .orderBy(desc(agentPromptVersions.version))
    .limit(1);

  const currentVersion = activeRows[0]?.version ?? 1;

  // ── 판단 기준 ──
  let recommendation: 'keep' | 'evolve' | 'rollback' = 'keep';
  let reason = '메트릭 정상 — 현행 프롬프트 유지';

  if (metrics.failureRate > 0.3) {
    // 이전 버전이 있을 때만 rollback 권장
    const prevRows = await db
      .select({ version: agentPromptVersions.version })
      .from(agentPromptVersions)
      .where(
        and(
          eq(agentPromptVersions.agent_id, agentId),
          eq(agentPromptVersions.is_active, false),
        ),
      )
      .orderBy(desc(agentPromptVersions.version))
      .limit(1);

    if (prevRows.length > 0) {
      recommendation = 'rollback';
      reason = `failureRate=${(metrics.failureRate * 100).toFixed(1)}% > 30% — 이전 버전(v${prevRows[0].version})으로 롤백 권장`;
    } else {
      recommendation = 'keep';
      reason = `failureRate=${(metrics.failureRate * 100).toFixed(1)}% > 30%이지만 이전 버전 없음 — 유지`;
    }
  } else if (metrics.taskCompletionRate < 0.5) {
    recommendation = 'evolve';
    reason = `taskCompletionRate=${(metrics.taskCompletionRate * 100).toFixed(1)}% < 50% — 새 프롬프트 버전 필요`;
  }

  const report: EvolutionReport = {
    agentId,
    currentVersion,
    metrics,
    recommendation,
    reason,
  };

  // 에피소드 기록
  await logEpisode({
    agentId,
    eventType: 'evolution_eval',
    summary: `[AUTO-EVOLVE] ${agentId} → ${recommendation}: ${reason}`,
    details: {
      currentVersion,
      metrics,
      recommendation,
      reason,
    },
  });

  return report;
}

// ─── runWeeklyEvolution ──────────────────────────────────

/**
 * 주간 전체 에이전트 진화 루프.
 * - evolve: 새 프롬프트 버전 스켈레톤 생성 (is_active=false, 수동 활성화 필요)
 * - rollback: 이전 활성 버전으로 자동 롤백
 */
export async function runWeeklyEvolution(): Promise<EvolutionReport[]> {
  const reports: EvolutionReport[] = [];

  for (const agentId of Object.keys(AGENT_REGISTRY)) {
    const report = await evaluateForEvolution(agentId);
    reports.push(report);

    if (report.recommendation === 'evolve') {
      // 새 프롬프트 버전 스켈레톤 생성 (수동 활성화 필요)
      await createPromptVersion({
        agent_id: agentId,
        version: report.currentVersion + 1,
        prompt_text: `[AUTO-EVOLVE] ${report.reason}\n\n기존 프롬프트 개선 필요`,
        is_active: false,
      });
    } else if (report.recommendation === 'rollback') {
      // 이전 활성 버전으로 자동 롤백
      await activateVersion(agentId, report.currentVersion - 1);
    }
  }

  // system_state에 진화 실행 기록
  await setState(
    'last_weekly_evolution',
    {
      ran_at: new Date().toISOString(),
      agent_count: reports.length,
      summary: reports.map((r) => ({
        agentId: r.agentId,
        recommendation: r.recommendation,
        reason: r.reason,
      })),
    },
    'auto-evolve',
  );

  return reports;
}
