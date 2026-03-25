/**
 * @file rollback-strategy.ts — 전략 롤백 스크립트
 *
 * 트리거:
 *   1. 자동: agent_episodes에서 pipeline_run 최근 3건 중 gate_failures >= 2가 2건 이상
 *   2. 수동: --force --version <ver>
 *
 * 절차:
 *   1. 트리거 체크 (자동 모드)
 *   2. 이전 성공 버전 탐색 → revertStrategy() 호출
 *   3. pending_approvals에 rollback 이벤트 기록
 *   4. agent_episodes에 에피소드 기록
 *
 * 사용:
 *   npx tsx scripts/rollback-strategy.ts                    # 자동 트리거 체크
 *   npx tsx scripts/rollback-strategy.ts --force v2.0       # 강제 롤백
 *   npx tsx scripts/rollback-strategy.ts --dry-run          # 드라이런
 */

import 'dotenv/config';
import { db } from '../src/db/index.js';
import { agentEpisodes, strategyArchive } from '../src/db/schema.js';
import { revertStrategy, getActiveStrategy } from '../src/db/strategy-archive.js';
import { createApproval } from '../src/db/pending-approvals.js';
import { eq, desc } from 'drizzle-orm';

// ─── Config ───────────────────────────────────────────────────

const GATE_FAILURE_THRESHOLD = 2;   // gate_failures >= N 을 "실패"로 판단
const FAILURE_WINDOW = 3;           // 최근 N건 pipeline_run 검사

// ─── Types ────────────────────────────────────────────────────

interface PipelineRunDetails {
  phases_completed?: number;
  gate_failures?: number;
  errors?: string[];
  revenue_today?: number;
}

interface RollbackResult {
  triggered: boolean;
  reason: string;
  targetVersion?: string;
  previousVersion?: string | null;
  dryRun?: boolean;
}

// ─── Trigger Check ───────────────────────────────────────────

/**
 * 최근 pipeline_run 에피소드에서 gate_failures가 임계값 이상인 건수 확인.
 * 2건 이상이면 자동 롤백 트리거.
 */
async function checkAutoTrigger(): Promise<{ should: boolean; reason: string }> {
  const recentRuns = await db
    .select()
    .from(agentEpisodes)
    .where(eq(agentEpisodes.event_type, 'pipeline_run'))
    .orderBy(desc(agentEpisodes.occurred_at))
    .limit(FAILURE_WINDOW);

  if (recentRuns.length < FAILURE_WINDOW) {
    return { should: false, reason: `pipeline_run 기록 ${recentRuns.length}건 (최소 ${FAILURE_WINDOW}건 필요)` };
  }

  const failCount = recentRuns.filter((run) => {
    const details = run.details as PipelineRunDetails | null;
    return (details?.gate_failures ?? 0) >= GATE_FAILURE_THRESHOLD;
  }).length;

  if (failCount >= 2) {
    return {
      should: true,
      reason: `최근 ${FAILURE_WINDOW}건 중 ${failCount}건 gate_failures >= ${GATE_FAILURE_THRESHOLD}`,
    };
  }

  return { should: false, reason: `gate_failures 조건 미달 (${failCount}/${FAILURE_WINDOW}건)` };
}

// ─── Find Rollback Target ─────────────────────────────────────

/**
 * 가장 최근 'archived' 버전 탐색 (= 이전 성공 버전).
 */
async function findRollbackTarget(): Promise<string | null> {
  const rows = await db
    .select()
    .from(strategyArchive)
    .where(eq(strategyArchive.status, 'archived'))
    .orderBy(desc(strategyArchive.created_at))
    .limit(1);

  return rows[0]?.version ?? null;
}

// ─── Log Episode (inline, T4 memory.ts 없어도 동작) ──────────

async function logRollbackEpisode(summary: string, details: Record<string, unknown>): Promise<void> {
  await db.insert(agentEpisodes).values({
    agent_id: 'system',
    event_type: 'decision',
    summary,
    details,
  });
}

// ─── Main ─────────────────────────────────────────────────────

async function run(): Promise<RollbackResult> {
  const args = process.argv.slice(2);
  const isForce = args.includes('--force');
  const isDryRun = args.includes('--dry-run');
  const forceVersion = isForce ? args[args.indexOf('--force') + 1] : undefined;

  console.log('=== 전략 롤백 스크립트 ===');
  if (isDryRun) console.log('[DRY RUN 모드 — 실제 변경 없음]');

  const current = await getActiveStrategy();
  console.log(`현재 active 전략: ${current?.version ?? '없음'}`);

  // ── 트리거 판단 ──
  let triggerReason: string;

  if (isForce) {
    triggerReason = `수동 롤백 요청 (--force)`;
    console.log(`수동 트리거: ${triggerReason}`);
  } else {
    const check = await checkAutoTrigger();
    if (!check.should) {
      console.log(`롤백 트리거 없음: ${check.reason}`);
      return { triggered: false, reason: check.reason };
    }
    triggerReason = check.reason;
    console.log(`자동 트리거: ${triggerReason}`);
  }

  // ── 대상 버전 결정 ──
  const targetVersion = forceVersion ?? (await findRollbackTarget());

  if (!targetVersion) {
    console.error('롤백 대상 버전을 찾을 수 없습니다 (archived 버전 없음)');
    return { triggered: true, reason: triggerReason + ' — 대상 없음' };
  }

  console.log(`롤백 대상: ${targetVersion}`);

  if (isDryRun) {
    return {
      triggered: true,
      reason: triggerReason,
      targetVersion,
      previousVersion: current?.version,
      dryRun: true,
    };
  }

  // ── 롤백 실행 ──
  const result = await revertStrategy(targetVersion);
  console.log(`롤백 완료: ${result.previousVersion} → ${result.targetVersion}`);

  // ── pending_approvals 기록 ──
  await createApproval({
    requested_by: 'system',
    approval_type: 'rollback',
    description: `전략 자동 롤백: ${result.previousVersion} → ${result.targetVersion}`,
    details: {
      trigger_reason: triggerReason,
      previous_version: result.previousVersion,
      target_version: result.targetVersion,
      rolled_back_at: new Date().toISOString(),
    },
  });

  // ── 에피소드 기록 ──
  await logRollbackEpisode(
    `전략 롤백: ${result.previousVersion} → ${result.targetVersion}`,
    {
      trigger_reason: triggerReason,
      previous_version: result.previousVersion,
      target_version: result.targetVersion,
    },
  );

  console.log('pending_approvals + agent_episodes 기록 완료');

  return {
    triggered: true,
    reason: triggerReason,
    targetVersion: result.targetVersion,
    previousVersion: result.previousVersion,
  };
}

run()
  .then((result) => {
    if (!result.triggered) {
      console.log('\n결과: 롤백 불필요');
    } else if (result.dryRun) {
      console.log(`\n결과 [DRY RUN]: ${result.previousVersion} → ${result.targetVersion} 롤백 예정`);
    } else {
      console.log(`\n결과: 롤백 완료 ${result.previousVersion} → ${result.targetVersion}`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('롤백 실패:', err);
    process.exit(1);
  });
