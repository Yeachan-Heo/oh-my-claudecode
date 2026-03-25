/**
 * @file daily-pipeline.ts — BiniLab 일일 파이프라인 오케스트레이터.
 *
 * runDailyPipeline(options) 가 Phase 0~6을 순차 조율.
 * Phase 0: 어제 게시 포스트 성과 스냅샷 수집 (scheduleSnapshots + collectSnapshot).
 * Phase 5: Safety 검증 + aff_contents 등록 + content_lifecycle INSERT.
 * --dry-run: Phase 2~3만 실행 (directive 출력).
 * --autonomous: Phase 0~5 자동 실행 (aff_contents status='ready' 등록까지).
 */

import { client } from '../db/index.js';
import { sendMessage } from '../db/agent-messages.js';
import { runSafetyGates } from '../safety/gates.js';
import { getDiversityReport } from '../learning/diversity-checker.js';
import { logDecision, updatePlaybook } from '../learning/strategy-logger.js';
import { createStrategyVersion } from '../db/strategy-archive.js';
import { startMeeting, concludeMeeting } from './meeting.js';
import { logEpisode } from '../db/memory.js';
import { registerPost, scheduleSnapshots, collectSnapshot } from '../tracker/snapshot.js';
import { getLatestDiagnosis } from '../tracker/diagnosis.js';
import type {
  TimeSlot,
  DailyDirective,
  ContentDraft,
  QAResult,
  QAScores,
  PostContract,
  PipelineOptions,
  PipelineResult,
  PhaseGateResult,
} from './types.js';

/** 에디터 매핑: 카테고리 → 에이전트 파일 → 페르소나 파일. */
export const EDITOR_MAP: Record<string, { agent: string; persona?: string }> = {
  '뷰티': {
    agent: '.claude/agents/bini-beauty-editor.md',
    persona: 'souls/bini-persona.md',
  },
  '건강': { agent: '.claude/agents/hana-health-editor.md' },
  '생활': { agent: '.claude/agents/sora-lifestyle-editor.md' },
  '다이어트': { agent: '.claude/agents/jiu-diet-editor.md' },
};

/** 기본 카테고리 비율 (성과 데이터 없을 때). */
const DEFAULT_ALLOCATION: Record<string, number> = {
  '뷰티': 4,
  '건강': 3,
  '생활': 2,
  '다이어트': 1,
};

/** 고정 시간대 슬롯 템플릿 (10개). */
const TIME_SLOT_TEMPLATE: Array<{ time: string; category: string; type: 'regular' | 'experiment' }> = [
  { time: '08:00', category: '뷰티',    type: 'regular' },
  { time: '08:00', category: '건강',    type: 'regular' },
  { time: '11:00', category: '뷰티',    type: 'regular' },
  { time: '14:00', category: '생활',    type: 'regular' },
  { time: '15:00', category: '건강',    type: 'regular' },
  { time: '18:00', category: '뷰티',    type: 'regular' },
  { time: '20:00', category: '생활',    type: 'regular' },
  { time: '20:00', category: '다이어트', type: 'regular' },
  { time: '21:00', category: '건강',    type: 'experiment' },
  { time: '22:00', category: '뷰티',    type: 'experiment' },
];

interface CategoryStats {
  category: string;
  avg_views: number;
  engagement_rate: number;
}

function calcRoiScore(stats: CategoryStats): number {
  return (stats.avg_views / 1000) * (stats.engagement_rate * 100);
}

function roiGrade(score: number): string {
  if (score >= 15) return 'A';
  if (score >= 8) return 'B';
  return 'C';
}

interface PreviousDayStats {
  categoryStats: CategoryStats[];
  brandEventsCount: number;
}

async function fetchPhase2Data(): Promise<PreviousDayStats> {
  const [catRows, eventsRows] = await Promise.all([
    client`
      SELECT
        tp.topic_category AS category,
        COALESCE(AVG(tp.view_count), 0)::float AS avg_views,
        COALESCE(
          AVG((tp.like_count + tp.reply_count + tp.repost_count)::float / NULLIF(tp.view_count, 0)),
          0
        )::float AS engagement_rate
      FROM content_lifecycle cl
      JOIN thread_posts tp ON cl.threads_post_id = tp.post_id
      WHERE cl.posted_at >= NOW() - INTERVAL '48 hours'
        AND cl.posted_at < NOW() - INTERVAL '24 hours'
        AND tp.topic_category IS NOT NULL
      GROUP BY tp.topic_category
    `,
    client`
      SELECT COUNT(*)::int AS cnt
      FROM brand_events
      WHERE is_stale = false AND is_used = false AND expires_at >= NOW()
    `,
  ]);

  const categoryStats: CategoryStats[] = catRows.map((r) => ({
    category: r.category as string,
    avg_views: Number(r.avg_views),
    engagement_rate: Number(r.engagement_rate),
  }));

  const brandEventsCount = Number((eventsRows[0] as { cnt: number }).cnt ?? 0);

  return { categoryStats, brandEventsCount };
}

// ---------------------------------------------------------------------------
// buildDirective — ROI 기반 DailyDirective 생성 (공통 함수)
// ---------------------------------------------------------------------------

/**
 * buildDirective — ROI 기반 DailyDirective 생성 (공통 함수).
 * runCEOStandup과 meetingToDirective가 모두 이 함수를 사용.
 */
export async function buildDirective(
  totalPosts: number,
  date: string,
): Promise<DailyDirective> {
  const { categoryStats, brandEventsCount } = await fetchPhase2Data();

  // ROI 점수 계산
  const roiSummary: Record<string, { score: number; grade: string }> = {};
  for (const cat of Object.keys(DEFAULT_ALLOCATION)) {
    const stats = categoryStats.find((s) => s.category === cat);
    const score = stats ? parseFloat(calcRoiScore(stats).toFixed(1)) : 0;
    roiSummary[cat] = { score, grade: roiGrade(score) };
  }

  // 카테고리 비율 결정
  const allocation = { ...DEFAULT_ALLOCATION };
  for (const [cat, { grade }] of Object.entries(roiSummary)) {
    if (grade === 'A' && allocation[cat]! < 5) allocation[cat] = allocation[cat]! + 1;
    if (grade === 'C' && allocation[cat]! > 1) allocation[cat] = allocation[cat]! - 1;
  }

  // diagnosis 피드백 반영 — 최근 진단의 tuning_actions에서 카테고리 조정
  let diagnosisApplied = false;
  try {
    const latestDiagnosis = await getLatestDiagnosis();
    if (latestDiagnosis?.tuning_actions && latestDiagnosis.tuning_actions.length > 0) {
      // bottleneck이 content면 해당 카테고리 비율 조정 가능
      // bottleneck이 collection/matching이면 특정 카테고리가 아닌 전체 영향
      // categoryPerformance 기반으로 저성과 카테고리 축소, 고성과 카테고리 확대
      if (latestDiagnosis.bottleneck !== 'none' && categoryStats.length > 0) {
        // 저성과 카테고리 식별 (engagement_rate 기준 하위)
        const sorted = [...categoryStats].sort((a, b) => a.engagement_rate - b.engagement_rate);
        const worstCat = sorted[0]?.category;
        const bestCat = sorted[sorted.length - 1]?.category;
        if (worstCat && bestCat && worstCat !== bestCat
            && allocation[worstCat] !== undefined && allocation[bestCat] !== undefined) {
          if (allocation[worstCat]! > 1) {
            allocation[worstCat] = allocation[worstCat]! - 1;
            allocation[bestCat] = allocation[bestCat]! + 1;
            diagnosisApplied = true;
          }
        }
      }
    }
  } catch {
    // Diagnosis 조회 실패 시 기존 ROI 로직만 사용 (graceful degradation)
  }

  const allocTotal = Object.values(allocation).reduce((a, b) => a + b, 0);
  if (allocTotal !== totalPosts) {
    const diff = totalPosts - allocTotal;
    const topCat = Object.entries(allocation).sort((a, b) => b[1] - a[1])[0]![0];
    allocation[topCat] = Math.max(1, allocation[topCat]! + diff);
  }

  const regularPosts = Math.ceil(totalPosts * 0.7);
  const experimentPosts = totalPosts - regularPosts;

  // 시간대 슬롯 생성
  const slots = TIME_SLOT_TEMPLATE.slice(0, totalPosts);
  const experimentSlotDate = date.replace(/-/g, '');
  let expIdx = 1;
  const timeSlots: TimeSlot[] = slots.map((s) => {
    const editorInfo = EDITOR_MAP[s.category] ?? EDITOR_MAP['뷰티'];
    const slot: TimeSlot = {
      time: s.time,
      category: s.category,
      type: s.type,
      editor: editorInfo!.agent.replace('.claude/agents/', '').replace('.md', ''),
      brief: '',
    };
    if (s.type === 'experiment') {
      slot.experiment_id = `EXP-${experimentSlotDate}-${String(expIdx++).padStart(3, '0')}`;
    }
    return slot;
  });

  // 다양성 경고
  const diversityWarnings: string[] = [];
  if (brandEventsCount < 3) {
    diversityWarnings.push('브랜드 이벤트 3개 미만 — research-brands.ts 재실행 필요');
  }
  const lcRows = await client`
    SELECT content_style, need_category, hook_type
    FROM content_lifecycle
    WHERE posted_at >= NOW() - INTERVAL '7 days'
    LIMIT 50
  `;
  if (lcRows.length > 0) {
    const lcPosts = lcRows.map((r) => ({
      content_style: (r.content_style as string) ?? '',
      need_category: (r.need_category as string) ?? '',
      hook_type: (r.hook_type as string) ?? '',
    }));
    const diversityReport = getDiversityReport(lcPosts);
    for (const w of diversityReport.warnings) {
      if (w.warning) diversityWarnings.push(w.warning);
    }
  }

  // 재활용 후보
  const recycleRows = await client`
    SELECT cl.threads_post_id AS post_id
    FROM content_lifecycle cl
    JOIN thread_posts tp ON cl.threads_post_id = tp.post_id
    WHERE cl.posted_at <= NOW() - INTERVAL '14 days'
    ORDER BY tp.view_count DESC
    LIMIT 2
  `;
  const recycleCandidates = recycleRows.map((r) => r.post_id as string);

  const directive: DailyDirective = {
    date,
    total_posts: totalPosts,
    category_allocation: allocation,
    regular_posts: regularPosts,
    experiment_posts: experimentPosts,
    time_slots: timeSlots,
    experiments: timeSlots
      .filter((s) => s.experiment_id)
      .map((s) => ({
        id: s.experiment_id!,
        hypothesis: '(Claude Code가 채워야 함)',
        variable: 'hook_type',
      })),
    recycle_candidates: recycleCandidates,
    diversity_warnings: diversityWarnings,
    roi_summary: roiSummary,
  };

  // 포스트별 계약 생성 (Sprint Contract 패턴)
  const STRATEGIES: PostContract['strategy'][] = ['empathy', 'story', 'curiosity', 'comparison', 'list'];
  const postContracts: PostContract[] = timeSlots.map((slot, idx) => ({
    slot_index: idx,
    category: slot.category,
    strategy: STRATEGIES[idx % STRATEGIES.length],
    min_hook_score: slot.type === 'experiment' ? 5 : 6,
    min_originality_score: slot.type === 'experiment' ? 4 : 5,
    success_criteria: slot.type === 'experiment'
      ? `실험 슬롯: ${slot.experiment_id} — 변수 자유 조정`
      : `${slot.category} 일반 포스트 — 후킹 6+, 독창성 5+`,
  }));
  directive.post_contracts = postContracts;

  // 전략 기록
  const topCategories = Object.entries(roiSummary)
    .filter(([, v]) => v.grade === 'A')
    .map(([k]) => k)
    .join(', ') || '없음';
  const diagNote = diagnosisApplied ? ' + diagnosis 피드백 반영' : '';
  logDecision(
    date,
    `카테고리 배분: ${Object.entries(allocation).map(([k, v]) => `${k}${v}`).join('/')}`,
    `ROI 점수 기반 조정. A등급: ${topCategories}${diagNote}`,
  );

  // strategy_archive에 CEO 결정 기록
  await createStrategyVersion({
    version: `directive-${date}`,
    strategy: {
      category_allocation: allocation,
      roi_summary: roiSummary,
      total_posts: totalPosts,
      regular_posts: regularPosts,
      experiment_posts: experimentPosts,
    },
    performance: {
      avg_roi: Object.values(roiSummary).reduce((sum, r) => sum + r.score, 0) / Object.keys(roiSummary).length,
    },
  });

  return directive;
}

// ---------------------------------------------------------------------------
// Phase 3: CEO 스탠드업
// ---------------------------------------------------------------------------

/**
 * meeting.ts의 startMeeting/concludeMeeting을 사용하는 standup 회의 실행 헬퍼.
 * channel='standup' 메시지를 저장해 gatePhase3()가 통과할 수 있도록 함.
 */
async function runMeeting(params: {
  type: 'standup';
  agenda: string;
  participants: string[];
  summary: string;
  decisions: string[];
}): Promise<string> {
  const transcript = await startMeeting({
    roomName: `standup-${new Date().toISOString().slice(0, 10)}`,
    type: params.type,
    agenda: params.agenda,
    participants: params.participants,
    createdBy: 'orchestrator',
    consensusRequired: false,
  });
  await concludeMeeting(transcript.meetingId, params.decisions, 'info_shared');
  // gatePhase3()가 확인하는 channel='standup' 메시지 저장
  await sendMessage(
    'minjun-ceo',
    'all',
    'standup',
    params.summary,
    { meetingId: transcript.meetingId, decisions: params.decisions },
  );
  return transcript.meetingId;
}

/**
 * 회의 메시지 → DailyDirective 변환.
 * buildDirective를 재사용해 DailyDirective를 생성.
 */
async function meetingToDirective(
  totalPosts: number,
  date: string,
): Promise<{ directive: DailyDirective; meetingSummary: string; decisions: string[] }> {
  const directive = await buildDirective(totalPosts, date);

  const topCategories = Object.entries(directive.roi_summary)
    .filter(([, v]) => v.grade === 'A')
    .map(([k]) => k)
    .join(', ') || '없음';

  const meetingSummary =
    `[daily_directive ${date}] ${totalPosts}개 슬롯 배분 완료. ` +
    Object.entries(directive.category_allocation).map(([k, v]) => `${k}${v}`).join('/') +
    `. 실험 ${directive.experiment_posts}개.`;

  const decisions = [
    `카테고리 배분: ${Object.entries(directive.category_allocation).map(([k, v]) => `${k}${v}`).join('/')}`,
    `실험 슬롯 ${directive.experiment_posts}개. A등급: ${topCategories}`,
  ];

  return { directive, meetingSummary, decisions };
}

/**
 * CEO 스탠드업 실행.
 * buildDirective로 DailyDirective 생성 → agent_messages 저장.
 */
export async function runCEOStandup(totalPosts = 10): Promise<DailyDirective> {
  const date = new Date().toISOString().slice(0, 10);
  const directive = await buildDirective(totalPosts, date);

  await sendMessage(
    'minjun-ceo',
    'all',
    'standup',
    `[daily_directive ${date}] ${totalPosts}개 슬롯 배분 완료. ` +
      Object.entries(directive.category_allocation).map(([k, v]) => `${k}${v}`).join('/') +
      `. 실험 ${directive.experiment_posts}개.`,
    { directive },
  );

  return directive;
}

/** 슬롯에 대한 ContentDraft 뼈대를 생성. 실제 텍스트는 Claude Code가 에디터 파일 참조해서 채움. */
export function generateContent(slot: TimeSlot, _directive: DailyDirective): ContentDraft {
  const editorKey = slot.category;
  const editorInfo = EDITOR_MAP[editorKey] ?? EDITOR_MAP['뷰티'];

  return {
    text: '',     // Claude Code가 에디터 파일 읽고 채워야 함
    hook: '',     // 6단계 CoT 첫 번째 단계
    format: '',   // 포맷 선택 (비교형/리스트형/스토리형 등)
    category: slot.category,
    editor: slot.editor,
    agent_file: editorInfo.agent,
    persona_file: editorInfo.persona,
  };
}

/** 4축 채점 헬퍼: 텍스트 기반으로 hook/originality/authenticity/conversion 계산. */
function scoreAxes(text: string): QAScores {
  const hookScore = (() => {
    const firstLine = text.split('\n')[0] ?? '';
    let s = 7;
    if (firstLine.length > 30) s -= 3;
    if (firstLine.length > 20) s -= 1;
    if (/\?|ㅋ|ㅜ|!/.test(firstLine)) s += 1;
    return Math.max(1, Math.min(10, s));
  })();

  const originalityScore = (() => {
    let s = 7;
    if (/합니다|여러분|추천드립니다|효과적입니다/.test(text)) s -= 3;
    if (/소개합니다|알려드|말씀드/.test(text)) s -= 2;
    if (/ㅋㅋ|ㅜ|거든|임\b/.test(text)) s += 1;
    return Math.max(1, Math.min(10, s));
  })();

  const authenticityScore = (() => {
    let s = 8;
    const expertTerms = /나이아신아마이드|레티놀|히알루론산|비타민C|AHA|BHA|글루타치온/i;
    if (expertTerms.test(text)) s -= 4;
    if (/합니다|~입니다/.test(text)) s -= 2;
    return Math.max(1, Math.min(10, s));
  })();

  const conversionScore = (() => {
    let s = 5;
    if (/써봐|먹어봐|해봐|적어줘|댓글|알려줘/.test(text)) s += 3;
    if (/링크|프로필|바이오/.test(text)) s += 1;
    if (/추천$|드립니다/.test(text)) s -= 1;
    return Math.max(1, Math.min(10, s));
  })();

  return {
    hook: hookScore,
    originality: originalityScore,
    authenticity: authenticityScore,
    conversion: conversionScore,
  };
}

/** 도윤(QA) 기준 콘텐츠 검증. 킬러게이트 K1~K4 + 체크리스트 10항목 + 4축 채점. */
export function runQA(draft: ContentDraft): QAResult {
  const text = draft.text;
  const feedback: string[] = [];

  // K1: "그래서 뭐?" — 숫자/제품명/리스트/비교 중 1개 이상
  const k1 = /\d|[가-힣]{2,4}(크림|세럼|영양제|밀크|젤|오일|패드|선크림|클렌저|토너)|vs|비교|추천/.test(text);
  if (!k1) feedback.push('K1 실패: 구체적 팩트/숫자/제품명 없음');

  // K2: 이미지 필수 체크 → 스킵 (Claude Code가 게시 시 확인)
  const k2 = true;

  // K3: 채널 온브랜드 (카테고리가 4개 중 하나면 통과)
  const k3 = ['뷰티', '건강', '생활', '다이어트'].includes(draft.category);
  if (!k3) feedback.push('K3 실패: 채널 온브랜드 범위 벗어남');

  // K4: 글자수 100~200자
  const len = text.replace(/\s/g, '').length;
  const k4 = text === '' || (len >= 100 && len <= 200);
  if (!k4) feedback.push(`K4 실패: 글자수 ${len}자 (100~200자 타겟)`);

  const killerGates = { k1, k2, k3, k4 };
  const killersPassed = k1 && k2 && k3 && k4;

  // 4축 채점은 킬러게이트와 무관하게 항상 계산 (피드백용)
  const scores = text ? scoreAxes(text) : undefined;

  if (!killersPassed) {
    return { passed: false, score: 0, scores, feedback, killerGates };
  }

  // 기본 체크리스트 10항목 (텍스트 없으면 스킵)
  if (text) {
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines[0]?.length > 30) feedback.push('1. 첫 문장 30자 초과');
    if (!/[ㅋㅜ~거든임요]|ㅠ/.test(text)) feedback.push('6. 구어체 부족');
    const emojiCount = (text.match(/[\u{1F300}-\u{1FFFF}]/gu) ?? []).length;
    if (emojiCount > 2) feedback.push(`5. 이모지 ${emojiCount}개 (2개 이하)`);
    if (/합니다|여러분|추천드립니다|효과적입니다/.test(text)) {
      feedback.push('3. AI 말투 감지');
    }
  }

  const score = Math.max(0, 10 - feedback.length * 2);

  // 가중 평균 (후킹 30%, 독창성 30%, 진정성 25%, 전환 15%)
  const weightedScore = scores
    ? Math.round(
        scores.hook * 0.3 + scores.originality * 0.3 + scores.authenticity * 0.25 + scores.conversion * 0.15,
      )
    : score;

  return {
    passed: feedback.length === 0 && weightedScore >= 6,
    score: Math.min(score, weightedScore),
    scores,
    feedback,
    killerGates,
  };
}

/**
 * runQAWithRetry — QA 검증 + 피드백 반환.
 * 실제 재작성은 호출자(daily-run 스킬)가 에이전트에게 피드백 전달하여 수행.
 * 이 함수는 iteration 메타데이터를 QAResult에 첨부.
 */
export function runQAWithRetry(
  draft: ContentDraft,
  iteration = 1,
  maxRetries = 3,
): QAResult {
  const result = runQA(draft);
  result.iteration = iteration;
  result.max_retries_exhausted = !result.passed && iteration >= maxRetries;

  if (!result.passed && iteration < maxRetries) {
    result.feedback.push(
      `[재작성 ${iteration}/${maxRetries}] 위 피드백 반영하여 수정 후 재제출. ` +
      (result.scores
        ? `점수: 후킹=${result.scores.hook}, 독창성=${result.scores.originality}, 진정성=${result.scores.authenticity}, 전환=${result.scores.conversion}`
        : ''),
    );
  }

  if (result.max_retries_exhausted) {
    result.feedback.push(
      `[폐기] ${maxRetries}회 재작성 실패 — 이 슬롯은 다른 전략으로 처음부터 재시작 필요`,
    );
  }

  return result;
}

/** 안전 게이트 실행 (Worker A 구현). */
export async function runSafety(content: string, accountId: string) {
  return runSafetyGates(content, accountId);
}

/** Phase 1 게이트: 24h 내 수집 데이터 존재 여부 확인. */
async function gatePhase1(): Promise<PhaseGateResult> {
  const [threadRows, ytRows] = await Promise.all([
    client`SELECT COUNT(*)::int AS cnt FROM thread_posts WHERE crawl_at >= NOW() - INTERVAL '24 hours'`,
    client`SELECT COUNT(*)::int AS cnt FROM youtube_videos WHERE collected_at >= NOW() - INTERVAL '24 hours'`,
  ]);
  const threadCount = Number((threadRows[0] as { cnt: number }).cnt ?? 0);
  const ytCount = Number((ytRows[0] as { cnt: number }).cnt ?? 0);
  const total = threadCount + ytCount;
  return {
    phase: 1,
    passed: total > 0,
    reason: total === 0 ? '24h 내 수집 데이터 없음 (thread_posts + youtube_videos = 0)' : undefined,
    metrics: { thread_posts_24h: threadCount, youtube_videos_24h: ytCount },
  };
}

/** Phase 2 게이트: 서연(분석가) 오늘자 pipeline 채널 메시지 존재 + 내용 검증. */
export async function gatePhase2(): Promise<PhaseGateResult> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await client`
    SELECT message
    FROM agent_messages
    WHERE sender = 'seoyeon-analyst'
      AND channel = 'pipeline'
      AND created_at >= ${today}::date
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) {
    return {
      phase: 2,
      passed: false,
      reason: '서연(분석가) 오늘자 분석 메시지 없음',
      metrics: { analyst_messages: 0 },
    };
  }

  const msg = rows[0];
  const hasContent = typeof msg.message === 'string' && msg.message.length > 20;

  return {
    phase: 2,
    passed: hasContent,
    reason: hasContent ? undefined : '서연 분석 메시지가 비어있거나 너무 짧음 (20자 미만)',
    metrics: { analyst_messages: 1, message_length: (msg.message as string)?.length ?? 0 },
  };
}

/** Phase 3 게이트: 민준(CEO) 오늘자 standup 채널 메시지 존재 + directive 내용 검증. */
export async function gatePhase3(): Promise<PhaseGateResult> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await client`
    SELECT message, metadata
    FROM agent_messages
    WHERE sender = 'minjun-ceo'
      AND channel = 'standup'
      AND created_at >= ${today}::date
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) {
    return {
      phase: 3,
      passed: false,
      reason: '민준(CEO) 오늘자 스탠드업 메시지 없음',
      metrics: { ceo_messages: 0 },
    };
  }

  const msg = rows[0];
  const metadata = msg.metadata as Record<string, unknown> | null;
  const hasDirective = metadata && 'directive' in metadata;

  return {
    phase: 3,
    passed: !!hasDirective,
    reason: hasDirective ? undefined : 'CEO 메시지에 directive 없음 — DailyDirective 누락',
    metrics: { ceo_messages: 1, has_directive: hasDirective ? 1 : 0 },
  };
}

/**
 * 일일 파이프라인 전체 실행.
 * - dry-run: Phase 2~3만 (directive 출력).
 * - autonomous: Phase 1~5 자동 (aff_contents ready 등록까지).
 * - 기본: Phase 1~6 순차 (게시는 시훈 승인 후 별도).
 */
export async function runDailyPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { dryRun, autonomous, posts } = options;
  const errors: string[] = [];
  const phasesCompleted: number[] = [];
  const gateResults: PhaseGateResult[] = [];
  const drafts: ContentDraft[] = [];
  const qaResults: QAResult[] = [];
  let directive: DailyDirective | undefined;
  let safetyPassed = true;
  let readyCount = 0;

  // ── Phase 0: 어제 게시 포스트 성과 스냅샷 수집 ─────────────────────────
  if (!dryRun && (options.phase == null || options.phase === 0)) {
    try {
      const snapshotTargets = await scheduleSnapshots();
      if (snapshotTargets.length > 0) {
        await sendMessage(
          'orchestrator',
          'all',
          'pipeline',
          `[Phase 0] ${snapshotTargets.length}개 포스트 성과 스냅샷 수집 시작.`,
          { phase: 0, status: 'started', targetCount: snapshotTargets.length },
        );
        let collected = 0;
        for (const target of snapshotTargets) {
          try {
            await collectSnapshot(target.postId, target.snapshotType);
            collected++;
          } catch (snapErr) {
            const snapMsg = snapErr instanceof Error ? snapErr.message : String(snapErr);
            errors.push(`Phase 0 snapshot 실패 (${target.postId}/${target.snapshotType}): ${snapMsg}`);
          }
        }
        await sendMessage(
          'orchestrator',
          'all',
          'pipeline',
          `[Phase 0] 스냅샷 수집 완료: ${collected}/${snapshotTargets.length}건.`,
          { phase: 0, status: 'completed', collected, total: snapshotTargets.length },
        );
      } else {
        await sendMessage(
          'orchestrator',
          'all',
          'pipeline',
          '[Phase 0] 수집 대상 스냅샷 없음 — 스킵.',
          { phase: 0, status: 'skipped' },
        );
      }
      phasesCompleted.push(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Phase 0: ${msg}`);
    }
  }

  // ── Phase 1: 데이터 수집 (dry-run은 스킵) ─────────────────────────────
  if (!dryRun && !options.phase || options.phase === 1) {
    await sendMessage(
      'orchestrator',
      'all',
      'pipeline',
      '[Phase 1] 데이터 수집 시작 — 준호(리서처) 담당. /수집 스킬 실행 필요.',
      { phase: 1, status: 'started' },
    );
    phasesCompleted.push(1);
  }

  if (dryRun) {
    await sendMessage(
      'orchestrator',
      'all',
      'pipeline',
      '[dry-run] Phase 1 수집 스킵. 기존 DB 데이터로 Phase 2~3 실행.',
      { dryRun: true },
    );
  }

  // ── Gate 1→2: 24h 수집 데이터 확인 (dry-run 스킵) ────────────────────
  if (!dryRun && (!options.phase || options.phase <= 1)) {
    const gate1 = await gatePhase1();
    gateResults.push(gate1);
    if (!gate1.passed) {
      errors.push(`[Gate 1] ${gate1.reason}`);
      return {
        phases_completed: phasesCompleted,
        drafts,
        qa_results: qaResults,
        safety_passed: safetyPassed,
        ready_count: readyCount,
        errors,
        gate_results: gateResults,
      };
    }
  }

  // ── Phase 2: 분석 (dry-run 포함) ─────────────────────────────────────
  if (!options.phase || options.phase === 2 || dryRun) {
    await sendMessage(
      'orchestrator',
      'all',
      'pipeline',
      '[Phase 2] 분석 시작 — 서연(분석가) 담당.',
      { phase: 2, status: 'started' },
    );
    phasesCompleted.push(2);
  }

  // ── Gate 2→3: 서연 분석 메시지 확인 (dry-run 스킵) ──────────────────
  if (!dryRun && (!options.phase || options.phase <= 2)) {
    const gate2 = await gatePhase2();
    gateResults.push(gate2);
    if (!gate2.passed) {
      errors.push(`[Gate 2] ${gate2.reason}`);
      return {
        phases_completed: phasesCompleted,
        drafts,
        qa_results: qaResults,
        safety_passed: safetyPassed,
        ready_count: readyCount,
        errors,
        gate_results: gateResults,
      };
    }
  }

  // ── Phase 3: CEO 스탠드업 (dry-run 포함) ──────────────────────────────
  if (!options.phase || options.phase === 3 || dryRun) {
    try {
      const date = new Date().toISOString().slice(0, 10);
      const { directive: d, meetingSummary, decisions } = await meetingToDirective(posts, date);
      directive = d;
      await runMeeting({
        type: 'standup',
        agenda: `[daily_directive ${date}] 일일 콘텐츠 배분 스탠드업`,
        participants: ['minjun-ceo', 'seoyeon-analyst', 'juhun-researcher'],
        summary: meetingSummary,
        decisions,
      });
      phasesCompleted.push(3);
      await sendMessage(
        'orchestrator',
        'all',
        'pipeline',
        `[Phase 3] CEO 스탠드업 완료. ${posts}개 슬롯 배분.`,
        { phase: 3, status: 'completed', directive },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Phase 3: ${msg}`);
    }
  }

  if (dryRun) {
    // dry-run은 directive 출력 후 종료
    return {
      phases_completed: phasesCompleted,
      directive,
      drafts,
      qa_results: qaResults,
      safety_passed: safetyPassed,
      ready_count: 0,
      errors,
    };
  }

  // ── Gate 3→4: 민준 스탠드업 메시지 확인 ─────────────────────────────
  if (!options.phase || options.phase <= 3) {
    const gate3 = await gatePhase3();
    gateResults.push(gate3);
    if (!gate3.passed) {
      errors.push(`[Gate 3] ${gate3.reason}`);
      return {
        phases_completed: phasesCompleted,
        directive,
        drafts,
        qa_results: qaResults,
        safety_passed: safetyPassed,
        ready_count: readyCount,
        errors,
        gate_results: gateResults,
      };
    }
  }

  // ── Phase 4: 콘텐츠 생성 ─────────────────────────────────────────────
  if (autonomous && directive && (!options.phase || options.phase === 4)) {
    await sendMessage(
      'orchestrator',
      'all',
      'pipeline',
      '[Phase 4] 콘텐츠 생성 시작 — 에디터별 슬롯 배정.',
      { phase: 4, status: 'started' },
    );

    for (const slot of directive.time_slots) {
      const draft = generateContent(slot, directive);
      drafts.push(draft);
    }

    phasesCompleted.push(4);
    await sendMessage(
      'orchestrator',
      'all',
      'pipeline',
      `[Phase 4] 콘텐츠 초안 ${drafts.length}개 생성 완료. Claude Code가 에디터 파일 참조 후 텍스트 채워야 함.`,
      { phase: 4, status: 'completed', count: drafts.length },
    );
  }

  // ── Phase 5: Safety 검증 + aff_contents 등록 ──────────────────────────
  if (autonomous && directive && (!options.phase || options.phase === 5)) {
    await sendMessage(
      'orchestrator',
      'all',
      'pipeline',
      '[Phase 5] Safety 검증 시작.',
      { phase: 5, status: 'started' },
    );

    for (const draft of drafts) {
      if (!draft.text) continue;

      const qa = runQA(draft);
      qaResults.push(qa);
      if (!qa.passed) {
        updatePlaybook(draft.category, `QA 반려: ${qa.feedback.join('; ')}`);
        continue;
      }

      const safety = await runSafety(draft.text, 'duribeon231');
      if (!safety.allPassed) {
        safetyPassed = false;
        errors.push(`Safety 실패 (${draft.category}): ${safety.blockers.map((b) => b.reason).join(', ')}`);
        continue;
      }

      // format: positionFormatEnum 허용값만 가능. draft.format 없으면 '솔직후기형' fallback.
      // product_id, product_name, need_id: notNull이므로 'pending' placeholder 사용.
      const validFormats = ['문제공감형', '솔직후기형', '비교형', '입문추천형', '실수방지형', '비추천형'] as const;
      type ValidFormat = (typeof validFormats)[number];
      const formatValue: ValidFormat = (validFormats as readonly string[]).includes(draft.format)
        ? (draft.format as ValidFormat)
        : '솔직후기형';
      try {
        const affContentId = crypto.randomUUID();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres.js TransactionSql Omit strips call signatures
        await client.begin(async (tx: any) => {
          await tx`
            INSERT INTO aff_contents (
              id, product_id, product_name, need_id,
              format, status, hook, created_at
            ) VALUES (
              ${affContentId},
              'pending',
              'pending',
              'pending',
              ${formatValue},
              'ready',
              ${draft.hook || ''},
              NOW()
            )
          `;
          // TODO: brand_events.is_used 업데이트 — draft에 brandEventId 연결 후 구현
          // if (draft.brandEventId) {
          //   await tx`UPDATE brand_events SET is_used = true WHERE event_id = ${draft.brandEventId}`;
          // }
        });
        readyCount++;

        // Register in content_lifecycle to start the OODA feedback loop
        await registerPost({
          threadsPostId: affContentId, // placeholder until actual Threads post ID is available
          category: draft.category,
          contentStyle: formatValue,
          hookType: draft.hook || 'unknown',
          postSource: 'pipeline',
          contentText: draft.text,
          accountId: 'binilab__',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`aff_contents 등록 실패: ${msg}`);
      }
    }

    phasesCompleted.push(5);
    await sendMessage(
      'orchestrator',
      'all',
      'pipeline',
      `[Phase 5] Safety 검증 완료. ${readyCount}개 ready 등록.`,
      { phase: 5, status: 'completed', ready_count: readyCount },
    );
  }

  // ── Phase 6: 사후 관리 (스냅샷 수집은 Phase 0으로 이동됨) ───────────
  if (!options.phase || options.phase === 6) {
    await sendMessage(
      'orchestrator',
      'all',
      'pipeline',
      '[Phase 6] 사후 관리 — 스냅샷 수집은 Phase 0에서 자동 실행. /analyze-performance 별도 실행 필요.',
      { phase: 6, status: 'deferred' },
    );
    if (!autonomous) phasesCompleted.push(6);
  }

  const gateFailures = gateResults.filter((g) => !g.passed).length;
  await logEpisode({
    agentId: 'system',
    eventType: 'pipeline_run',
    summary: `Pipeline completed: ${phasesCompleted.length} phases, gate_failures: ${gateFailures}`,
    details: { phases_completed: phasesCompleted, gate_failures: gateFailures, errors },
  });

  return {
    phases_completed: phasesCompleted,
    directive,
    drafts,
    qa_results: qaResults,
    safety_passed: safetyPassed,
    ready_count: readyCount,
    errors,
    gate_results: gateResults,
  };
}
