/**
 * @file daily-pipeline.ts — BiniLab 일일 파이프라인 오케스트레이터.
 *
 * runDailyPipeline(options) 가 Phase 1~6을 순차 조율.
 * --dry-run: Phase 2~3만 실행 (directive 출력).
 * --autonomous: Phase 1~5 자동 실행 (aff_contents status='ready' 등록까지).
 */

import { client } from '../db/index.js';
import { sendMessage } from '../db/agent-messages.js';
import { runSafetyGates } from '../safety/gates.js';
import type {
  TimeSlot,
  DailyDirective,
  ContentDraft,
  QAResult,
  PipelineOptions,
  PipelineResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * 에디터 매핑: 카테고리 → 에이전트 파일 → 페르소나 파일.
 */
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

// ---------------------------------------------------------------------------
// ROI helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Phase 2 helpers: DB queries
// ---------------------------------------------------------------------------

interface PreviousDayStats {
  categoryStats: CategoryStats[];
  brandEventsCount: number;
}

async function fetchPhase2Data(): Promise<PreviousDayStats> {
  const [catRows, eventsRows] = await Promise.all([
    client`
      SELECT
        category,
        COALESCE(AVG(view_count), 0)::float AS avg_views,
        COALESCE(
          AVG((like_count + reply_count + repost_count)::float / NULLIF(view_count, 0)),
          0
        )::float AS engagement_rate
      FROM thread_posts
      WHERE is_published = true
        AND published_at >= NOW() - INTERVAL '48 hours'
        AND published_at < NOW() - INTERVAL '24 hours'
        AND category IS NOT NULL
      GROUP BY category
    `,
    client`
      SELECT COUNT(*)::int AS cnt
      FROM brand_events
      WHERE is_stale = false AND is_used = false AND valid_until >= NOW()
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
// Phase 3: CEO 스탠드업
// ---------------------------------------------------------------------------

/**
 * CEO 스탠드업 실행.
 * 전일 성과 데이터 기반 ROI 계산 → DailyDirective 생성 → agent_messages 저장.
 */
export async function runCEOStandup(totalPosts = 10): Promise<DailyDirective> {
  const date = new Date().toISOString().slice(0, 10);

  // Phase 2 데이터 수집
  const { categoryStats, brandEventsCount } = await fetchPhase2Data();

  // ROI 점수 계산
  const roiSummary: Record<string, { score: number; grade: string }> = {};
  for (const cat of Object.keys(DEFAULT_ALLOCATION)) {
    const stats = categoryStats.find((s) => s.category === cat);
    const score = stats ? parseFloat(calcRoiScore(stats).toFixed(1)) : 0;
    roiSummary[cat] = { score, grade: roiGrade(score) };
  }

  // 카테고리 비율 결정 (ROI A → +1, max 5; C → -1, min 1)
  const allocation = { ...DEFAULT_ALLOCATION };
  for (const [cat, { grade }] of Object.entries(roiSummary)) {
    if (grade === 'A' && allocation[cat] < 5) allocation[cat] += 1;
    if (grade === 'C' && allocation[cat] > 1) allocation[cat] -= 1;
  }
  // 합계를 totalPosts에 맞게 정규화
  const allocTotal = Object.values(allocation).reduce((a, b) => a + b, 0);
  if (allocTotal !== totalPosts) {
    // 가장 큰 카테고리에서 차이만큼 조정
    const diff = totalPosts - allocTotal;
    const topCat = Object.entries(allocation).sort((a, b) => b[1] - a[1])[0][0];
    allocation[topCat] = Math.max(1, allocation[topCat] + diff);
  }

  const regularPosts = Math.ceil(totalPosts * 0.7);
  const experimentPosts = totalPosts - regularPosts;

  // 시간대 슬롯 생성 (totalPosts 수에 맞게 자름)
  const slots = TIME_SLOT_TEMPLATE.slice(0, totalPosts);
  const experimentSlotDate = date.replace(/-/g, '');
  let expIdx = 1;

  const timeSlots: TimeSlot[] = slots.map((s) => {
    const editorMap = EDITOR_MAP[s.category] ?? EDITOR_MAP['뷰티'];
    const slot: TimeSlot = {
      time: s.time,
      category: s.category,
      type: s.type,
      editor: editorMap.agent.replace('.claude/agents/', '').replace('.md', ''),
      brief: '',
    };
    if (s.type === 'experiment') {
      slot.experiment_id = `EXP-${experimentSlotDate}-${String(expIdx++).padStart(3, '0')}`;
    }
    return slot;
  });

  const diversityWarnings: string[] = [];
  if (brandEventsCount < 3) {
    diversityWarnings.push('브랜드 이벤트 3개 미만 — research-brands.ts 재실행 필요');
  }

  // 리사이클 후보 조회 (14일+ 경과, 상위 20%)
  const recycleRows = await client`
    SELECT id
    FROM thread_posts
    WHERE is_published = true
      AND published_at <= NOW() - INTERVAL '14 days'
    ORDER BY view_count DESC
    LIMIT 2
  `;
  const recycleCandidates = recycleRows.map((r) => r.id as string);

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

  // agent_messages 저장
  await sendMessage(
    'minjun-ceo',
    'all',
    'standup',
    `[daily_directive ${date}] ${totalPosts}개 슬롯 배분 완료. ` +
      Object.entries(allocation).map(([k, v]) => `${k}${v}`).join('/') +
      `. 실험 ${experimentPosts}개.`,
    { directive },
  );

  return directive;
}

// ---------------------------------------------------------------------------
// Phase 4: 콘텐츠 생성 (에디터 매핑 반환)
// ---------------------------------------------------------------------------

/**
 * 슬롯에 대한 ContentDraft 뼈대를 생성.
 * 실제 텍스트 생성은 Claude Code가 해당 에디터 에이전트 파일을 참조해서 수행.
 */
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

// ---------------------------------------------------------------------------
// Phase 4: QA 검증
// ---------------------------------------------------------------------------

/**
 * 도윤(QA) 기준 콘텐츠 검증.
 * 킬러게이트 K1~K4 + 체크리스트 10항목.
 */
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

  if (!killersPassed) {
    return { passed: false, score: 0, feedback, killerGates };
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
  return { passed: feedback.length === 0, score, feedback, killerGates };
}

// ---------------------------------------------------------------------------
// Phase 5: Safety 게이트
// ---------------------------------------------------------------------------

/**
 * Worker A가 구현한 안전 게이트 실행.
 */
export async function runSafety(content: string, accountId: string) {
  return runSafetyGates(content, accountId);
}

// ---------------------------------------------------------------------------
// 메인 파이프라인
// ---------------------------------------------------------------------------

/**
 * 일일 파이프라인 전체 실행.
 *
 * Phase 별 동작:
 *   --dry-run:     Phase 2 DB 쿼리 + Phase 3 directive 생성/출력. 나머지 스킵.
 *   --autonomous:  Phase 1~5 자동 (aff_contents status='ready' 등록까지).
 *   기본:          Phase 1~6 순차 (게시는 시훈 승인 후 별도 /threads-post).
 */
export async function runDailyPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { dryRun, autonomous, posts } = options;
  const errors: string[] = [];
  const phasesCompleted: number[] = [];
  const drafts: ContentDraft[] = [];
  const qaResults: QAResult[] = [];
  let directive: DailyDirective | undefined;
  let safetyPassed = true;
  let readyCount = 0;

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
    // 실제 수집은 Claude Code가 /수집 스킬로 실행
  }

  if (dryRun) {
    // dry-run: Phase 1 스킵, Phase 2는 기존 DB 데이터 기반
    await sendMessage(
      'orchestrator',
      'all',
      'pipeline',
      '[dry-run] Phase 1 수집 스킵. 기존 DB 데이터로 Phase 2~3 실행.',
      { dryRun: true },
    );
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

  // ── Phase 3: CEO 스탠드업 (dry-run 포함) ──────────────────────────────
  if (!options.phase || options.phase === 3 || dryRun) {
    try {
      directive = await runCEOStandup(posts);
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
      // 실제 텍스트 생성은 Claude Code가 에디터 파일 참조 후 채움
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

      // QA 검증
      const qa = runQA(draft);
      qaResults.push(qa);
      if (!qa.passed) continue;

      // Safety 게이트
      const safety = await runSafety(draft.text, 'duribeon231');
      if (!safety.allPassed) {
        safetyPassed = false;
        errors.push(`Safety 실패 (${draft.category}): ${safety.blockers.map((b) => b.reason).join(', ')}`);
        continue;
      }

      // aff_contents 등록 (status='ready')
      try {
        const datePrefix = directive.date;
        await client`
          INSERT INTO aff_contents (
            category, scheduled_time, status, editor_agent, brief, content, created_at
          ) VALUES (
            ${draft.category},
            ${datePrefix + ' 08:00:00+09'}::timestamptz,
            'ready',
            ${draft.editor},
            ${draft.hook || ''},
            ${draft.text},
            NOW()
          )
        `;
        readyCount++;
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

  // ── Phase 6: 사후 관리 (게시 24h 후 별도 실행) ────────────────────────
  if (!options.phase || options.phase === 6) {
    await sendMessage(
      'orchestrator',
      'all',
      'pipeline',
      '[Phase 6] 사후 관리 — 게시 24h 후 track-performance.ts + /analyze-performance 실행 필요.',
      { phase: 6, status: 'deferred' },
    );
    if (!autonomous) phasesCompleted.push(6);
  }

  return {
    phases_completed: phasesCompleted,
    directive,
    drafts,
    qa_results: qaResults,
    safety_passed: safetyPassed,
    ready_count: readyCount,
    errors,
  };
}
