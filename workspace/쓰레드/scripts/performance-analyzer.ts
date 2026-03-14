#!/usr/bin/env tsx
/**
 * performance-analyzer.ts — P3-2 성과 분석기
 *
 * canonical/posts.json → 포맷별 참여도 분석 + 시간대별 패턴 + 학습 피드백 계산.
 *
 * Usage:
 *   tsx scripts/performance-analyzer.ts
 */

import type {
  CanonicalPost,
  CanonicalOutput,
  PerformanceMetrics,
  TimeSlot,
  AnalysisReport,
  LearningEntry,
} from './types.js';
import { clamp, round1, validateLearnings } from './product-matcher.js';

/**
 * 포스트 배열 → primary tag별 참여도 평균 계산.
 * null view_count는 평균에서 제외 (like/reply는 포함).
 */
export function calcEngagementStats(
  posts: CanonicalPost[],
): Record<string, PerformanceMetrics> {
  // tag별 그룹핑
  const groups = new Map<string, CanonicalPost[]>();
  for (const post of posts) {
    const tag = post.tags?.primary ?? 'general';
    const group = groups.get(tag) || [];
    group.push(post);
    groups.set(tag, group);
  }

  const result: Record<string, PerformanceMetrics> = {};

  for (const [tag, group] of groups) {
    const likesSum = group.reduce((sum, p) => sum + (p.metrics?.like_count ?? 0), 0);
    const repliesSum = group.reduce((sum, p) => sum + (p.metrics?.reply_count ?? 0), 0);

    // null 제외 views 집계
    const validViews = group
      .map(p => p.metrics?.view_count)
      .filter((v): v is number => v !== null && v !== undefined);

    const avg_views = validViews.length > 0
      ? round1(validViews.reduce((a, b) => a + b, 0) / validViews.length)
      : null;

    result[tag] = {
      avg_views,
      avg_likes: round1(likesSum / group.length),
      avg_replies: round1(repliesSum / group.length),
      post_count: group.length,
    };
  }

  return result;
}

/** ISO timestamp → KST hour 추출 */
function toKSTHour(timestamp: string): number {
  const date = new Date(timestamp);
  const utcHour = date.getUTCHours();
  return (utcHour + 9) % 24; // KST = UTC+9
}

/** KST hour → TimeSlot 분류 */
function classifyTimeSlot(kstHour: number): TimeSlot {
  if (kstHour < 6) return '새벽';
  if (kstHour < 12) return '오전';
  if (kstHour < 18) return '오후';
  return '밤';
}

/**
 * 포스트 배열 → 시간대별 참여도 패턴.
 * 4개 슬롯(새벽/오전/오후/밤) 모두 반환 (포스트 없는 슬롯은 0으로 채움).
 */
export function analyzeTimePatterns(
  posts: CanonicalPost[],
): Record<TimeSlot, PerformanceMetrics> {
  // 4개 슬롯 초기화
  const slots: TimeSlot[] = ['새벽', '오전', '오후', '밤'];
  const groups: Record<TimeSlot, CanonicalPost[]> = {
    '새벽': [], '오전': [], '오후': [], '밤': [],
  };

  for (const post of posts) {
    if (!post.timestamp) continue;
    const kstHour = toKSTHour(post.timestamp);
    const slot = classifyTimeSlot(kstHour);
    groups[slot].push(post);
  }

  const result = {} as Record<TimeSlot, PerformanceMetrics>;

  for (const slot of slots) {
    const group = groups[slot];
    if (group.length === 0) {
      result[slot] = { avg_views: null, avg_likes: 0, avg_replies: 0, post_count: 0 };
      continue;
    }

    const likesSum = group.reduce((sum, p) => sum + (p.metrics?.like_count ?? 0), 0);
    const repliesSum = group.reduce((sum, p) => sum + (p.metrics?.reply_count ?? 0), 0);
    const validViews = group
      .map(p => p.metrics?.view_count)
      .filter((v): v is number => v !== null && v !== undefined);

    result[slot] = {
      avg_views: validViews.length > 0
        ? round1(validViews.reduce((a, b) => a + b, 0) / validViews.length)
        : null,
      avg_likes: round1(likesSum / group.length),
      avg_replies: round1(repliesSum / group.length),
      post_count: group.length,
    };
  }

  return result;
}

/**
 * 특정 제품의 평균 좋아요 vs 전체 평균 비교 → LearningEntry 델타 계산.
 * 전체 평균보다 2배 이상 높으면 +1, 1.5배 이상이면 +0.5
 * 전체 평균의 절반 이하면 -1, 70% 이하면 -0.5
 */
export function calcLearningDeltas(
  productId: string,
  productAvgLikes: number,
  overallAvgLikes: number,
): LearningEntry {
  if (overallAvgLikes === 0) {
    return { product_id: productId };
  }

  const ratio = productAvgLikes / overallAvgLikes;

  let delta = 0;
  if (ratio >= 2.0) delta = 1;
  else if (ratio >= 1.5) delta = 0.5;
  else if (ratio <= 0.5) delta = -1;
  else if (ratio <= 0.7) delta = -0.5;

  if (delta === 0) return { product_id: productId };

  // delta 클리핑 [-2, 2]
  const clampedDelta = clamp(delta, -2, 2);

  return {
    product_id: productId,
    naturalness_delta: clampedDelta || undefined,
    story_potential_delta: clampedDelta || undefined,
  };
}

// --- Main ---

import fs from 'fs';
import path from 'path';

const CANONICAL_PATH = path.join(__dirname, '..', 'data', 'canonical', 'posts.json');
const BRIEFS_DIR = path.join(__dirname, '..', 'data', 'briefs');
const LEARNINGS_PATH = path.join(__dirname, '..', 'data', 'learnings', 'latest.json');

function main(): void {
  const today = new Date().toISOString().slice(0, 10);

  // canonical/posts.json 로드
  let canonicalData: CanonicalOutput;
  try {
    canonicalData = JSON.parse(fs.readFileSync(CANONICAL_PATH, 'utf8'));
  } catch {
    console.error(`Canonical posts not found: ${CANONICAL_PATH}`);
    console.error(`Run normalize-posts.ts first.`);
    process.exit(1);
  }

  const posts = canonicalData.posts;
  console.log(`Analyzing ${posts.length} posts...`);

  // 포맷별 참여도
  const formatPerf = calcEngagementStats(posts);

  // 시간대별 패턴
  const timePerf = analyzeTimePatterns(posts);

  // 상위 성과 포스트 (like_count 기준 top 10)
  const topPosts = [...posts]
    .filter(p => p.metrics)
    .sort((a, b) => (b.metrics?.like_count ?? 0) - (a.metrics?.like_count ?? 0))
    .slice(0, 10)
    .map(p => ({
      post_id: p.post_id,
      channel_id: p.channel_id,
      views: p.metrics?.view_count ?? null,
      likes: p.metrics?.like_count ?? 0,
      tag: p.tags?.primary ?? 'general',
    }));

  // 전체 평균 좋아요
  const allLikes = posts
    .filter(p => p.metrics)
    .map(p => p.metrics!.like_count);
  const overallAvgLikes = allLikes.length > 0
    ? allLikes.reduce((a, b) => a + b, 0) / allLikes.length
    : 0;

  // 채널별 학습 델타 계산 (product_id 역추적 불가 → channel 기반)
  const channelGroups = new Map<string, CanonicalPost[]>();
  for (const post of posts) {
    const ch = post.channel_id;
    const group = channelGroups.get(ch) || [];
    group.push(post);
    channelGroups.set(ch, group);
  }

  const learningDeltas: LearningEntry[] = [];
  for (const [channelId, chPosts] of channelGroups) {
    const avgLikes = chPosts.reduce((sum, p) => sum + (p.metrics?.like_count ?? 0), 0) / chPosts.length;
    const delta = calcLearningDeltas(channelId, avgLikes, overallAvgLikes);
    if (delta.naturalness_delta !== undefined || delta.story_potential_delta !== undefined) {
      learningDeltas.push(delta);
    }
  }

  // 날짜 범위 계산
  const timestamps = posts.map(p => p.timestamp).filter(Boolean).sort();
  const dateRange = {
    from: timestamps[0]?.slice(0, 10) ?? today,
    to: timestamps[timestamps.length - 1]?.slice(0, 10) ?? today,
  };

  const report: AnalysisReport = {
    date: today,
    format_performance: formatPerf,
    time_performance: timePerf,
    top_performing_posts: topPosts,
    learning_deltas: learningDeltas,
    meta: {
      posts_analyzed: posts.length,
      date_range: dateRange,
      generated_at: new Date().toISOString(),
    },
  };

  // analysis_report.json atomic write
  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const reportPath = path.join(BRIEFS_DIR, `${today}_analysis_report.json`);
  const tmpReport = reportPath + '.tmp';
  fs.writeFileSync(tmpReport, JSON.stringify(report, null, 2), 'utf8');
  fs.renameSync(tmpReport, reportPath);

  // learnings/latest.json 병합
  let existingLearnings: LearningEntry[] = [];
  try {
    const existing = JSON.parse(fs.readFileSync(LEARNINGS_PATH, 'utf8'));
    existingLearnings = validateLearnings(existing.learnings || existing);
  } catch {
    console.warn(`Existing learnings not found, creating new: ${LEARNINGS_PATH}`);
  }

  // 병합: 같은 product_id면 delta 누적 (clamp)
  const learningsMap = new Map<string, LearningEntry>();
  for (const entry of existingLearnings) {
    learningsMap.set(entry.product_id, entry);
  }
  for (const delta of learningDeltas) {
    const existing = learningsMap.get(delta.product_id);
    if (existing) {
      // delta 누적 + clamp
      const merged: LearningEntry = {
        product_id: delta.product_id,
        naturalness_delta: clamp(
          (existing.naturalness_delta ?? 0) + (delta.naturalness_delta ?? 0), -2, 2
        ) || undefined,
        story_potential_delta: clamp(
          (existing.story_potential_delta ?? 0) + (delta.story_potential_delta ?? 0), -2, 2
        ) || undefined,
      };
      learningsMap.set(delta.product_id, merged);
    } else {
      learningsMap.set(delta.product_id, delta);
    }
  }

  const updatedLearnings = {
    version: '1.0',
    updated_at: today,
    learnings: Array.from(learningsMap.values()),
  };

  fs.mkdirSync(path.dirname(LEARNINGS_PATH), { recursive: true });
  const tmpLearnings = LEARNINGS_PATH + '.tmp';
  fs.writeFileSync(tmpLearnings, JSON.stringify(updatedLearnings, null, 2), 'utf8');
  fs.renameSync(tmpLearnings, LEARNINGS_PATH);

  // 요약 출력
  console.log(`\nAnalysis report: ${reportPath}`);
  console.log(`Learnings updated: ${LEARNINGS_PATH}`);
  console.log(`\n--- 성과 분석 요약 ---`);
  for (const [tag, metrics] of Object.entries(formatPerf)) {
    console.log(`  [${tag}] 평균 좋아요: ${metrics.avg_likes}, 포스트: ${metrics.post_count}개`);
  }
  console.log(`\n--- 시간대별 ---`);
  for (const [slot, metrics] of Object.entries(timePerf)) {
    console.log(`  [${slot}] 평균 좋아요: ${metrics.avg_likes}, 포스트: ${metrics.post_count}개`);
  }
  console.log(`\n학습 델타: ${learningDeltas.length}개`);
}

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('performance-analyzer.ts') ||
  process.argv[1].endsWith('performance-analyzer.js')
);
if (isMainModule) main();
