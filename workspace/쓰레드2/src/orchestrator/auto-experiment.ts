/**
 * @file auto-experiment - CEO 자율 실험 설계 시스템.
 *
 * 성과 데이터 기반 실험 자동 설계 + 자율 권한 레벨에 따른 승인/자율 실행.
 *
 * Autonomy Levels:
 *   0 (manual)           — 모든 실험 시훈 승인 필요 (기본)
 *   1 (low-risk)         — 훅 변형, 시간대 이동 자율 (성공 3회+)
 *   2 (medium-risk)      — 카테고리 비율 조정 자율 (성공 10회+)
 *   3 (high-risk-only)   — high-risk만 승인 (성공 20회+)
 */

import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { createExperiment, getActiveExperiments, closeExperiment } from '../db/experiments.js';
import { sendMessage } from '../db/agent-messages.js';

// ---------------------------------------------------------------------------
// Autonomy level table
// ---------------------------------------------------------------------------

const AUTONOMY_LEVELS = {
  0: { name: 'manual',            description: '모든 실험 시훈 승인 필요', maxRisk: 'none',   requiredSuccesses: 0  },
  1: { name: 'low-risk',          description: '훅 변형, 시간대 이동 자율',  maxRisk: 'low',    requiredSuccesses: 3  },
  2: { name: 'medium-risk',       description: '카테고리 비율 조정 자율',   maxRisk: 'medium', requiredSuccesses: 10 },
  3: { name: 'high-risk-only',    description: 'high-risk만 승인',        maxRisk: 'high',   requiredSuccesses: 20 },
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExperimentDesign {
  hypothesis: string;
  variable: string;
  variant_a: string;
  variant_b: string;
  risk_level: 'low' | 'medium' | 'high';
  trigger: string;
}

export interface PerformanceData {
  category_scores: Record<string, number>;
  bottom_categories: string[];
  trending_keywords: string[];
  recent_hooks: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMostFrequent(arr: string[]): string {
  const counts = new Map<string, number>();
  for (const item of arr) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * 성과 데이터 기반 실험 자동 설계.
 * 우선순위: 하위 카테고리 포맷 실험 > 신규 트렌드 시간대 실험 > 훅 반복 실험
 */
export function designExperiment(data: PerformanceData): ExperimentDesign | null {
  // Priority 1: Bottom category → format experiment
  if (data.bottom_categories.length > 0) {
    const cat = data.bottom_categories[0];
    return {
      hypothesis: `${cat} 카테고리에서 비교형 포맷이 리스트형보다 참여율 높다`,
      variable: 'format',
      variant_a: '리스트형',
      variant_b: '비교형',
      risk_level: 'low',
      trigger: `${cat} 카테고리 성과 하위 20%`,
    };
  }

  // Priority 2: Trending keyword → timing experiment
  if (data.trending_keywords.length > 0) {
    const kw = data.trending_keywords[0];
    return {
      hypothesis: `트렌드 키워드 "${kw}" 포스트를 오전 8시에 올리면 저녁 8시보다 조회수 높다`,
      variable: 'timing',
      variant_a: '08:00',
      variant_b: '20:00',
      risk_level: 'low',
      trigger: `신규 트렌드 "${kw}"`,
    };
  }

  // Priority 3: Hook repetition → hook experiment
  if (data.recent_hooks.length >= 3) {
    const dominant = getMostFrequent(data.recent_hooks);
    return {
      hypothesis: `질문형 훅이 ${dominant}보다 참여율 높다`,
      variable: 'hook_type',
      variant_a: dominant,
      variant_b: '질문형',
      risk_level: 'low',
      trigger: `훅 반복 감지: ${dominant}`,
    };
  }

  return null;
}

/**
 * 현재 자율 레벨 계산 — 성공한 실험(verdict='success') 개수 기반.
 */
export async function getCurrentAutonomyLevel(): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS successes
    FROM experiments
    WHERE status = 'closed' AND verdict = 'success'
  `);
  const successes = (result as unknown as Array<{ successes: number }>)[0]?.successes ?? 0;
  if (successes >= 20) return 3;
  if (successes >= 10) return 2;
  if (successes >= 3)  return 1;
  return 0;
}

/**
 * 실험 제안 — 자율 레벨에 따라 승인 요청 또는 자율 실행.
 * Returns "PENDING_APPROVAL:<id>" | "AUTO_APPROVED:<id>"
 */
export async function proposeExperiment(design: ExperimentDesign): Promise<string> {
  const level = await getCurrentAutonomyLevel();
  const riskOrder: Array<ExperimentDesign['risk_level'] | 'none'> = ['none', 'low', 'medium', 'high'];
  const maxRisk = AUTONOMY_LEVELS[level as keyof typeof AUTONOMY_LEVELS].maxRisk;
  const needsApproval = riskOrder.indexOf(design.risk_level) > riskOrder.indexOf(maxRisk);

  const row = await createExperiment(
    design.hypothesis, design.variable, design.variant_a, design.variant_b,
  );
  const experimentId = row.id;

  if (needsApproval) {
    await sendMessage(
      'minjun-ceo', 'sihun', 'async',
      `[실험 승인 요청] ${design.hypothesis}\n변수: ${design.variable}\nA: ${design.variant_a} / B: ${design.variant_b}\n위험도: ${design.risk_level}\n자율 레벨: ${level} (${AUTONOMY_LEVELS[level as keyof typeof AUTONOMY_LEVELS].name})\n트리거: ${design.trigger}\n→ 승인이 필요합니다.`,
      { experiment_id: experimentId, risk_level: design.risk_level, autonomy_level: level },
    );
    return `PENDING_APPROVAL:${experimentId}`;
  }

  await sendMessage(
    'minjun-ceo', 'all', 'standup',
    `[자율 실험 시작] ${design.hypothesis}\n변수: ${design.variable} | 위험도: ${design.risk_level} | 레벨 ${level} (${AUTONOMY_LEVELS[level as keyof typeof AUTONOMY_LEVELS].name})\n트리거: ${design.trigger}`,
    { experiment_id: experimentId, autonomy_level: level },
  );
  return `AUTO_APPROVED:${experimentId}`;
}

/**
 * 승인된 실험 실행 — autonomy_level 컬럼 업데이트.
 */
export async function executeApprovedExperiment(experimentId: string): Promise<void> {
  const level = await getCurrentAutonomyLevel();
  await db.execute(sql`
    UPDATE experiments
    SET autonomy_level = ${level}
    WHERE id = ${experimentId}
  `);
}

/**
 * 48h 후 자동 평가 — 경과 여부만 판단, 실제 평가는 evaluateExperiment() 위임.
 * Returns "WAIT:<Nh remaining>" | "READY_FOR_EVALUATION:<id>" | "NOT_FOUND"
 */
export async function evaluateAndDecide(experimentId: string): Promise<string> {
  const rows = await db.execute(sql`
    SELECT id, start_date FROM experiments WHERE id = ${experimentId}
  `);
  if ((rows as unknown[]).length === 0) return 'NOT_FOUND';

  const exp = (rows as unknown as Array<{ id: string; start_date: Date }>)[0];
  const hoursSince = (Date.now() - new Date(exp.start_date).getTime()) / (1000 * 60 * 60);

  if (hoursSince < 48) return `WAIT:${Math.round(48 - hoursSince)}h remaining`;
  return `READY_FOR_EVALUATION:${experimentId}`;
}

// Re-export for convenience
export { getActiveExperiments, closeExperiment };
