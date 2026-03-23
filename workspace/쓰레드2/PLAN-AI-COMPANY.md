# AI Company 구축 계획 — 쓰레드2 (v2, 2026-03-23 업데이트)

> 목표: 시훈이 병목에서 이사회로. AI 에이전트들이 자율적으로 수집·분석·기획·작성·검증·개선하는 마케팅 대행사.
> 방식: 단계적 확장 — Phase 1(반자율) → Phase 2(자율+승인) → Phase 3(완전자율)
> 원칙: **기존 도구 최대 활용. 새 코드 최소화. 오케스트레이션 레이어만 추가.**

---

## 현재 상태 (세션 12 기준, 2026-03-23)

### 이미 완성된 도구

| 도구 | 상태 | 비고 |
|------|------|------|
| `/수집` 스킬 | ✅ 동작 확인 | 벤치마크(--since 24h) + YouTube(playlistItems, 쿼터 99%↓) + X트렌드 + 성과. 병렬 실행. |
| `/기획` (threads-plan) | ✅ E2E 검증 | DB 5소스 24h 스캔 → JTBD 분석 → 기획서 3개 → 사용자 선택 |
| 토론 시스템 | ✅ E2E 검증 | 가이드+빈이 2에이전트 토론 → 체크리스트 10/10 → 최종본 |
| `/threads-post` | ✅ 게시 검증 | CDP 자동 게시 + DB 업데이트 |
| `/analyze-performance` | ✅ 기존 | 일일 성과분석 |
| `collect.ts` | ✅ 개선 | upsert (중복 시 지표만 업데이트) + --since 시간 기반 중단 |
| `collect-youtube-comments.ts` | ✅ 개선 | playlistItems API (100→1 unit), 에러 핸들링 per-channel |
| `run-trend-pipeline.ts` | ✅ 동작 확인 | Apify X트렌드 100개 + 필터 + Threads 키워드 수집 |
| `topic-classifier.ts` | ✅ 개선 | TAG_MAP + classifyByText() 본문 키워드 매칭 |
| `db-adapter.ts` | ✅ 개선 | onConflictDoUpdate (지표 upsert) |

### DB 현황
- thread_posts: 1,235개 (미분류 NULL 0개, 기타 732개)
- youtube_videos: 51개 + youtube_channels: 49개 (47 UC + 2 핸들)
- trend_keywords: 397개 (100개 신규)
- channels: 29개 (verified only)
- 워밍업: 8/20 완료

### 현재 플로우 (수동)
```
시훈 → "/수집 전체" → 확인 → "/기획" → 선택 → 토론 → 확인 → "/threads-post" → 게시
       (자동화됨)      (병목)   (자동화됨)  (병목)   (자동화됨) (병목)   (자동화됨)
```

---

## 목표 상태

```
시훈: "오늘 돌려" (or cron)
  ↓
CEO Agent: 데이터 확인 → 우선순위 결정 → 팀에 지시
  ↓
/수집(병렬) → /기획(CEO directive) → 토론(가이드+빈이) → QA → [게시 큐]
  ↓
autoresearch: 콘텐츠 전략 자동 실험 + 개선 루프
  ↓
시훈: 아침에 큐 확인 → 승인 → 게시 (Phase 2)
시훈: 주간 리포트만 확인 (Phase 3)
```

---

## Phase 1: Foundation — "회사 구조 구축" (1세션)

### 목적
에이전트에게 정체성(soul)을 부여하고 회사 구조를 만든다.

### 1-1. 디렉토리 구조

```
src/agents/
├── agency.md                    ← 에이전시 미션 + 공유 가치관
├── souls/                       ← 정체성 (WHO)
│   ├── bini.md                  ← content.md에서 인격 추출
│   ├── guide.md                 ← post-debate-system.md에서 인격 추출
│   ├── analyst.md               ← performance-analyzer.md에서 추출
│   ├── researcher.md            ← brand-researcher.md에서 추출
│   └── ceo.md                   ← NEW: 전체 ROI 최적화, 우선순위 결정
├── operations/                  ← 프로세스 (HOW) — 기존 파일 재구성
│   ├── content-ops.md           ← content.md CoT/규칙 분리
│   ├── debate-ops.md            ← post-debate-system.md 프로세스
│   ├── performance-ops.md       ← 성과분석 프레임워크
│   ├── research-ops.md          ← 브랜드 리서치 프로세스
│   ├── daily-standup-ops.md     ← NEW: CEO 스탠드업 프로세스
│   └── weekly-retro-ops.md      ← NEW: 주간 전략회의 프로세스
├── guides/                      ← 지침서 (현행 유지)
│   ├── post-writing-guide.md
│   ├── COLLECTION_GUIDE.md
│   └── DISCOVERY_GUIDE.md
└── memory/                      ← NEW: 에이전트 학습 기록
    ├── strategy-log.json
    ├── experiment-log.json
    └── weekly-insights.json
```

### 1-2. 기존 파일 분리 (코드 변경 0, 문서만 재구성)

| 기존 파일 | → soul | → operations |
|-----------|--------|-------------|
| `content.md` | `souls/bini.md` | `operations/content-ops.md` |
| `post-debate-system.md` | `souls/guide.md` | `operations/debate-ops.md` |
| `performance-analyzer.md` | `souls/analyst.md` | `operations/performance-ops.md` |
| `brand-researcher.md` | `souls/researcher.md` | `operations/research-ops.md` |

### 1-3. Phase 1 완료 기준

- [ ] agency.md + 5개 soul 파일 작성
- [ ] 기존 4개 파일 → soul/ops 분리
- [ ] daily-standup-ops.md 작성
- [ ] 토론 시스템이 새 구조에서 동작 검증

---

## Phase 2: Semi-Autonomous — "한마디면 하루가 돌아간다" (2세션)

### 목적
`/daily-run` 한마디로 수집→분석→기획→작성까지 자동. 게시만 승인.

### 2-1. `/daily-run` 파이프라인

**기존 스킬/도구를 순차 호출하는 오케스트레이터만 추가.**

```
/daily-run
  │
  ├─ Step 1: 수집 (병렬) — /수집 전체 (기존 스킬)
  │   ├─ [병렬] 벤치마크 29채널 --since 24 (CDP)
  │   ├─ [병렬] YouTube 47채널 --days 1 (API)
  │   ├─ [병렬] X트렌드 --dry-run (Apify)
  │   └─ [순차] 트렌드 Step3 Threads 검색 (CDP, 벤치마크 후)
  │
  ├─ Step 2: 분석 — 기존 도구 조합
  │   ├─ topic-classifier.ts (자동 카테고리 분류)
  │   ├─ /analyze-performance (어제 성과 리포트)
  │   └─ /threads-plan Step 0~1 (신호 스캔)
  │
  ├─ Step 3: CEO 스탠드업
  │   ├─ Step 1~2 결과 종합 (Claude Code 직접 분석)
  │   ├─ 오늘의 우선순위 결정
  │   └─ daily_directive 생성
  │
  ├─ Step 4: 콘텐츠 생성 — /기획 + 토론 시스템 (기존)
  │   ├─ CEO directive 기반 소재 선택
  │   ├─ /threads-plan Step 2~3 (기획서 생성)
  │   ├─ 토론 시스템 (가이드+빈이)
  │   └─ 최종 포스트 생성
  │
  └─ Step 5: QA + 큐 등록
      ├─ 체크리스트 최종 검증 (기존)
      ├─ 통과 → aff_contents status='ready'
      └─ 시훈에게 텔레그램 알림
```

### 2-2. 게시 큐

```sql
-- aff_contents에 status 컬럼 추가
ALTER TABLE aff_contents ADD COLUMN status TEXT DEFAULT 'draft';
-- draft → ready (QA 통과) → approved (시훈 승인) → published (게시 완료)
```

시훈 플로우:
```
텔레그램: "포스트 2개 준비 완료"
  → 시훈: 확인 → "승인" → /threads-post 자동 게시
```

### 2-3. autoresearch 도입 — 콘텐츠 전략 자동 실험

**autoresearch를 "콘텐츠 전략 최적화 엔진"으로 활용.**

기존 autoresearch 프레임워크(OMC CLI)를 그대로 사용하되, 미션과 평가기준을 BiniLab 맥락에 맞게 설정.

#### 실험 유형 3가지

| 실험 | 미션 | 평가 커맨드 | 유지 정책 |
|------|------|-----------|----------|
| **훅 최적화** | "조회수 높이는 훅 패턴 찾기" | 게시 후 24h 조회수 측정 → 평균 대비 점수 | score_improvement |
| **포맷 실험** | "비교형 vs 리스트형 참여율 비교" | 7일간 포맷별 평균 참여율 비교 | score_improvement |
| **시간대 실험** | "최적 게시 시간 찾기" | 시간대별 조회수 비교 | score_improvement |

#### 실행 구조

```
autoresearch 미션 설정
  ↓
매일 /daily-run에서:
  CEO가 실험 포스트 1개 할당 (전체의 20%)
  ↓
  실험 포스트 생성 (변형: 다른 훅/포맷/시간)
  ↓
  게시 후 24h 성과 수집 (track-performance.ts)
  ↓
  autoresearch 평가: 점수 올랐으면 유지, 아니면 폐기
  ↓
  3회 연속 실패 → 해당 실험 종료, 다음 실험으로
```

#### 평가 커맨드 예시 (기존 도구 활용)

```bash
# 훅 최적화 평가: 최근 게시 포스트의 24h 조회수 vs 평균
npx tsx scripts/track-performance.ts && \
npx tsx _eval-hook.ts
# _eval-hook.ts: DB에서 최근 포스트 조회수 → 평균 대비 비율 → {pass, score} JSON 출력
```

#### 학습 기록 연동

```
autoresearch 결과 → agents/memory/experiment-log.json에 자동 기록
  → 주간 전략회의에서 CEO가 참조
  → 성공 패턴 → strategy-log.json에 승격
  → soul 파일 업데이트 제안
```

### 2-4. Phase 2 완료 기준

- [ ] `/daily-run` 스킬 E2E 동작 (수집→분석→기획→작성→큐)
- [ ] CEO 스탠드업이 합리적 directive 생성 (5일 연속)
- [ ] 게시 큐 → 시훈 승인 → 게시 흐름 동작
- [ ] autoresearch 실험 1회 완주 (훅 최적화)
- [ ] 시훈 개입 없이 수집→작성까지 완주 3회 이상

---

## Phase 3: Full Autonomous — "시훈은 이사회" (Phase 2 안정화 후)

### 자율 게시 진입 조건

| 조건 | 기준 |
|------|------|
| 품질 일관성 | 시훈 수정률 < 10% (최근 20개 중 2개 이하) |
| 성과 안정성 | 주간 평균 조회수 2주 연속 감소 없음 |
| 안전성 | 삭제/숨김 0건 |
| 학습 작동 | 전략 변경 → 성과 개선 1회 이상 |

### 3-1. 자율 게시 + Safety Check

```
포스트 생성 → QA 체크리스트 (기존) → Safety Check (NEW)
  ├─ 민감 키워드 스캔
  ├─ 이전 삭제 패턴 유사도
  └─ 통과 → 자동 게시 → 30분 후 초기 체크
```

### 3-2. 주간 전략회의 (자동)

```
CEO + 분석가 + 빈이 (3자 회의, /team 활용)
  1. 주간 성과 리뷰 (TOP 3 / BOTTOM 3)
  2. autoresearch 실험 결과 리뷰
  3. 전략 조정 제안
  4. 다음 주 실험 설계
  5. → weekly-insights.json + strategy-log.json 저장
  6. → 시훈에게 주간 리포트 텔레그램 발송
```

### 3-3. autoresearch 고도화 — 자율 실험 설계

Phase 2에서는 시훈이 실험 미션을 설정했지만, Phase 3에서는 CEO가 자체적으로:

```
주간회의 결과 분석
  → "비교형 참여율이 3주 연속 하락"
  → CEO가 autoresearch 미션 자동 생성:
     미션: "비교형 대신 리스트형 실험 3건"
     평가: "7일 평균 참여율 > 비교형 평균"
  → autoresearch 자동 실행
  → 결과 → 다음 주간회의에 반영
```

### 3-4. Phase 3 완료 기준

- [ ] 7일 연속 시훈 개입 없이 자율 운영
- [ ] 주간회의 → 전략 변경 → 성과 반영 1회 완주
- [ ] autoresearch 실험 CEO 자체 설계 1회
- [ ] 주간 리포트가 시훈에게 actionable 인사이트 제공

---

## 구현 순서 (세션별)

### 세션 A: Foundation (Phase 1) — 1세션
1. `agency.md` 작성
2. `souls/` 5개 파일 (기존 파일에서 인격 추출)
3. 기존 파일 → soul/ops 분리
4. 토론 시스템 동작 검증

### 세션 B: CEO + Daily Pipeline (Phase 2) — 1세션
1. `souls/ceo.md` 상세화 + `daily-standup-ops.md`
2. `/daily-run` 스킬 생성 (기존 스킬 오케스트레이션)
3. 게시 큐 (aff_contents.status 컬럼)
4. E2E 테스트: "/daily-run" → 포스트 큐 등록

### 세션 C: autoresearch + 학습 (Phase 2) — 1세션
1. autoresearch 미션 설정 (훅 최적화)
2. 평가 스크립트 작성 (기존 track-performance.ts 활용)
3. `agents/memory/` JSON 스키마 + 기록 로직
4. 실험 1회 완주 테스트

### 세션 D: 주간회의 + 자율화 (Phase 2→3) — 1세션
1. `weekly-retro-ops.md` 작성
2. `/weekly-retro` 스킬 생성 (/team으로 3자 회의)
3. Safety Check 구현
4. 자율 게시 조건 모니터링

---

## 기존 도구 활용 매핑

| 회사 기능 | 기존 도구 (변경 없음) | 새로 만들 것 (최소) |
|-----------|---------------------|-------------------|
| 데이터 수집 | `/수집` 스킬 (벤치마크+YouTube+트렌드+성과) | - |
| 카테고리 분류 | `topic-classifier.ts` (TAG_MAP + classifyByText) | - |
| 포스트 기획 | `/threads-plan` 스킬 (24h 신호 스캔→기획서 3개) | - |
| 포스트 작성 | 토론 시스템 `post-debate-system.md` | - |
| 포스트 게시 | `/threads-post` 스킬 (CDP 자동 게시) | - |
| 성과 수집 | `track-performance.ts` | - |
| 성과 분석 | `/analyze-performance` 스킬 | - |
| 브랜드 리서치 | `research-brands.ts` + Exa | - |
| 지표 업데이트 | `db-adapter.ts` upsert (중복 시 지표만) | - |
| 병렬 실행 | `/team` 스킬 (Claude Code native teams) | - |
| CEO 스탠드업 | - | `daily-standup-ops.md` (문서만) |
| Daily Pipeline | - | `/daily-run` 스킬 (오케스트레이션만) |
| 게시 큐 | - | `aff_contents.status` 컬럼 (ALTER 1줄) |
| 실험 시스템 | `omc autoresearch` (OMC CLI 기존) | 평가 스크립트 1개 |
| 학습 기록 | - | `agents/memory/*.json` (파일만) |
| 주간 회의 | - | `/weekly-retro` 스킬 (/team 활용) |
| Safety Check | 토론 체크리스트 (기존) | 민감 키워드 목록 (문서) |

**새 코드:** 평가 스크립트 1개 + ALTER TABLE 1줄
**새 문서:** soul 5개 + ops 3개 + agency 1개
**새 스킬:** `/daily-run`, `/weekly-retro` (기존 스킬 조합)

---

## autoresearch 상세 설계

### 왜 도입하는가

현재: 콘텐츠 전략이 **시훈의 감**에 의존. "공감형이 좋더라" → 공감형만 계속 → 성과 정체.
목표: **데이터 기반 자동 실험** → 뭐가 먹히는지 숫자로 증명 → 전략 자동 진화.

### autoresearch가 BiniLab에서 하는 일

```
autoresearch = BiniLab의 R&D 부서

미션 예시:
  "훅에 숫자를 넣으면 조회수가 올라가는가?"

실험:
  - 같은 주제, 같은 시간대에 게시
  - A: "선크림 추천" (숫자 없음)
  - B: "선크림 3개 비교" (숫자 있음)

평가:
  - 24h 후 조회수 비교
  - B가 A의 1.5배 → {pass: true, score: 150}
  - 유지 → strategy-log에 기록: "훅에 숫자 포함 = 1.5배 효과"

다음 실험:
  "숫자 + 반전 조합은?"
  → 자동 반복
```

### 기존 도구 활용

| autoresearch 기능 | 사용할 기존 도구 |
|------------------|----------------|
| 코드 수정 (포스트 전략) | CEO directive + `/기획` 파라미터 변형 |
| 평가 (성과 측정) | `track-performance.ts` → DB 쿼리 |
| 워크트리 격리 | autoresearch 내장 git worktree |
| 결과 기록 | autoresearch ledger + `agents/memory/` |
| 실험 설계 | CEO + `weekly-retro-ops.md` |

### 평가 스크립트 (1개만 새로 작성)

```typescript
// scripts/eval-content-strategy.ts
// autoresearch 평가 커맨드로 사용
// 입력: 최근 게시 포스트 ID (환경변수)
// 출력: {pass: boolean, score: number} JSON
//
// 점수 = (해당 포스트 24h 조회수) / (최근 7일 평균 조회수) × 100
// pass = score >= 80 (평균의 80% 이상이면 통과)
```

---

## 리스크 & 대응

| 리스크 | 대응 |
|--------|------|
| CEO가 잘못된 판단 | Phase 2에서 시훈 검증, directive 로그 누적 |
| 자율 게시 후 문제 | Safety Check + 30분 모니터링 |
| 학습 오버피팅 | autoresearch 실험 예산 20% 강제 |
| 토론 무한루프 | 3라운드 제한 (기존 규칙) |
| API 비용 | 전부 Claude Code 직접 분석 ($0), YouTube playlistItems (1 unit) |

---

## 시훈의 역할 변화

| Phase | 시훈이 하는 것 | 시훈이 안 하는 것 |
|-------|---------------|-----------------|
| 현재 | 모든 명령, 모든 확인 | - |
| Phase 1 | soul 검토, 구조 승인 | 수집/분석 명령 |
| Phase 2 | 포스트 승인(1분), 실험 미션 설정 | 수집/분석/기획/작성 |
| Phase 3 | 주간 리포트 리뷰, 월간 방향 | 일상 운영 전부 + 실험 설계 |
