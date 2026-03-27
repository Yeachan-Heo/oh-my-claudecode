/**
 * @file self-healing.ts — Phase 3-C: 에이전트 자기 건강 점검 모듈.
 *
 * task 완료 후 에이전트가 자신의 최근 에피소드를 조회하여 실패율을 계산하고,
 * 이상 감지 시 태호(엔지니어)에게 alert 메시지를 전송한다.
 *
 * 규칙:
 * - 에피소드 < 5건: 항상 healthy (초기 단계)
 * - 최근 5건 중 error 비율 > 30% (2건+): unhealthy → alert
 * - 프롬프트 성과 하락 감지: issues에 기록만, 자동 롤백은 Phase 4
 * - alert은 sendMessage로 DB 저장 (텔레그램은 Phase 4)
 */

import { db } from '../db/index.js';
import { agentEpisodes, agentPromptVersions } from '../db/schema.js';
import { logEpisode } from '../db/memory.js';
import { sendMessage } from '../db/agent-messages.js';
import { eq, desc } from 'drizzle-orm';

// ─── Types ────────────────────────────────────────────────

export interface HealthCheck {
  agentId: string;
  recentEpisodeCount: number;
  failureRate: number;   // 0~1
  isHealthy: boolean;
  issues: string[];
  actions: string[];     // 취한 조치
}

// ─── Constants ────────────────────────────────────────────

const EPISODE_WINDOW = 5;
const FAILURE_RATE_THRESHOLD = 0.3; // 30% 초과 시 unhealthy

// ─── Helpers ──────────────────────────────────────────────

/**
 * 최근 N건 에피소드 조회.
 */
async function fetchRecentEpisodes(agentId: string, limit: number) {
  return db
    .select()
    .from(agentEpisodes)
    .where(eq(agentEpisodes.agent_id, agentId))
    .orderBy(desc(agentEpisodes.occurred_at))
    .limit(limit);
}

/**
 * 활성 프롬프트와 직전 버전의 performance_score 비교.
 * 현재 버전 score < 이전 버전 score이면 issue 문자열 반환, 아니면 null.
 */
async function checkPromptPerformanceDrop(agentId: string): Promise<string | null> {
  const rows = await db
    .select({
      version: agentPromptVersions.version,
      performance_score: agentPromptVersions.performance_score,
      is_active: agentPromptVersions.is_active,
    })
    .from(agentPromptVersions)
    .where(eq(agentPromptVersions.agent_id, agentId))
    .orderBy(desc(agentPromptVersions.version))
    .limit(2);

  if (rows.length < 2) return null;

  const current = rows[0];
  const previous = rows[1];

  // score가 null이면 비교 불가
  if (current.performance_score == null || previous.performance_score == null) return null;

  if (current.performance_score < previous.performance_score) {
    return (
      `프롬프트 성과 하락 감지: v${current.version} (score=${current.performance_score.toFixed(2)}) ` +
      `< v${previous.version} (score=${previous.performance_score.toFixed(2)}). ` +
      `자동 롤백 보류 — Phase 4 AutoResearch에서 처리 예정.`
    );
  }

  return null;
}

// ─── Main API ─────────────────────────────────────────────

/**
 * task 완료 후 에이전트 자기 건강 점검.
 *
 * @param agentId - 점검 대상 에이전트 ID
 * @returns HealthCheck 결과
 */
export async function checkAgentHealth(agentId: string): Promise<HealthCheck> {
  const issues: string[] = [];
  const actions: string[] = [];

  // 1. 최근 에피소드 조회
  const episodes = await fetchRecentEpisodes(agentId, EPISODE_WINDOW);
  const recentEpisodeCount = episodes.length;

  // 2. 에피소드 < 5건: 초기 단계 — 항상 healthy
  if (recentEpisodeCount < EPISODE_WINDOW) {
    const result: HealthCheck = {
      agentId,
      recentEpisodeCount,
      failureRate: 0,
      isHealthy: true,
      issues: [],
      actions: ['에피소드 수 부족 (초기 단계) — 건강 점검 생략'],
    };

    await logEpisode({
      agentId,
      eventType: 'health_check',
      summary: `Health check: OK — 에피소드 ${recentEpisodeCount}건 (5건 미만, 초기 단계)`,
      details: { recentEpisodeCount, failureRate: 0, issues: [], actions: result.actions },
    });

    return result;
  }

  // 3. 실패율 계산
  const errorCount = episodes.filter(
    (e: { event_type: string }) => e.event_type === 'error',
  ).length;
  const failureRate = errorCount / recentEpisodeCount;

  if (failureRate > FAILURE_RATE_THRESHOLD) {
    issues.push(
      `실패율 초과: 최근 ${recentEpisodeCount}건 중 ${errorCount}건 에러 (${(failureRate * 100).toFixed(0)}%)`,
    );
  }

  // 4. 프롬프트 성과 하락 감지
  const promptIssue = await checkPromptPerformanceDrop(agentId).catch(() => null);
  if (promptIssue) {
    issues.push(promptIssue);
  }

  const isHealthy = issues.length === 0;

  // 5. unhealthy → 태호(엔지니어)에게 alert 전송
  if (!isHealthy) {
    await sendMessage(
      agentId,
      'taeho-engineer',
      'system-alerts',
      `[HEALTH_ALERT] ${agentId} 실패율 ${(failureRate * 100).toFixed(0)}% (최근 ${recentEpisodeCount}건 중 ${errorCount}건 에러)`,
      { issues },
      'alert',
    );
    actions.push(`태호(엔지니어)에게 alert 전송 — 채널: system-alerts`);
  }

  // 6. 결과 에피소드 기록
  await logEpisode({
    agentId,
    eventType: isHealthy ? 'health_check' : 'health_alert',
    summary: `Health check: ${isHealthy ? 'OK' : 'ALERT'} — failureRate=${failureRate.toFixed(2)}`,
    details: { recentEpisodeCount, failureRate, issues, actions },
  });

  return {
    agentId,
    recentEpisodeCount,
    failureRate,
    isHealthy,
    issues,
    actions,
  };
}
