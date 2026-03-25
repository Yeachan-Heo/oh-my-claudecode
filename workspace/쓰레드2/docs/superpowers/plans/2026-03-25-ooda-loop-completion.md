# OODA 루프 완성 — 피드백 루프 배선(Wiring) Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan.

**Goal:** 끊어진 "성과 관찰 → 판단 → 전략 수정" 피드백 루프를 기존 도구 연결(wiring)로 완성. 신규 에이전트 없이, 기존 에이전트 역할 확장 + 기존 도구 8개 연결.

**Architecture:** 7개 Task. 신규 코드 2개 + 기존 도구 wiring 5개. 에이전트 문서(.md) 3개 수정. 핵심 원칙: "코드를 새로 만들지 말고, 이미 있는 도구를 연결하라."

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL (Supabase), Vitest

---

## 현재 상태 → 목표 상태

```
현재: Phase5(QA) ──→ 게시 ──→ (끊김) ──→ 다음날 Phase3(CEO)가 감으로 결정
목표: Phase5(QA) ──→ 게시+lifecycle INSERT ──→ Phase0(snapshot 수집) ──→
      Phase2(서연: 성과 해석) ──→ Phase3(CEO: ROI 기반 자동 배분)
```

## 의존성 구조

```
Task 1 (lifecycle INSERT) ← 모든 후속 Task의 전제
  ↓
Task 2 (snapshot wiring) ← Task 3, 4의 전제
  ↓
Task 3 (서연 역할 확장) — 독립
Task 4 (diagnosis → buildDirective) — Task 2 이후
Task 5 (strategy_archive) — 독립
Task 6 (워밍업 가드레일) — Task 4 이후
Task 7 (snapshot 실패 구분) — 독립
```

**병렬 가능**: Task 3, 5, 7 (서로 다른 파일)
**순차 필수**: Task 1 → Task 2 → Task 4 → Task 6

---

## Chunk 1: 데이터 흐름 복구 (Task 1-2)

### Task 1: 게시 → content_lifecycle INSERT 연결

**담당 에이전트**: 태호(engineer)
**배경**: QA 승인 후 게시가 되지만 content_lifecycle에 레코드가 생성되지 않아 전체 피드백 루프가 시작 안 됨.

**Files:**
- Modify: `src/orchestrator/daily-pipeline.ts` (Phase 5 완료 후 lifecycle INSERT 호출)
- Modify: `src/tracker/snapshot.ts` (registerPost 함수 확인/추가)
- Test: `src/__tests__/daily-pipeline.test.ts`

- [ ] **Step 1: content_lifecycle 테이블 현재 데이터 확인**

```bash
cat > _cl-check.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  const cl = await client`SELECT COUNT(*) as cnt FROM content_lifecycle`;
  const tp = await client`SELECT COUNT(*) as cnt FROM thread_posts WHERE channel_id = 'binilab__'`;
  console.log(`content_lifecycle: ${cl[0].cnt}개`);
  console.log(`빈이 thread_posts: ${tp[0].cnt}개`);
  console.log(`차이: ${Number(tp[0].cnt) - Number(cl[0].cnt)}개 누락`);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _cl-check.ts && rm _cl-check.ts
```

- [ ] **Step 2: daily-pipeline.ts에서 Phase 5 완료 후 lifecycle 등록 경로 확인**

`daily-pipeline.ts`에서 Phase 5 (QA 승인 + 게시) 완료 시점을 찾고, 그 직후에 content_lifecycle INSERT를 호출하는 코드가 있는지 확인.

- [ ] **Step 3: registerPost 함수 구현 또는 확인**

`src/tracker/snapshot.ts`에 `registerPost(postId, metadata)` 함수가 있는지 확인. 없으면 추가:

```typescript
export async function registerPost(postId: string, metadata: {
  category: string;
  content_style: string;
  hook_type: string;
  need_category?: string;
  post_source: string;
}): Promise<void> {
  await client`
    INSERT INTO content_lifecycle (threads_post_id, posted_at, maturity, ${/* 메타데이터 필드들 */})
    VALUES (${postId}, NOW(), 'warmup', ${/* ... */})
    ON CONFLICT (threads_post_id) DO NOTHING
  `;
}
```

- [ ] **Step 4: Phase 5 완료 후 registerPost 호출 연결**

daily-pipeline.ts의 Phase 5 완료 핸들러에서:
```typescript
// QA 통과 + 게시 완료 후
await registerPost(postedPostId, { category, content_style, hook_type, post_source: 'pipeline' });
```

- [ ] **Step 5: 테스트 작성 + 통과**
- [ ] **Step 6: 커밋**

```bash
git commit -m "feat(pipeline): wire content_lifecycle INSERT after Phase 5 publish"
```

---

### Task 2: Phase 0에 snapshot 자동 수집 연결

**담당 에이전트**: 태호(engineer)
**배경**: `scheduleSnapshots()` + `collectSnapshot()`이 구현되어 있지만, Phase 0에서 호출되지 않음. Phase 6도 'deferred' 상태.

**Files:**
- Modify: `src/orchestrator/daily-pipeline.ts` (Phase 0에 snapshot 수집 추가)
- Read: `src/tracker/snapshot.ts` (scheduleSnapshots, collectSnapshot 시그니처 확인)

- [ ] **Step 1: snapshot.ts의 기존 함수 시그니처 확인**

```bash
grep -n "export.*function.*schedule\|export.*function.*collect" src/tracker/snapshot.ts
```

- [ ] **Step 2: Phase 0에 snapshot 수집 로직 추가**

Phase 0 (태호 engineer)의 기존 업무: 비활성 채널 교체 + 성과 수집.
여기에 추가:
```typescript
// Phase 0 시작 시: 어제 게시 포스트의 성과 스냅샷 수집
const targets = await scheduleSnapshots();
if (targets.length > 0) {
  log(`Phase 0: ${targets.length}개 포스트 성과 스냅샷 수집`);
  for (const target of targets) {
    await collectSnapshot(target);
  }
}
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
git commit -m "feat(pipeline): wire snapshot collection into Phase 0"
```

---

## Chunk 2: 에이전트 역할 확장 (Task 3)

### Task 3: 서연 역할 확장 — 성과 해석 + 실험 판정

**담당**: 문서 수정 (에이전트 .md 파일)
**배경**: 서연의 현재 역할은 Phase 2 니즈 분석만. 성과 해석(diagnosis), 실험 verdict 판정을 추가.

**Files:**
- Modify: `.claude/agents/seoyeon-analyst.md`
- Modify: `src/agents/performance-analyzer.md` (서연이 참조할 성과 분석 가이드)

- [ ] **Step 1: seoyeon-analyst.md에 성과 해석 업무 추가**

기존 역할 섹션에 추가:
```markdown
## Phase 6.5: 성과 해석 (일일)

### 입력
- `post_snapshots` — 게시 포스트의 6h/48h/7d 성과 데이터
- `content_lifecycle` — 포스트 메타데이터

### 수행
1. `track-performance.ts` 실행으로 최신 성과 수집
2. `createDiagnosisReport()` 실행으로 보틀넥 진단
3. 실험 포스트 verdict 판정 (experiment_id가 있는 포스트의 A/B 성과 비교)
4. 결과를 CEO에게 보고 (agent_messages → minjun-ceo)

### 출력
- diagnosis report (보틀넥 + 튜닝 액션)
- 실험 verdict (experiment-log.md에 기록)
- CEO 보고 메시지 (category_allocation 조정 제안 포함)

### 도구
- `scripts/track-performance.ts` — 성과 데이터 수집 (기존)
- `src/tracker/diagnosis.ts:createDiagnosisReport()` — 보틀넥 진단 (기존)
- `src/tracker/metrics.ts` — 성과 지표 계산 (기존)
```

- [ ] **Step 2: 커밋**

```bash
git commit -m "docs(agents): expand seoyeon role with performance analysis + experiment verdict"
```

---

## Chunk 3: 피드백 루프 연결 (Task 4-6)

### Task 4: diagnosis → buildDirective 피드백 연결

**담당 에이전트**: 태호(engineer)
**배경**: `buildDirective()`가 `fetchPhase2Data()`만 사용. diagnosis 결과를 카테고리 배분에 반영하는 경로 필요.

**Files:**
- Modify: `src/orchestrator/daily-pipeline.ts` (buildDirective에 diagnosis 참조 추가)

- [ ] **Step 1: diagnosis.ts에서 최근 보고서 조회 함수 확인**

```bash
grep -n "export.*function.*diagnosis\|export.*function.*report\|export.*function.*latest" src/tracker/diagnosis.ts
```

- [ ] **Step 2: buildDirective에 최근 diagnosis 결과 참조 로직 추가**

```typescript
// buildDirective() 내부, ROI 계산 후:
const latestDiagnosis = await getLatestDiagnosisReport();
if (latestDiagnosis?.tuning_actions) {
  for (const action of latestDiagnosis.tuning_actions) {
    // 예: { category: '뷰티', action: 'decrease', reason: '참여율 하락' }
    if (action.action === 'decrease' && allocation[action.category]) {
      allocation[action.category] = Math.max(1, allocation[action.category]! - 1);
    }
    if (action.action === 'increase' && allocation[action.category]) {
      allocation[action.category] = allocation[action.category]! + 1;
    }
  }
  // 정규화
}
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
git commit -m "feat(pipeline): wire diagnosis tuning_actions into buildDirective allocation"
```

---

### Task 5: strategy_archive 자동 기록

**담당 에이전트**: 태호(engineer)
**배경**: `strategy_archive` 테이블 0건. CEO 결정이 DB에 기록되지 않아 이력 추적 불가.

**Files:**
- Modify: `src/orchestrator/daily-pipeline.ts` (buildDirective 끝에 archive INSERT)
- Read: `src/db/strategy-archive.ts` (기존 함수 확인)

- [ ] **Step 1: strategy-archive.ts의 기존 함수 확인**

```bash
grep -n "export.*function" src/db/strategy-archive.ts
```

- [ ] **Step 2: buildDirective 끝에 archiveStrategy 호출 추가**

```typescript
// buildDirective() return 직전:
await archiveStrategy({
  date,
  allocation: directive.category_allocation,
  roi_summary: directive.roi_summary,
  rationale: `ROI 기반. A등급: ${topCategories}`,
  source: 'buildDirective',
});
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
git commit -m "feat(pipeline): auto-record CEO decisions to strategy_archive"
```

---

### Task 6: 워밍업 기간 diagnosis 가드레일

**담당 에이전트**: 태호(engineer)
**배경**: 워밍업 포스트는 제휴링크 없어 revenue=0. diagnosis가 항상 "수익 낮음"으로 진단. 워밍업 중에는 참여 지표만 사용.

**Files:**
- Modify: `src/tracker/diagnosis.ts` (워밍업 모드 분기)

- [ ] **Step 1: diagnosis.ts의 THRESHOLDS 확인**

```bash
grep -n "THRESHOLD\|MIN_\|warmup" src/tracker/diagnosis.ts
```

- [ ] **Step 2: 워밍업 모드 분기 추가**

```typescript
// createDiagnosisReport() 시작 부분:
const warmupPostCount = await client`
  SELECT COUNT(*) as cnt FROM content_lifecycle WHERE maturity = 'warmup'
`;
const isWarmupMode = Number(warmupPostCount[0].cnt) < 20;

if (isWarmupMode) {
  // revenue/conversion 기반 진단 스킵, 참여 지표만 사용
  // THRESHOLDS를 참여 중심으로 오버라이드
}
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
git commit -m "fix(diagnosis): add warmup mode guardrail (engagement-only during warmup)"
```

---

## Chunk 4: 데이터 품질 (Task 7)

### Task 7: snapshot 수집 실패 구분

**담당 에이전트**: 태호(engineer)
**배경**: Playwright 실패 시 모든 메트릭이 0으로 기록. "성과 낮음"과 "수집 실패" 구분 불가.

**Files:**
- Modify: `src/tracker/snapshot.ts` (status 필드 추가)
- DB: `post_snapshots` 테이블에 `status` 컬럼 추가

- [ ] **Step 1: post_snapshots에 status 컬럼 추가**

```bash
cat > _add-status.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  await client`ALTER TABLE post_snapshots ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'success'`;
  console.log('status 컬럼 추가 완료');
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _add-status.ts && rm _add-status.ts
```

- [ ] **Step 2: collectSnapshot에서 실패 시 status='failed' 기록**

snapshot.ts의 catch 블록에서:
```typescript
// 기존: 0으로 기록
// 변경: status='failed'로 마킹
await client`UPDATE post_snapshots SET status = 'failed' WHERE ...`;
```

- [ ] **Step 3: diagnosis/metrics에서 status='failed' 레코드 제외**

```typescript
// metrics.ts, diagnosis.ts의 쿼리에 추가:
WHERE status = 'success'  // 또는 status != 'failed'
```

- [ ] **Step 4: 커밋**

```bash
git commit -m "fix(snapshot): distinguish collection failures from zero-performance posts"
```

---

## 실행 순서

```
Chunk 1 (순차 — 전제 조건):
  Task 1: lifecycle INSERT 연결
  Task 2: Phase 0 snapshot wiring

Chunk 2 + 3 + 4 (병렬 가능):
  Task 3: 서연 역할 확장 (문서만)
  Task 5: strategy_archive 자동 기록
  Task 7: snapshot 실패 구분

Chunk 3 (순차 — Chunk 1 이후):
  Task 4: diagnosis → buildDirective
  Task 6: 워밍업 가드레일
```

## Acceptance Criteria

| 기준 | 측정 | 목표 |
|------|------|------|
| content_lifecycle 자동 INSERT | 게시 후 lifecycle 레코드 생성 | 100% |
| snapshot 자동 수집 | Phase 0에서 scheduleSnapshots 호출 | 실행 확인 |
| diagnosis → buildDirective | allocation이 DEFAULT와 다른 값 산출 | diagnosis 데이터 있을 때 |
| strategy_archive | buildDirective 실행 시 archive INSERT | 0건 → 1+건 |
| 워밍업 diagnosis | revenue 기반 진단 스킵 | warmup 모드에서 |
| snapshot 실패 구분 | status='failed' 레코드 별도 | 0값과 실패 구분 |

## Out of Scope
- 대시보드 UI (별도 세션)
- 지현 역할 재정의 (당분간 현행 유지)
- 에이전트 간 메시지 버스 재설계 (MetaGPT 참고 후 별도 세션)
