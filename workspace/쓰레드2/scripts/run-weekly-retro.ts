#!/usr/bin/env tsx
/**
 * run-weekly-retro.ts — 주간 전략회의 자동화
 *
 * Usage:
 *   npx tsx scripts/run-weekly-retro.ts              # 전체 실행
 *   npx tsx scripts/run-weekly-retro.ts --dry-run    # 데이터만 보기
 *   npx tsx scripts/run-weekly-retro.ts --apply      # 채널 교체 실행
 */
import 'dotenv/config';
import { db } from '../src/db/index.js';
import { sql } from 'drizzle-orm';
import { getDiversityReport } from '../src/learning/diversity-checker.js';
import { updateWeeklyInsights, logDecision } from '../src/learning/strategy-logger.js';
import { sendMessage } from '../src/db/agent-messages.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChannelStats {
  channel_id: string;
  name: string;
  avg_views: number;
  avg_engagement: number;
  post_count: number;
  score: number;
}

interface WeeklyPostStats {
  category: string;
  post_count: number;
  avg_views: number;
  max_views: number;
  avg_engagement_rate: number;
  roi_score: number;
}

interface ExperimentResult {
  id: string;
  hypothesis: string;
  variable: string;
  verdict: string | null;
  confidence: string | null;
  end_date: Date | null;
}

interface TopPost {
  id: string;
  category: string;
  view_count: number;
}

interface RetroData {
  date: string;
  week: string;
  thisWeek: {
    total_posts: number;
    total_views: number;
    avg_views: number;
    avg_engagement_rate: number;
  };
  lastWeek: {
    total_posts: number;
    total_views: number;
  };
  categoryStats: WeeklyPostStats[];
  channelScores: ChannelStats[];
  bottomChannels: ChannelStats[];
  closedExperiments: ExperimentResult[];
  diversityReport: ReturnType<typeof getDiversityReport>;
  topPost: TopPost | null;
}

interface WeeklyDecisions {
  retireChannels: ChannelStats[];
  categoryAdjustments: Array<{ category: string; action: string; reason: string }>;
  newExperimentProposals: Array<{ hypothesis: string; variable: string; reason: string }>;
  strategyNotes: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function calcViewsGrowth(thisWeekViews: number, lastWeekViews: number): number {
  if (lastWeekViews === 0) return 0;
  return Math.round((thisWeekViews - lastWeekViews) / lastWeekViews * 100);
}

// ── Core Functions ────────────────────────────────────────────────────────────

async function prepareRetroData(): Promise<RetroData> {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const week = `${now.getFullYear()}-W${String(getISOWeek(now)).padStart(2, '0')}`;

  // 1. 이번 주 자체 포스트 성과 (content_lifecycle: 우리가 직접 게시한 포스트)
  const thisWeekRows = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_posts,
      COALESCE(SUM(current_impressions), 0)::int AS total_views,
      COALESCE(ROUND(AVG(current_impressions)), 0)::int AS avg_views,
      COALESCE(ROUND(AVG(
        current_clicks::numeric
        / NULLIF(current_impressions, 0) * 100
      ), 2), 0)::float AS avg_engagement_rate
    FROM content_lifecycle
    WHERE posted_at >= NOW() - INTERVAL '7 days'
  `);
  const tw = (thisWeekRows as unknown[])[0] as Record<string, unknown>;

  // 2. 지난 주 성과 (비교용)
  const lastWeekRows = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_posts,
      COALESCE(SUM(current_impressions), 0)::int AS total_views
    FROM content_lifecycle
    WHERE posted_at >= NOW() - INTERVAL '14 days'
      AND posted_at < NOW() - INTERVAL '7 days'
  `);
  const lw = (lastWeekRows as unknown[])[0] as Record<string, unknown>;

  // 3. 카테고리별 ROI (content_lifecycle.need_category 기준)
  const catRows = await db.execute(sql`
    SELECT
      need_category AS category,
      COUNT(*)::int AS post_count,
      COALESCE(ROUND(AVG(current_impressions)), 0)::int AS avg_views,
      COALESCE(MAX(current_impressions), 0)::int AS max_views,
      COALESCE(ROUND(AVG(
        current_clicks::numeric
        / NULLIF(current_impressions, 0) * 100
      ), 2), 0)::float AS avg_engagement_rate
    FROM content_lifecycle
    WHERE posted_at >= NOW() - INTERVAL '7 days'
    GROUP BY need_category
    ORDER BY avg_views DESC
  `);
  const categoryStats: WeeklyPostStats[] = (catRows as unknown[]).map(r => {
    const row = r as Record<string, unknown>;
    const avgViews = Number(row.avg_views) || 0;
    const engRate = Number(row.avg_engagement_rate) || 0;
    return {
      category: String(row.category || '미분류'),
      post_count: Number(row.post_count) || 0,
      avg_views: avgViews,
      max_views: Number(row.max_views) || 0,
      avg_engagement_rate: engRate,
      roi_score: Math.round(avgViews / 1000 * (engRate * 100)),
    };
  });

  // 4. 채널 평가 (evaluate-channels.ts 로직 재사용)
  const channelRows = await db.execute(sql`
    SELECT
      c.channel_id,
      c.display_name AS name,
      COALESCE(ROUND(AVG(p.view_count)), 0)::int AS avg_views,
      COALESCE(ROUND(AVG(
        CASE WHEN COALESCE(p.view_count, 0) > 0
          THEN (COALESCE(p.like_count, 0) + COALESCE(p.reply_count, 0) + COALESCE(p.repost_count, 0))::numeric
               / p.view_count * 100
          ELSE 0
        END
      ), 2), 0)::float AS avg_engagement,
      COUNT(p.post_id)::int AS post_count
    FROM channels c
    LEFT JOIN thread_posts p ON p.channel_id = c.channel_id
      AND p.crawl_at < NOW() - INTERVAL '2 days'
    WHERE c.is_benchmark = true
      AND c.benchmark_status != 'retired'
    GROUP BY c.channel_id, c.display_name
  `);
  const channelScores: ChannelStats[] = (channelRows as unknown[])
    .map(r => {
      const row = r as Record<string, unknown>;
      const avgViews = Number(row.avg_views) || 0;
      const avgEng = Number(row.avg_engagement) || 0;
      const postCount = Number(row.post_count) || 0;
      return {
        channel_id: String(row.channel_id),
        name: String(row.name || row.channel_id),
        avg_views: avgViews,
        avg_engagement: Math.round(avgEng * 100) / 100,
        post_count: postCount,
        score: Math.round((avgViews * 0.4 + avgEng * 0.3 + postCount * 0.3) * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score);

  const bottomCount = Math.max(1, Math.ceil(channelScores.length * 0.2));
  const bottomChannels = channelScores.slice(-bottomCount);

  // 5. 최근 7일 내 완료된 실험
  const expRows = await db.execute(sql`
    SELECT id, hypothesis, variable, verdict, confidence, end_date
    FROM experiments
    WHERE status = 'closed'
      AND end_date >= NOW() - INTERVAL '7 days'
    ORDER BY end_date DESC
  `);
  const closedExperiments: ExperimentResult[] = (expRows as unknown[]).map(r => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      hypothesis: String(row.hypothesis || ''),
      variable: String(row.variable || ''),
      verdict: row.verdict != null ? String(row.verdict) : null,
      confidence: row.confidence != null ? String(row.confidence) : null,
      end_date: row.end_date instanceof Date ? row.end_date : null,
    };
  });

  // 6. 다양성 리포트 (최근 10개 자체 게시 포스트)
  const recentPostRows = await db.execute(sql`
    SELECT content_style, need_category, hook_type
    FROM content_lifecycle
    ORDER BY posted_at DESC
    LIMIT 10
  `);
  const diversityReport = getDiversityReport(
    (recentPostRows as unknown[]).map(r => {
      const row = r as Record<string, unknown>;
      return {
        content_style: String(row.content_style || ''),
        need_category: String(row.need_category || ''),
        hook_type: String(row.hook_type || ''),
      };
    }),
  );

  // 7. 이번 주 최고 포스트
  const topRows = await db.execute(sql`
    SELECT id, need_category AS category, current_impressions AS view_count
    FROM content_lifecycle
    WHERE posted_at >= NOW() - INTERVAL '7 days'
    ORDER BY current_impressions DESC
    LIMIT 1
  `);
  const topRow = (topRows as unknown[])[0] as Record<string, unknown> | undefined;
  const topPost: TopPost | null = topRow
    ? { id: String(topRow.id), category: String(topRow.category || ''), view_count: Number(topRow.view_count) || 0 }
    : null;

  return {
    date,
    week,
    thisWeek: {
      total_posts: Number(tw?.total_posts) || 0,
      total_views: Number(tw?.total_views) || 0,
      avg_views: Number(tw?.avg_views) || 0,
      avg_engagement_rate: Number(tw?.avg_engagement_rate) || 0,
    },
    lastWeek: {
      total_posts: Number(lw?.total_posts) || 0,
      total_views: Number(lw?.total_views) || 0,
    },
    categoryStats,
    channelScores,
    bottomChannels,
    closedExperiments,
    diversityReport,
    topPost,
  };
}

function generateDecisions(data: RetroData): WeeklyDecisions {
  // 하위 20% 채널 교체 후보
  const retireChannels = data.bottomChannels;

  // 카테고리 ROI 기반 비율 조정
  const avgROI = data.categoryStats.length > 0
    ? data.categoryStats.reduce((s, c) => s + c.roi_score, 0) / data.categoryStats.length
    : 0;
  const categoryAdjustments = data.categoryStats.map(cat => {
    if (cat.roi_score < avgROI * 0.5) {
      return { category: cat.category, action: '비율 감소', reason: `ROI ${cat.roi_score} (평균 ${Math.round(avgROI)}의 50% 미만)` };
    } else if (cat.roi_score > avgROI * 1.5) {
      return { category: cat.category, action: '비율 증가', reason: `ROI ${cat.roi_score} (평균 ${Math.round(avgROI)}의 150% 초과)` };
    }
    return { category: cat.category, action: '유지', reason: `ROI ${cat.roi_score}` };
  });

  // 성과 하위 카테고리 기반 실험 제안
  const newExperimentProposals: WeeklyDecisions['newExperimentProposals'] = [];
  const worstCategories = [...data.categoryStats].sort((a, b) => a.roi_score - b.roi_score).slice(0, 2);
  for (const cat of worstCategories) {
    newExperimentProposals.push({
      hypothesis: `${cat.category} 카테고리에서 훅 유형 변경 시 조회수 향상`,
      variable: 'hook_type',
      reason: `${cat.category} ROI ${cat.roi_score}로 하위권`,
    });
  }
  if (!data.diversityReport.isHealthy) {
    newExperimentProposals.push({
      hypothesis: '포맷·카테고리 다양성 확보 시 참여율 향상',
      variable: 'content_diversity',
      reason: `다양성 경고 ${data.diversityReport.warnings.length}개`,
    });
  }

  // 전략 노트
  const strategyNotes: string[] = [];
  const growth = calcViewsGrowth(data.thisWeek.total_views, data.lastWeek.total_views);
  if (growth <= -20) {
    strategyNotes.push(`⚠️ 조회수 전주 대비 ${growth}% 급락 — 원인 분석 필요`);
  } else if (growth >= 20) {
    strategyNotes.push(`✅ 조회수 전주 대비 +${growth}% 성장`);
  }
  if (!data.diversityReport.isHealthy) {
    strategyNotes.push(`⚠️ 콘텐츠 다양성 경고: ${data.diversityReport.warnings.map(w => w.warning).join(', ')}`);
  }

  return { retireChannels, categoryAdjustments, newExperimentProposals, strategyNotes };
}

async function saveRetro(data: RetroData, decisions: WeeklyDecisions): Promise<void> {
  const growth = calcViewsGrowth(data.thisWeek.total_views, data.lastWeek.total_views);
  const growthStr = `${growth >= 0 ? '+' : ''}${growth}%`;

  // 1. agents/memory/retro/retro-{date}.md 저장
  const retroDir = resolve(process.cwd(), 'agents/memory/retro');
  if (!existsSync(retroDir)) mkdirSync(retroDir, { recursive: true });

  const adjustedCategories = decisions.categoryAdjustments
    .filter(a => a.action !== '유지')
    .map(a => a.category)
    .join(', ');

  const retroContent = [
    `# 주간 전략회의 — ${data.date} (${data.week})`,
    '',
    '## 성과 요약',
    `- 총 게시: ${data.thisWeek.total_posts}개`,
    `- 총 조회수: ${data.thisWeek.total_views.toLocaleString()}뷰 (전주 대비 ${growthStr})`,
    `- 평균 조회수: ${data.thisWeek.avg_views.toLocaleString()}뷰/포스트`,
    `- 평균 참여율: ${data.thisWeek.avg_engagement_rate}%`,
    data.topPost ? `- 최고 포스트: [${data.topPost.category}] ${data.topPost.view_count.toLocaleString()}뷰` : '',
    '',
    '## 카테고리 ROI',
    '| 카테고리 | 포스트 | 평균뷰 | 참여율 | ROI | 조정 |',
    '|---------|-------|-------|-------|-----|------|',
    ...data.categoryStats.map(c => {
      const adj = decisions.categoryAdjustments.find(a => a.category === c.category);
      return `| ${c.category} | ${c.post_count} | ${c.avg_views.toLocaleString()} | ${c.avg_engagement_rate}% | ${c.roi_score} | ${adj?.action ?? '유지'} |`;
    }),
    '',
    '## 실험 결과',
    data.closedExperiments.length === 0
      ? '- 이번 주 완료된 실험 없음'
      : data.closedExperiments.map(e =>
        `- ${e.id}: ${e.hypothesis} → ${e.verdict ?? '미결론'} (신뢰도: ${e.confidence ?? '-'})`
      ).join('\n'),
    '',
    `## 경쟁사 채널 하위 20% (${decisions.retireChannels.length}개)`,
    ...decisions.retireChannels.map(c => `- ${c.name} (점수: ${c.score}, 평균 ${c.avg_views}뷰)`),
    '',
    '## 다음 주 실험 제안',
    ...decisions.newExperimentProposals.map((p, i) =>
      `${i + 1}. ${p.hypothesis}\n   변수: ${p.variable} | 근거: ${p.reason}`
    ),
    '',
    '## 다양성 리포트',
    data.diversityReport.isHealthy
      ? '✅ 건강한 다양성 유지'
      : `⚠️ 경고:\n${data.diversityReport.warnings.map(w => `- ${w.warning}`).join('\n')}`,
    '',
    '## 전략 노트',
    decisions.strategyNotes.length === 0 ? '- 특이사항 없음' : decisions.strategyNotes.join('\n'),
    '',
    '## Action Items',
    `- [ ] CEO: 채널 교체 최종 승인 후 --apply 실행 (${decisions.retireChannels.map(c => c.name).join(', ')})`,
    `- [ ] 서연: 신규 채널 ${decisions.retireChannels.length}개 발굴`,
    adjustedCategories ? `- [ ] 빈이: 카테고리 비율 조정 (${adjustedCategories})` : '',
    '',
  ].filter(line => line !== '').join('\n');

  const retroPath = resolve(retroDir, `retro-${data.date}.md`);
  writeFileSync(retroPath, retroContent, 'utf-8');
  console.log(`✅ 회의록 저장: ${retroPath}`);

  // 2. weekly-insights.md 업데이트
  const insights = [
    `- 총 조회수: ${data.thisWeek.total_views.toLocaleString()} (${growthStr})`,
    `- 평균 참여율: ${data.thisWeek.avg_engagement_rate}%`,
    `- 채널 교체 후보: ${decisions.retireChannels.map(c => c.name).join(', ') || '없음'}`,
    `- 완료 실험: ${data.closedExperiments.length}개`,
    `- 다양성: ${data.diversityReport.isHealthy ? '건강' : '경고'}`,
  ].join('\n');
  updateWeeklyInsights(data.week, insights);
  console.log('✅ weekly-insights.md 업데이트');

  // 3. strategy-log.md append
  logDecision(
    data.date,
    `주간 전략회의 완료 (${data.week})`,
    `조회수 ${growthStr}, 채널 교체 후보 ${decisions.retireChannels.length}개, 실험 ${data.closedExperiments.length}개 완료`,
  );
  console.log('✅ strategy-log.md 기록');

  // 4. agent_messages channel='weekly' 저장
  const minutes = [
    `주간 전략회의 ${data.date} (${data.week})`,
    '',
    `조회수: ${data.thisWeek.total_views.toLocaleString()}뷰 (${growthStr})`,
    `채널 교체 후보: ${decisions.retireChannels.map(c => c.name).join(', ') || '없음'}`,
    `실험 완료: ${data.closedExperiments.length}개`,
    `다양성: ${data.diversityReport.isHealthy ? '건강' : '경고'}`,
    '',
    `회의록: agents/memory/retro/retro-${data.date}.md`,
  ].join('\n');
  await sendMessage('minjun-ceo', 'team', 'weekly', minutes, { date: data.date, week: data.week });
  console.log('✅ agent_messages 저장 (channel=weekly)');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');

  console.log('📊 주간 전략회의 데이터 수집 중...\n');
  const data = await prepareRetroData();

  const growth = calcViewsGrowth(data.thisWeek.total_views, data.lastWeek.total_views);
  const growthStr = `${growth >= 0 ? '+' : ''}${growth}%`;

  console.log(`=== 주간 성과 (${data.week}) ===`);
  console.log(`총 게시: ${data.thisWeek.total_posts}개`);
  console.log(`총 조회수: ${data.thisWeek.total_views.toLocaleString()}뷰 (전주 대비 ${growthStr})`);
  console.log(`평균 조회수: ${data.thisWeek.avg_views.toLocaleString()}뷰/포스트`);
  console.log(`평균 참여율: ${data.thisWeek.avg_engagement_rate}%`);
  if (data.topPost) {
    console.log(`최고 포스트: [${data.topPost.category}] ${data.topPost.view_count.toLocaleString()}뷰`);
  }

  if (data.categoryStats.length > 0) {
    console.log('\n=== 카테고리 ROI ===');
    data.categoryStats.forEach(c => {
      console.log(`  ${c.category}: 평균 ${c.avg_views.toLocaleString()}뷰 / ${c.avg_engagement_rate}% 참여 / ROI ${c.roi_score}`);
    });
  }

  console.log(`\n=== 채널 하위 20% (${data.bottomChannels.length}개) ===`);
  data.bottomChannels.forEach(c => console.log(`  - ${c.name} (점수: ${c.score})`));

  if (data.closedExperiments.length > 0) {
    console.log(`\n=== 완료 실험 (${data.closedExperiments.length}개) ===`);
    data.closedExperiments.forEach(e => console.log(`  ${e.id}: ${e.verdict ?? '미결론'}`));
  }

  console.log(`\n=== 다양성 리포트 ===`);
  console.log(data.diversityReport.isHealthy
    ? '✅ 건강'
    : `⚠️ ${data.diversityReport.warnings.length}개 경고: ${data.diversityReport.warnings.map(w => w.warning).join(', ')}`
  );

  console.log('\n🤔 전략 결정 생성 중...');
  const decisions = generateDecisions(data);

  console.log('\n=== CEO 결정 ===');
  console.log(`채널 교체 후보: ${decisions.retireChannels.map(c => c.name).join(', ') || '없음'}`);
  const changed = decisions.categoryAdjustments.filter(a => a.action !== '유지');
  if (changed.length > 0) {
    console.log('카테고리 조정:');
    changed.forEach(a => console.log(`  ${a.category}: ${a.action} (${a.reason})`));
  }
  if (decisions.strategyNotes.length > 0) {
    decisions.strategyNotes.forEach(n => console.log(`  ${n}`));
  }

  if (dryRun) {
    console.log('\n[dry-run] 저장 및 채널 교체를 건너뜁니다.');
    process.exit(0);
  }

  console.log('\n💾 회의록 저장 중...');
  await saveRetro(data, decisions);

  if (apply) {
    if (decisions.retireChannels.length === 0) {
      console.log('\n교체할 채널이 없습니다.');
    } else {
      console.log('\n🔧 채널 교체 실행 중...');
      for (const ch of decisions.retireChannels) {
        await db.execute(sql`
          UPDATE channels
          SET benchmark_status = 'retired', retired_at = NOW()
          WHERE channel_id = ${ch.channel_id}
        `);
        console.log(`  ✅ ${ch.name} → retired`);
      }
      console.log(`${decisions.retireChannels.length}개 채널 retired 처리 완료`);
    }
  } else {
    console.log('\n💡 --apply 옵션으로 실행하면 하위 채널이 retired 처리됩니다.');
  }

  console.log('\n✅ 주간 전략회의 완료');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
