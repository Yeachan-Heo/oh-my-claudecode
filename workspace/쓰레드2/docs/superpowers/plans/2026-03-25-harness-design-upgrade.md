# Harness Design Upgrade — 쓰레드2 파이프라인 품질 개선

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anthropic 하네스 설계 원칙(Generator-Evaluator 분리, 반복 개선 루프, 불필요 구성요소 제거)을 쓰레드2 파이프라인에 적용하여 콘텐츠 품질과 시스템 신뢰성을 높인다.

**Architecture:** 5개 독립 작업으로 구성. (1) QA 채점 기준 + 톤검증 연결, (2) ROI 로직 중복 제거, (3) Phase Gate 내용 검증 강화, (4) DailyDirective에 포스트별 계약 추가, (5) QA 재작성 루프. 각 Task는 독립적으로 구현/테스트 가능.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL (Supabase), Vitest

**Inspiration:** [Anthropic — Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) (2026-03-24)

---

## Chunk 1: 안전게이트 강화 + ROI 중복 제거

### Task 1: 톤 검증(gate_toneCheck)을 안전게이트에 연결

`tone-validator.ts`의 `gate_toneCheck()`가 존재하지만 `runSafetyGates()`에서 호출되지 않는 버그 수정.

**Files:**
- Modify: `src/safety/gates.ts:1-4` (import 추가)
- Modify: `src/safety/gates.ts:230-239` (Promise.all에 gate 추가)
- Test: `src/__tests__/safety-gates.test.ts`

- [ ] **Step 1: 기존 톤 검증 테스트 확인**

Run: `npx vitest run src/__tests__/safety-gates.test.ts -t "tone" 2>&1 | tail -5`
Expected: 톤 관련 테스트가 없거나, gate_toneCheck이 runSafetyGates에서 미호출 확인

- [ ] **Step 2: 실패하는 테스트 작성**

`src/__tests__/safety-gates.test.ts`에 추가:

```typescript
describe('gate_toneCheck in runSafetyGates', () => {
  it('should block content with expert terminology', async () => {
    const report = await runSafetyGates(
      '나이아신아마이드 10% 세럼이 피부 장벽 강화에 효과적입니다',
      'test-account',
      10,  // qaScore passing
    );
    expect(report.allPassed).toBe(false);
    const toneGate = report.results.find(r => r.gate === 'gate_toneCheck');
    expect(toneGate).toBeDefined();
    expect(toneGate!.passed).toBe(false);
  });

  it('should pass content without expert terminology', async () => {
    const report = await runSafetyGates(
      '이거 진짜 피부 좋아지는 거 나만 몰랐음? ㅋㅋ',
      'test-account',
      10,
    );
    const toneGate = report.results.find(r => r.gate === 'gate_toneCheck');
    expect(toneGate).toBeDefined();
    expect(toneGate!.passed).toBe(true);
  });
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `npx vitest run src/__tests__/safety-gates.test.ts -t "gate_toneCheck in runSafetyGates" 2>&1 | tail -10`
Expected: FAIL — `toneGate` is undefined (아직 연결 안 됨)

- [ ] **Step 4: gates.ts에 톤 검증 연결**

`src/safety/gates.ts` 상단에 import 추가:

```typescript
import { gate_toneCheck } from './tone-validator.js';
```

`runSafetyGates()` 내부의 `Promise.all` 배열(line 230-238)에 추가:

```typescript
  const results = await Promise.all([
    gate1_warmupCheck(content, db),
    Promise.resolve(gate2_lengthCheck(content)),
    gate3_frequencyCheck(accountId, db),
    Promise.resolve(gate4_duplicateCheck(content, recentTexts)),
    Promise.resolve(gate5_brandSafety(content)),
    Promise.resolve(gate6_qaPassCheck(qaScore)),
    gate7_dailyLimitCheck(accountId, db),
    gate8_captchaRisk(accountId, db),
    Promise.resolve(gate_toneCheck(content)),  // 추가: 전문가 톤 차단
  ]);
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run src/__tests__/safety-gates.test.ts -t "gate_toneCheck in runSafetyGates" 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 6: 전체 safety 테스트 회귀 확인**

Run: `npx vitest run src/__tests__/safety-gates.test.ts 2>&1 | tail -5`
Expected: All tests pass

- [ ] **Step 7: 커밋**

```bash
cd /home/sihun92/projects/oh-my-claudecode/workspace/쓰레드2
git add src/safety/gates.ts src/__tests__/safety-gates.test.ts
git commit -m "fix(safety): wire gate_toneCheck into runSafetyGates pipeline"
```

---

### Task 2: runCEOStandup과 meetingToDirective의 ROI 로직 중복 제거

`runCEOStandup()` (line 286-407)과 `meetingToDirective()` (line 154-280)이 ROI 계산, 배분 조정, 슬롯 생성, 다양성 체크, 재활용 후보 로직을 **거의 동일하게 중복** 구현. 공통 함수로 추출.

**Files:**
- Modify: `src/orchestrator/daily-pipeline.ts:154-407` (두 함수를 리팩토링)
- Test: `src/__tests__/daily-pipeline.test.ts`

- [ ] **Step 1: 중복 확인 — 두 함수의 공통 로직 식별**

공통 로직 목록:
1. `fetchPhase2Data()` 호출
2. ROI 점수 계산 (`calcRoiScore` + `roiGrade`)
3. 카테고리 배분 조정 (A→+1, C→-1, 정규화)
4. regular/experiment 분할
5. 시간대 슬롯 생성 (TIME_SLOT_TEMPLATE)
6. 다양성 경고 생성 (brandEvents + diversity-checker)
7. 재활용 후보 조회
8. DailyDirective 객체 조립
9. logDecision 호출

- [ ] **Step 2: 실패하는 테스트 작성**

`src/__tests__/daily-pipeline.test.ts`에 추가:

```typescript
import { buildDirective } from '../orchestrator/daily-pipeline.js';

describe('buildDirective', () => {
  it('should return a DailyDirective with correct structure', async () => {
    const directive = await buildDirective(10, '2026-03-25');
    expect(directive).toHaveProperty('date', '2026-03-25');
    expect(directive).toHaveProperty('total_posts', 10);
    expect(directive).toHaveProperty('category_allocation');
    expect(directive).toHaveProperty('time_slots');
    expect(directive).toHaveProperty('roi_summary');
    expect(Object.values(directive.category_allocation).reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('should allocate 70% regular and 30% experiment', async () => {
    const directive = await buildDirective(10, '2026-03-25');
    expect(directive.regular_posts).toBe(7);
    expect(directive.experiment_posts).toBe(3);
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx vitest run src/__tests__/daily-pipeline.test.ts -t "buildDirective" 2>&1 | tail -10`
Expected: FAIL — `buildDirective` is not exported

- [ ] **Step 4: buildDirective 공통 함수 추출**

`daily-pipeline.ts`에 새 함수 추가 (meetingToDirective 내부 로직 추출):

```typescript
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

  // 전략 기록
  const topCategories = Object.entries(roiSummary)
    .filter(([, v]) => v.grade === 'A')
    .map(([k]) => k)
    .join(', ') || '없음';
  logDecision(
    date,
    `카테고리 배분: ${Object.entries(allocation).map(([k, v]) => `${k}${v}`).join('/')}`,
    `ROI 점수 기반 조정. A등급: ${topCategories}`,
  );

  return directive;
}
```

- [ ] **Step 5: runCEOStandup을 buildDirective 사용으로 축소**

```typescript
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
```

- [ ] **Step 6: meetingToDirective를 buildDirective 사용으로 축소**

```typescript
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
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `npx vitest run src/__tests__/daily-pipeline.test.ts 2>&1 | tail -10`
Expected: All tests pass

- [ ] **Step 8: 타입체크**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 9: 커밋**

```bash
git add src/orchestrator/daily-pipeline.ts src/__tests__/daily-pipeline.test.ts
git commit -m "refactor(pipeline): extract buildDirective to eliminate ROI logic duplication"
```

---

## Chunk 2: Phase Gate 내용 검증 + 포스트별 계약

### Task 3: Phase Gate에 메시지 내용 검증 추가

현재 `gatePhase2()`와 `gatePhase3()`는 `COUNT(*)` 만 체크 — 메시지가 비어있거나 에러 메시지여도 통과. 실제 내용(directive 키 존재 등)을 검증하도록 강화.

**Files:**
- Modify: `src/orchestrator/daily-pipeline.ts:492-527` (gatePhase2, gatePhase3)
- Test: `src/__tests__/daily-pipeline.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
describe('gatePhase3 content validation', () => {
  it('should fail when CEO message has no directive in metadata', async () => {
    // 빈 메시지를 보내고 게이트 검증
    await sendMessage('minjun-ceo', 'all', 'standup', 'test', {});
    const result = await gatePhase3();
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('directive');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/__tests__/daily-pipeline.test.ts -t "gatePhase3 content" 2>&1 | tail -10`
Expected: FAIL — 현재는 COUNT만 체크하므로 빈 메시지도 통과

- [ ] **Step 3: gatePhase3에 내용 검증 추가**

```typescript
async function gatePhase3(): Promise<PhaseGateResult> {
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
```

- [ ] **Step 4: gatePhase2에도 동일 패턴 적용**

```typescript
async function gatePhase2(): Promise<PhaseGateResult> {
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
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run src/__tests__/daily-pipeline.test.ts 2>&1 | tail -10`
Expected: All tests pass

- [ ] **Step 6: 커밋**

```bash
git add src/orchestrator/daily-pipeline.ts src/__tests__/daily-pipeline.test.ts
git commit -m "fix(pipeline): validate phase gate message content, not just existence"
```

---

### Task 4: DailyDirective에 포스트별 성공 기준(계약) 추가

Anthropic 블로그의 Sprint Contract 패턴 적용. CEO 지시에 포스트별 성공 기준을 포함하여 QA가 무엇을 검증해야 하는지 명확히 함.

**Files:**
- Modify: `src/orchestrator/types.ts` (PostContract 타입 추가, DailyDirective 확장)
- Modify: `src/orchestrator/daily-pipeline.ts` (buildDirective에 계약 생성 로직)
- Test: `src/__tests__/daily-pipeline.test.ts`

- [ ] **Step 1: PostContract 타입 추가**

`src/orchestrator/types.ts`에 추가:

```typescript
export interface PostContract {
  slot_index: number;         // time_slots 배열 인덱스
  category: string;
  strategy: 'empathy' | 'story' | 'curiosity' | 'comparison' | 'list';
  topic_signal?: string;      // DB에서 발견된 니즈 신호 (있으면)
  min_hook_score: number;     // 1-10, 기본 6
  min_originality_score: number; // 1-10, 기본 5
  success_criteria: string;   // 한 줄 요약
}
```

DailyDirective에 필드 추가:

```typescript
export interface DailyDirective {
  // ... 기존 필드 유지
  post_contracts?: PostContract[];  // 추가
}
```

- [ ] **Step 2: 실패하는 테스트**

```typescript
describe('buildDirective post_contracts', () => {
  it('should generate post_contracts matching time_slots count', async () => {
    const directive = await buildDirective(10, '2026-03-25');
    expect(directive.post_contracts).toBeDefined();
    expect(directive.post_contracts!.length).toBe(directive.time_slots.length);
  });

  it('should assign varied strategies across contracts', async () => {
    const directive = await buildDirective(10, '2026-03-25');
    const strategies = new Set(directive.post_contracts!.map(c => c.strategy));
    expect(strategies.size).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 3: buildDirective에 계약 생성 로직 추가**

`buildDirective()` 끝 부분, `return directive;` 직전에:

```typescript
  // 포스트별 계약 생성
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
```

- [ ] **Step 4: 테스트 통과 + 타입체크**

Run: `npx vitest run src/__tests__/daily-pipeline.test.ts -t "post_contracts" && npx tsc --noEmit 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 5: 커밋**

```bash
git add src/orchestrator/types.ts src/orchestrator/daily-pipeline.ts src/__tests__/daily-pipeline.test.ts
git commit -m "feat(pipeline): add PostContract to DailyDirective for sprint-contract pattern"
```

---

## Chunk 3: QA 채점 기준 강화 + 재작성 루프

### Task 5: QA 채점 기준 4축 도입

Anthropic 블로그의 Design Quality/Originality/Craft/Functionality 4축 채점을 콘텐츠 버전으로 변환. 기존 10점 단일 점수를 4축 분리 점수로 확장.

**Files:**
- Modify: `src/orchestrator/types.ts` (QAResult 확장)
- Modify: `src/orchestrator/daily-pipeline.ts:426-467` (runQA 개선)
- Test: `src/__tests__/daily-pipeline.test.ts`

- [ ] **Step 1: QAScores 타입 추가**

`src/orchestrator/types.ts`에서 QAResult 확장:

```typescript
export interface QAScores {
  hook: number;         // 1-10: 첫 문장이 스크롤 멈추게 하는가?
  originality: number;  // 1-10: AI냄새 없이 사람 느낌? 템플릿 반복 없는가?
  authenticity: number; // 1-10: 비전문가 관점? 성분명/의학용어 없는가?
  conversion: number;   // 1-10: 구체적 CTA? 제품 연결 자연스러운가?
}

export interface QAResult {
  passed: boolean;
  score: number;           // 0-10 (기존 호환 — QAScores 가중 평균)
  scores?: QAScores;       // 4축 상세 점수 (신규)
  feedback: string[];
  killerGates: { k1: boolean; k2: boolean; k3: boolean; k4: boolean };
}
```

- [ ] **Step 2: 실패하는 테스트**

```typescript
describe('runQA 4-axis scoring', () => {
  it('should return QAScores with 4 axes', () => {
    const draft: ContentDraft = {
      text: '이거 써봤는데 진짜 좋음 ㅋㅋ 3일 만에 달라짐. 한번 써봐',
      hook: '이거 써봤는데',
      format: 'story',
      category: '뷰티',
      editor: 'bini-beauty-editor',
      agent_file: '.claude/agents/bini-beauty-editor.md',
    };
    const result = runQA(draft);
    expect(result.scores).toBeDefined();
    expect(result.scores!.hook).toBeGreaterThanOrEqual(1);
    expect(result.scores!.hook).toBeLessThanOrEqual(10);
    expect(result.scores!.originality).toBeDefined();
    expect(result.scores!.authenticity).toBeDefined();
    expect(result.scores!.conversion).toBeDefined();
  });

  it('should penalize AI-sounding content on originality', () => {
    const aiDraft: ContentDraft = {
      text: '여러분 추천드립니다 효과적인 세럼을 소개합니다',
      hook: '여러분',
      format: 'list',
      category: '뷰티',
      editor: 'bini-beauty-editor',
      agent_file: '.claude/agents/bini-beauty-editor.md',
    };
    const result = runQA(aiDraft);
    expect(result.scores!.originality).toBeLessThan(5);
  });
});
```

- [ ] **Step 3: runQA에 4축 채점 추가**

`runQA()` 함수 끝 부분(score 계산 후)에 추가:

```typescript
  // 4축 채점 (기존 feedback 기반으로 자동 계산)
  const hookScore = (() => {
    const firstLine = text.split('\n')[0] ?? '';
    let s = 7;
    if (firstLine.length > 30) s -= 3;       // 첫 문장 길면 감점
    if (firstLine.length > 20) s -= 1;
    if (/\?|ㅋ|ㅜ|!/.test(firstLine)) s += 1; // 구어체/감정 보너스
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
    // 전문가 용어가 있으면 큰 감점
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

  const scores: QAScores = {
    hook: hookScore,
    originality: originalityScore,
    authenticity: authenticityScore,
    conversion: conversionScore,
  };

  // 가중 평균으로 기존 score 보정 (후킹 30%, 독창성 30%, 진정성 25%, 전환 15%)
  const weightedScore = Math.round(
    hookScore * 0.3 + originalityScore * 0.3 + authenticityScore * 0.25 + conversionScore * 0.15,
  );

  return {
    passed: feedback.length === 0 && weightedScore >= 6,
    score: Math.min(score, weightedScore),
    scores,
    feedback,
    killerGates,
  };
```

- [ ] **Step 4: 테스트 통과 + 타입체크**

Run: `npx vitest run src/__tests__/daily-pipeline.test.ts -t "4-axis" && npx tsc --noEmit 2>&1 | tail -5`
Expected: All pass

- [ ] **Step 5: 커밋**

```bash
git add src/orchestrator/types.ts src/orchestrator/daily-pipeline.ts src/__tests__/daily-pipeline.test.ts
git commit -m "feat(qa): add 4-axis content scoring (hook/originality/authenticity/conversion)"
```

---

### Task 6: QA 재작성 루프 (최대 3회)

Anthropic 블로그의 반복 개선 루프 적용. QA 실패 시 피드백과 함께 재작성 요청, 최대 3회.

**Files:**
- Modify: `src/orchestrator/types.ts` (QAResult에 iteration 추가)
- Modify: `src/orchestrator/daily-pipeline.ts` (runQAWithRetry 함수)
- Test: `src/__tests__/daily-pipeline.test.ts`

- [ ] **Step 1: QAResult에 iteration 필드 추가**

`src/orchestrator/types.ts`:

```typescript
export interface QAResult {
  passed: boolean;
  score: number;
  scores?: QAScores;
  feedback: string[];
  killerGates: { k1: boolean; k2: boolean; k3: boolean; k4: boolean };
  iteration?: number;       // 추가: 몇 번째 시도인지 (1-3)
  max_retries_exhausted?: boolean;  // 추가: 3회 실패 시 true
}
```

- [ ] **Step 2: 실패하는 테스트**

```typescript
describe('runQAWithRetry', () => {
  it('should return iteration count in QAResult', () => {
    const draft: ContentDraft = {
      text: '이거 진짜 좋음 ㅋㅋ 한번 써봐',
      hook: '이거 진짜 좋음',
      format: 'empathy',
      category: '뷰티',
      editor: 'bini-beauty-editor',
      agent_file: '.claude/agents/bini-beauty-editor.md',
    };
    const result = runQAWithRetry(draft);
    expect(result.iteration).toBe(1);
  });

  it('should mark max_retries_exhausted after 3 failures', () => {
    const badDraft: ContentDraft = {
      text: '', // 빈 텍스트 → K1 실패
      hook: '',
      format: '',
      category: '뷰티',
      editor: 'bini-beauty-editor',
      agent_file: '.claude/agents/bini-beauty-editor.md',
    };
    const result = runQAWithRetry(badDraft);
    // K1 실패로 킬러게이트 미통과 — 재작성 불가(텍스트 변경은 에이전트 몫)
    expect(result.iteration).toBe(1);
    expect(result.passed).toBe(false);
  });
});
```

- [ ] **Step 3: runQAWithRetry 함수 구현**

`daily-pipeline.ts`에 추가:

```typescript
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
    // 피드백에 재작성 가이드 추가
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
```

- [ ] **Step 4: 테스트 통과 + 타입체크**

Run: `npx vitest run src/__tests__/daily-pipeline.test.ts -t "runQAWithRetry" && npx tsc --noEmit 2>&1 | tail -5`
Expected: All pass

- [ ] **Step 5: 전체 테스트 회귀 확인**

Run: `npx vitest run 2>&1 | tail -10`
Expected: All tests pass

- [ ] **Step 6: 커밋**

```bash
git add src/orchestrator/types.ts src/orchestrator/daily-pipeline.ts src/__tests__/daily-pipeline.test.ts
git commit -m "feat(qa): add runQAWithRetry with iteration tracking and feedback loop"
```

---

## Chunk 4: Dead Code 정리

### Task 7: getAgentRegistry DB 조회 dead code 제거

`getAgentRegistry()`가 DB 쿼리 후 항상 `AGENT_REGISTRY` 하드코딩을 반환하는 dead code 정리.

**Files:**
- Modify: `src/orchestrator/agent-spawner.ts:84-100`
- Test: `src/__tests__/agent-spawner.test.ts`

- [ ] **Step 1: 현재 동작 확인**

`getAgentRegistry()`는 line 88-100에서:
1. DB `agents` 테이블 쿼리 → rows 가져옴
2. `rows.length === 0`이면 → `AGENT_REGISTRY` 반환
3. rows가 있어도 → `AGENT_REGISTRY` 반환 (line 96: "For now return AGENT_REGISTRY")

즉 DB 쿼리 결과를 무시함. 이 함수 자체가 불필요.

- [ ] **Step 2: getAgentRegistry를 단순화**

```typescript
/**
 * getAgentRegistry — 에이전트 레지스트리 반환.
 * TODO: DB 기반 동적 레지스트리로 전환 시 여기만 수정.
 */
export function getAgentRegistry(): Record<string, AgentDefinition> {
  return AGENT_REGISTRY;
}
```

- [ ] **Step 3: buildAgentPrompt의 호출 수정**

`buildAgentPrompt` (line 185-186)에서 `await getAgentRegistry()` → `getAgentRegistry()` (async 불필요):

```typescript
export async function buildAgentPrompt(agentId: string, mission: string, context?: string): Promise<string> {
  const registry = getAgentRegistry();
```

- [ ] **Step 4: 타입체크 + 테스트**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 5: 커밋**

```bash
git add src/orchestrator/agent-spawner.ts
git commit -m "refactor(spawner): remove dead DB query from getAgentRegistry"
```

---

## Summary

| Task | 변경 파일 | 핵심 변경 | Anthropic 원칙 |
|------|----------|----------|---------------|
| 1 | gates.ts | 톤 검증 연결 | Evaluator 강화 |
| 2 | daily-pipeline.ts | ROI 중복 → buildDirective 추출 | 하네스 단순화 |
| 3 | daily-pipeline.ts | Phase Gate 내용 검증 | Evaluator 판단력 |
| 4 | types.ts, daily-pipeline.ts | PostContract 도입 | Sprint Contract |
| 5 | types.ts, daily-pipeline.ts | 4축 채점 (후킹/독창성/진정성/전환) | 채점 기준 구체화 |
| 6 | types.ts, daily-pipeline.ts | QA 재작성 루프 (3회) | 반복 개선 루프 |
| 7 | agent-spawner.ts | Dead code 정리 | 불필요 구성요소 제거 |

**총 예상 커밋**: 7개 (Task당 1개)
**의존성**: Task 5 → Task 6 (4축 점수가 있어야 재작성 루프에서 피드백 가능). 나머지는 독립적.
**병렬 실행 가능**: Task 1, 2, 3, 4, 7은 서로 독립적으로 병렬 구현 가능.
