#!/usr/bin/env npx tsx
/**
 * BiniLab 일일 파이프라인 CLI 진입점
 * cron 또는 수동으로 실행:
 *   npx tsx scripts/run-daily.ts [--phase morning|evening|retro]
 *
 * Phases:
 *   morning (default): CEO 오케스트레이션 → 수집 → 분석 → 콘텐츠 → QA
 *   evening: 성과 추적 + 일일 보고
 *   retro: 주간 회고 + 전략 조정
 */
import { runCeoMorningLoop } from '../src/orchestrator/ceo-loop.js';
import { runDailyPipeline } from '../src/orchestrator/daily-pipeline.js';
import { processAllPending } from '../src/orchestrator/response-processor.js';
import { runWeeklyEvolution } from '../src/orchestrator/auto-evolve.js';
import { getDailyRevenueSummary } from '../src/db/revenue.js';

const phase = process.argv.includes('--phase')
  ? process.argv[process.argv.indexOf('--phase') + 1]
  : 'morning';

async function main() {
  console.log(`[binilab] ${phase} 파이프라인 시작 — ${new Date().toISOString()}`);

  switch (phase) {
    case 'morning': {
      // 1. CEO 오케스트레이션 (업무 할당)
      const briefing = await runCeoMorningLoop();
      console.log(`[binilab] CEO 브리핑: ${briefing.tasksCreated}건 업무 할당`);
      // 2. 파이프라인 실행
      await runDailyPipeline({ dryRun: false, autonomous: true, posts: 5 });
      break;
    }
    case 'evening': {
      console.log('[binilab] 성과 추적 시작...');

      // 1. PENDING_RESPONSE 처리 — 대시보드 채팅 응답 생성
      const pendingCount = await processAllPending();
      console.log(`[binilab] PENDING_RESPONSE: ${pendingCount}건 처리`);

      // 2. 일일 수익 요약
      const revenue = await getDailyRevenueSummary();
      console.log(`[binilab] 일일 수익: ₩${revenue.totalRevenue.toLocaleString()} (클릭 ${revenue.totalClicks}, 구매 ${revenue.totalPurchases})`);
      break;
    }
    case 'retro': {
      console.log('[binilab] 주간 회고 시작...');

      // 1. 에이전트 프롬프트 자동 진화 (Phase 4-B)
      const evolveResult = await runWeeklyEvolution();
      console.log(`[binilab] 에이전트 진화: ${evolveResult.length}명 평가 완료`);
      for (const r of evolveResult) {
        console.log(`  - ${r.agentId}: ${r.recommendation} (task완료율 ${(r.metrics.taskCompletionRate * 100).toFixed(0)}%, 실패율 ${(r.metrics.failureRate * 100).toFixed(0)}%)`);
      }
      break;
    }
  }

  console.log(`[binilab] ${phase} 완료 — ${new Date().toISOString()}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
