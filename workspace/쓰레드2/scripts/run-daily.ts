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
    case 'evening':
      // 성과 추적 — track-performance.ts 호출
      // (기존 스크립트 재사용)
      console.log('[binilab] 성과 추적 시작...');
      break;
    case 'retro':
      console.log('[binilab] 주간 회고 시작...');
      break;
  }

  console.log(`[binilab] ${phase} 완료 — ${new Date().toISOString()}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
