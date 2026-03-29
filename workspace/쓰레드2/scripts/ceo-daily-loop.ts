#!/usr/bin/env npx tsx
/**
 * @file ceo-daily-loop.ts — CEO(민준) 일일 자율 브리핑 루프
 *
 * 매일 아침 실행하여 CEO에게 팀 현황 브리핑을 dispatch한다.
 * CEO가 브리핑을 읽고 후속 행동(회의 소집, 태스크 배정 등)을 결정한다.
 *
 * 사용법:
 *   npx tsx scripts/ceo-daily-loop.ts              # 실제 dispatch
 *   npx tsx scripts/ceo-daily-loop.ts --dry-run    # 브리핑 내용만 출력 (dispatch 안 함)
 */
import 'dotenv/config';
import { db } from '../src/db/index.js';
import {
  threadPosts,
  dailyPerformanceReports,
  agentTasks,
  meetings,
} from '../src/db/schema.js';
import { dispatchToAgent } from '../src/orchestrator/agent-actions.js';
import { sql, desc, gte } from 'drizzle-orm';

// ─── Types ───────────────────────────────────────────────────

export interface DailyBriefingData {
  /** 최근 24h 포스트 수 */
  postsLast24h: number;
  /** 최근 성과 리포트 요약 */
  latestReport: {
    reportDate: string;
    totalPosts: number;
    totalViews: number;
    totalLikes: number;
    avgEngagementRate: number;
    topPostText: string | null;
  } | null;
  /** 미완료 agent_tasks 수 */
  pendingTaskCount: number;
  /** 최근 회의 요약 (최대 3건) */
  recentMeetings: Array<{
    agenda: string | null;
    type: string;
    createdBy: string;
    status: string;
  }>;
}

// ─── DB Queries ──────────────────────────────────────────────

/**
 * 최근 24시간 이내 수집된 포스트 수를 반환한다.
 */
export async function countRecentPosts(dbInstance = db): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await dbInstance
    .select({ count: sql<number>`count(*)::int` })
    .from(threadPosts)
    .where(gte(threadPosts.crawl_at, since));
  return row?.count ?? 0;
}

/**
 * 가장 최근 일일 성과 리포트를 반환한다.
 */
export async function getLatestReport(dbInstance = db) {
  const [row] = await dbInstance
    .select()
    .from(dailyPerformanceReports)
    .orderBy(desc(dailyPerformanceReports.report_date))
    .limit(1);

  if (!row) return null;
  const rd = row.report_date instanceof Date ? row.report_date : new Date(row.report_date);
  return {
    reportDate: isNaN(rd.getTime()) ? 'unknown' : rd.toISOString().slice(0, 10),
    totalPosts: row.total_posts,
    totalViews: row.total_views,
    totalLikes: row.total_likes,
    avgEngagementRate: row.avg_engagement_rate,
    topPostText: row.top_post_text,
  };
}

/**
 * 미완료 (pending/in_progress) 태스크 수를 반환한다.
 */
export async function countPendingTasks(dbInstance = db): Promise<number> {
  const [row] = await dbInstance
    .select({ count: sql<number>`count(*)::int` })
    .from(agentTasks)
    .where(
      sql`${agentTasks.status} IN ('pending', 'in_progress')`,
    );
  return row?.count ?? 0;
}

/**
 * 최근 회의 3건을 반환한다.
 */
export async function getRecentMeetings(dbInstance = db) {
  const rows = await dbInstance
    .select({
      agenda: meetings.agenda,
      type: meetings.meeting_type,
      createdBy: meetings.created_by,
      status: meetings.status,
    })
    .from(meetings)
    .orderBy(desc(meetings.created_at))
    .limit(3);
  return rows;
}

// ─── Briefing Builder ────────────────────────────────────────

/**
 * DB에서 현재 상태를 수집한다.
 */
export async function gatherBriefingData(dbInstance = db): Promise<DailyBriefingData> {
  const [postsLast24h, latestReport, pendingTaskCount, recentMeetings] =
    await Promise.all([
      countRecentPosts(dbInstance),
      getLatestReport(dbInstance),
      countPendingTasks(dbInstance),
      getRecentMeetings(dbInstance),
    ]);

  return { postsLast24h, latestReport, pendingTaskCount, recentMeetings };
}

/**
 * 브리핑 데이터를 CEO용 메시지로 포맷한다.
 */
export function formatBriefing(data: DailyBriefingData): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`== BiniLab 일일 브리핑 (${today}) ==`);
  lines.push('');

  // 1. 포스트 현황
  lines.push('1. 포스트 현황');
  lines.push(`   - 최근 24h 수집: ${data.postsLast24h}건`);
  if (data.latestReport) {
    lines.push(`   - 누적 포스트: ${data.latestReport.totalPosts}개`);
    lines.push(`   - 총 조회수: ${data.latestReport.totalViews.toLocaleString()}`);
    lines.push(`   - 총 좋아요: ${data.latestReport.totalLikes.toLocaleString()}`);
    lines.push(`   - 평균 참여율: ${(data.latestReport.avgEngagementRate * 100).toFixed(1)}%`);
    if (data.latestReport.topPostText) {
      const preview = data.latestReport.topPostText.slice(0, 60);
      lines.push(`   - 최고 성과 포스트: "${preview}..."`);
    }
  } else {
    lines.push('   - 성과 리포트: 아직 없음');
  }
  lines.push('');

  // 2. 미처리 태스크
  lines.push('2. 미처리 태스크');
  lines.push(`   - 대기/진행 중: ${data.pendingTaskCount}건`);
  if (data.pendingTaskCount > 5) {
    lines.push('   ⚠ 태스크 적체 — 우선순위 조정 필요');
  }
  lines.push('');

  // 3. 최근 회의
  lines.push('3. 최근 회의');
  if (data.recentMeetings.length === 0) {
    lines.push('   - 최근 회의 없음');
  } else {
    for (const m of data.recentMeetings) {
      lines.push(`   - [${m.type}] ${m.agenda ?? '(안건 없음)'} (${m.status}, by ${m.createdBy})`);
    }
  }
  lines.push('');

  // 4. CEO 판단 요청
  lines.push('== 판단 요청 ==');
  lines.push('위 현황을 검토하고 다음 행동을 결정하세요:');
  lines.push('  a. 팀 회의가 필요하면 → _create-meeting.ts 실행');
  lines.push('  b. 특정 에이전트에게 태스크 배정 → _dispatch.ts 실행');
  lines.push('  c. 특별한 이슈 없으면 → 간단한 보고만 작성');

  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────

export async function runCeoDailyLoop(options: { dryRun?: boolean } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const roomId = `ceo-daily-${today}`;

  console.log(`[ceo-daily] ${today} 일일 브리핑 생성 시작...`);

  // 1. 상태 수집
  const data = await gatherBriefingData();
  const message = formatBriefing(data);

  if (options.dryRun) {
    console.log('\n[ceo-daily] --dry-run 모드: dispatch 없이 브리핑만 출력\n');
    console.log(message);
    return { roomId, message, dispatched: false };
  }

  // 2. CEO에게 dispatch
  const msgId = await dispatchToAgent({
    sender: 'system',
    target: 'minjun-ceo',
    roomId,
    message,
    extra: { dmRoom: true, dmParticipants: ['system', 'minjun-ceo'] },
  });

  console.log(`[ceo-daily] CEO에게 브리핑 dispatch 완료 (msgId: ${msgId}, room: ${roomId})`);
  return { roomId, message, dispatched: true, msgId };
}

// ─── CLI ─────────────────────────────────────────────────────

if (process.argv[1]?.includes('ceo-daily-loop')) {
  const dryRun = process.argv.includes('--dry-run');
  runCeoDailyLoop({ dryRun })
    .then(() => process.exit(0))
    .catch(e => { console.error('[ceo-daily] 에러:', e); process.exit(1); });
}
