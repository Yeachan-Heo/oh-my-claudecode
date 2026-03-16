# Threads 제휴마케팅 자동화 시스템 — Plan

> 쓰레드 포스트를 24/7 스크래핑 → 니즈 발견 → 제품 매칭 → 10개 계정으로 제휴마케팅 수익화

---

## 1. 목표

쓰레드 포스트를 24시간 스크래핑하며 변동하는 니즈를 파악하고, 니즈에 맞는 제품을 소개하여 10개의 계정으로 제휴마케팅을 수행한다. 계정은 리스크 관리를 위해 주기적으로 삭제/재생성한다.

---

## 2. 기존 자산 (쓰레드 v1) 분석

### 2.1 재사용 가능한 코드

기존 `workspace/쓰레드/` 프로젝트에서 ~70%를 재사용한다.

| 기존 파일 | 재사용도 | 이관 위치 | 변경 사항 |
|-----------|---------|-----------|----------|
| `scripts/login-threads.ts` | **100%** | `src/scraper/login.ts` | 그대로 |
| `scripts/discover-channels.ts` | **90%** | `src/scraper/discover.ts` | 키워드 확장 |
| `scripts/collect-posts.js` | **80%** | `src/scraper/collect.ts` | JS→TS 전환, 다중 계정 대응 |
| `scripts/orchestrate-crawl.ts` | **60%** | `src/scraper/orchestrator.ts` | 수동 트리거→daemon 리팩토링 |
| `scripts/types.ts` (80+ 인터페이스) | **70%** | `src/types.ts` | Account, Snapshot, Diagnosis 타입 추가 |
| `agents/*.md` (6개 에이전트 프롬프트) | **90%** | `src/agents/` | 소폭 조정 |
| `data/product_dict/products_v1.json` | **100%** | `data/product_dict/` | 그대로 |
| 안티봇 전략 (가우스 타이밍 등) | **100%** | 코드 내 로직 | 그대로 |
| Self-Verification 체크리스트 | **100%** | 에이전트 프롬프트 내 | 그대로 |

### 2.2 기존에 이미 완성된 기능

- **수집 (90%)**: Playwright 로그인, 채널 발굴 (28 키워드, 4단계 필터), 포스트 수집 (40개/채널), 댓글/제휴링크 추출, Checkpoint/Resume
- **분석 (100%)**: 7개 AI 에이전트 (리서처→니즈탐지→상품매칭→포지셔닝→콘텐츠→성과분석), 구매신호 L1-L5, 6개 욕구 유형, 5-Criteria 채점, Learning Deltas 피드백 루프
- **콘텐츠 (100%)**: 본문 3개 + 훅 5개 + 셀프댓글, AI 말투 탐지 (12가지 금지 패턴), 6가지 포맷
- **데이터**: 수집 데이터 1.8MB, 제휴상품 사전 ~50개, Google Sheets 연동

### 2.3 기존에 없는 것 (신규 개발 필요)

| 모듈 | 중요도 | 설명 |
|------|--------|------|
| 24/7 daemon / worker 패턴 | 높음 | 수동 트리거 → 상시 운영 |
| 자동 포스팅 | 높음 | 현재 수동 검토 후 게시 |
| 10개 계정 관리 + 로테이션 | 높음 | 생성→운영→폐기 사이클 |
| DB (PostgreSQL) | 높음 | 현재 JSON 파일 → DB 전환 |
| 6h/48h/7d 스냅샷 추적 | 중간 | 성과 추적 시스템 |
| 속도 기반 지표 / 성숙도 모델 | 중간 | 시간 정규화 비교 |
| 병목 진단 엔진 | 중간 | 자가 개선 루프 |
| 프록시/fingerprint 분리 | 중간 | 다중 계정 인프라 (Phase 3, 10개 계정 시) |
| 대시보드 | 낮음 | 모니터링 UI |

---

## 3. 파이프라인 (7단계)

```
수집 → 분석 → 매칭 → 생성 → 발행 → 추적 → 진단+튜닝
 ↑                                              │
 └──────────── 자가 개선 피드백 루프 ──────────────┘
```

| 단계 | 역할 | LLM | 소스 |
|------|------|-----|------|
| ① 수집 | Threads 스크래핑 (Playwright) | X | 기존 90% |
| ② 분석 | 니즈 추출 + 카테고리 분류 + 신뢰도 점수 | O | 기존 100% |
| ③ 매칭 | 니즈 ↔ 제휴상품 DB 매칭 | O (or 규칙) | 기존 100% |
| ④ 생성 | 제휴 콘텐츠/포스트 작성 | O | 기존 100% |
| ⑤ 발행 | Playwright CDP로 UI 직접 포스팅. 1개 계정으로 시작 → 추후 10개 확장 | X | **신규** |
| ⑥ 추적 | 6h/48h/7d 3단계 스냅샷 + 속도 기반 지표 | X | **신규** |
| ⑦ 진단 | 병목 역추적 + 파이프라인 자동 튜닝 | 일부 | **신규** (performance.md 확장) |

### 기존 에이전트 구조 (유지)

```
[1] 수집 에이전트 (Playwright) ← 기존 scripts/
[2] 리서처 (Opus)              ← agents/researcher.md
[3] 니즈탐지 (Opus)            ← agents/needs-detector.md
[4] 상품매칭 (Sonnet)          ← agents/product-matcher.md
[5] 포지셔닝 (Sonnet)          ← agents/positioning.md
[6] 콘텐츠 (Sonnet)            ← agents/content.md
[7] 성과분석 (Opus)            ← agents/performance.md (+ 진단 역할 확장)
```

---

## 4. 프로젝트 구조

```
쓰레드2/
├── plan.md                       ← 이 문서
├── package.json
├── tsconfig.json
│
├── src/
│   ├── scraper/                  ← 쓰레드/scripts에서 이관 + 리팩토링
│   │   ├── login.ts                   (login-threads.ts 기반, 100%)
│   │   ├── discover.ts                (discover-channels.ts 기반, 90%)
│   │   ├── collect.ts                 (collect-posts.js → TS 전환, 80%)
│   │   └── orchestrator.ts            (orchestrate-crawl.ts → daemon, 60%)
│   │
│   ├── agents/                   ← 쓰레드/agents 이관 (90% 그대로)
│   │   ├── researcher.md              [2] 리서처 (Opus)
│   │   ├── needs-detector.md          [3] 니즈탐지 (Opus)
│   │   ├── product-matcher.md         [4] 상품매칭 (Sonnet)
│   │   ├── positioning.md             [5] 포지셔닝 (Sonnet)
│   │   ├── content.md                 [6] 콘텐츠 (Sonnet)
│   │   └── performance.md             [7] 성과분석 (Opus) + 진단 확장
│   │
│   ├── publisher/                ← 신규
│   │   ├── poster.ts                  Playwright CDP로 Threads UI 직접 포스팅
│   │   ├── account-manager.ts         계정 관리 (1개→추후 10개 확장)
│   │   ├── scheduler.ts              발행 스케줄러 (자연스러운 간격)
│   │   └── warmup.ts                 워밍업 (처음 20개 제휴링크 없이 발행)
│   │
│   ├── tracker/                  ← 신규
│   │   ├── snapshot.ts                6h/48h/7d 스냅샷 수집 (cron)
│   │   ├── metrics.ts                 velocity 계산 + 분류 (TOP/BOTTOM)
│   │   └── diagnosis.ts              병목 역추적 + 튜닝 제안
│   │
│   ├── db/                       ← 신규 (JSON → PostgreSQL)
│   │   ├── schema.ts                  Drizzle 스키마
│   │   └── migrations/                마이그레이션 파일
│   │
│   └── types.ts                  ← 쓰레드/scripts/types.ts 확장
│                                      (Account, Snapshot, Diagnosis 타입 추가)
│
├── data/
│   ├── product_dict/             ← 쓰레드에서 이관
│   │   └── products_v1.json
│   └── raw_posts/                ← 기존 수집 데이터 (선택적 이관)
│
└── scripts/
    └── migrate-v1-data.ts        ← v1 JSON → DB 마이그레이션 도구
```

---

## 5. 핵심 아키텍처 결정사항

### 5.1 빌드 도구

- **Claude Code만 사용** (API 비용 최소화)
- Paperclip: 빌드 단계에서는 사용 안 함. Phase 3 운영 단계에서 10개 계정 에이전트 관리 시 도입 고려

### 5.2 LangGraph 판단

| 선택지 | 설명 | 추천 |
|--------|------|------|
| A. 전체 LangGraph | 스크래핑/포스팅까지 전부 | ❌ non-LLM 작업에 오버헤드 |
| B. 하이브리드 | ②→③→④ LLM 체인만 LangGraph, 나머지 스크립트 | ⭕ Phase 2에서 |
| C. 직접 구현 | LangGraph 없이 Worker + Queue + DB | ⭕ Phase 1에서 |

**결론: Phase 1은 C(직접 구현), Phase 2에서 B(하이브리드)로 전환 고려**

### 5.3 하이브리드 아키텍처 (Phase 2 목표)

```
┌─ Worker (스크립트) ──────────────────────────────┐
│  ① 수집 (Playwright cron)                        │
│  → 새 포스트를 DB/큐에 적재                       │
└──────────────────────┬───────────────────────────┘
                       ↓ 트리거
┌─ LangGraph ──────────┴───────────────────────────┐
│  ② 분석 → ③ 매칭 → ④ 생성                        │
│  (State: post → need → product → content)        │
│  (조건부: confidence 낮으면 스킵)                  │
│  (Checkpoint: 실패 시 재시도)                     │
│  → 완성된 콘텐츠를 발행 큐에 적재                  │
└──────────────────────┬───────────────────────────┘
                       ↓
┌─ Worker (스크립트) ──┴───────────────────────────┐
│  ⑤ 발행 (계정별 스케줄러)                         │
│  ⑥ 추적 (6h/48h/7d 스냅샷 cron)                 │
│  ⑦ 진단 (주간: LangGraph 별도 그래프 호출)        │
└──────────────────────────────────────────────────┘
```

### 5.4 측정 지표: 스크립트 vs AI 역할 분리

- **80% 스크립트** (SQL 쿼리 + 단순 계산, 비용 0원): CTR, 전환율, 시간대별 성과, 계정 상태 등
- **20% AI** (의미 판단 필요한 것만): 주제 적합도, 니즈 사후 검증, 성공/실패 패턴 분석
- 예상 AI 진단 비용: ~$1.7/월

---

## 6. 포스트 성숙도 모델

절대값이 아닌 **속도 기반 지표**(engagement_velocity, click_velocity 등)로 비교.

| 단계 | 기간 | 용도 |
|------|------|------|
| warmup | 0~6h | 판단 불가, 데이터 수집만 |
| early | 6~48h | 초기 신호 스냅샷 (예측용) |
| mature | 48h~7d | 비교 가능 시점 → 주간 분석 대상 |
| final | 7d+ | 최종 성과 확정 |

**규칙:**
- mature(48h+) 포스트만 주간 비교 대상에 포함
- 목~일 게시분은 다음 주 리포트에 포함 (mature 미도달)

### 속도 기반 지표

```
engagement_velocity = (likes + comments + shares) / age_hours
click_velocity      = clicks / age_hours
conversion_velocity = conversions / age_hours
```

### 초기 신호 (early_signal)

포스트 성과는 보통 처음 6시간에 80%가 결정됨.

```
early_signal (6h 시점 스냅샷)
├─ early_likes        ← 6h 시점 좋아요 수
├─ early_click_rate   ← 6h 시점 CTR
└─ early_save_rate    ← 6h 시점 저장률

→ 48h mature 데이터와 비교해서 예측 정확도 검증
→ 예측이 맞으면 빠른 의사결정 가능
```

---

## 7. 샘플링 전략

### 볼륨 추정

```
10개 계정 × 하루 3~5개 포스트 = 30~50개/일 = 210~350개/주
```

### 전수 스크립트 + AI 선별 분석

```
매일 (스크립트, 비용 0원)
├─ 전체 포스트 지표 자동 수집 (전수)
├─ 6h / 48h / 7d 스냅샷 자동 저장
└─ engagement_velocity 기준 자동 분류
   ├─ TOP 10%
   ├─ BOTTOM 10%
   └─ MIDDLE 80%

주간 (AI 분석, ~$0.30/주)
├─ 대상: mature(48h+) 포스트 중 TOP 10% + BOTTOM 10% (~60~70개)
├─ 코호트 분리: 같은 주 게시 포스트끼리만 비교
├─ AI 프롬프트: "TOP과 BOTTOM의 차이를 분석해줘"
│   ├─ 니즈 추출이 달랐나?
│   ├─ 상품 매칭이 달랐나?
│   ├─ 콘텐츠 스타일이 달랐나?
│   └─ 발행 시간/계정이 달랐나?
└─ 출력: 다음 주 파이프라인 튜닝 제안

월간 (AI 종합 진단, ~$0.50/월)
├─ 전체 통계 + 샘플 → 종합 진단 보고서
├─ 파이프라인 개선 우선순위
└─ 상품 DB 정리 제안
```

---

## 8. 진단 엔진 (병목 역추적)

### 단계별 측정 지표

| 단계 | 지표 | 방식 |
|------|------|------|
| ① 수집 | source_engagement, relevance_score, freshness | 스크립트 + AI(적합도) |
| ② 분석 | need_confidence, false_positive_rate | 스크립트 + AI(사후검증) |
| ③ 매칭 | CTR, product_relevance, category_conversion | 스크립트 + AI(적합도) |
| ④ 콘텐츠 | engagement_rate, save_rate, cta_click_rate | 스크립트 + AI(패턴분석) |
| ⑤ 발행 | reach, best_time_hit, account_health, ban_rate | 스크립트 |
| ⑥ 최종 | conversion, revenue, ROI | 스크립트 |

### 병목 판별 로직

```
수익 낮음
├─ 도달 낮음?          → 발행 문제 (시간대/계정 제한)
├─ CTR 낮음?           → 콘텐츠 or 매칭 문제
│   ├─ product_relevance 높음? → 콘텐츠 문제 (글 스타일 변경)
│   └─ product_relevance 낮음? → 매칭 문제 (매칭 로직 수정)
├─ CTR 정상 + 전환 낮음? → 상품 자체 문제 (가격/리뷰/신뢰도)
└─ 전체 저조?          → 수집 문제 (필터 강화)
```

### 자동 튜닝 액션

| 진단 결과 | 튜닝 액션 |
|-----------|----------|
| 수집 문제 | 최소 engagement 임계값 조정, 수집 키워드/채널 추가/제거 |
| 분석 문제 | 니즈 추출 프롬프트 수정, confidence 임계값 조정 |
| 매칭 문제 | 전환율 낮은 상품 비활성화, 높은 카테고리 가중치 상향 |
| 콘텐츠 문제 | 성공 포스트 스타일 분석 → 생성 프롬프트 반영, A/B 테스트 |
| 발행 문제 | 시간대별 최적 스케줄 업데이트, 부진 계정 교체 우선순위 |

---

## 9. DB 스키마

### 엔티티

```
ThreadPost        — 수집된 원본 포스트
Need              — 추출된 니즈 (카테고리, 신뢰도)
Product           — 제휴 상품 DB
AffContent        — 생성된 제휴 콘텐츠
Account           — 10개 발행 계정 관리
PostSnapshot      — 6h/48h/7d 성과 스냅샷
ContentLifecycle  — 전체 라이프사이클 추적 (수집~수익)
DiagnosisReport   — 주간/월간 진단 결과
```

### v1 JSON → DB 매핑

| v1 JSON | DB 테이블 | 비고 |
|---------|-----------|------|
| `raw_posts/*.json` | ThreadPost | thread_units → 행 단위 |
| `briefs/*_research.json` | Need (일부) | 구매신호 → 니즈 |
| `briefs/*_products.json` | Product 매칭 결과 | ContentLifecycle과 연결 |
| `briefs/*_content_drafts.json` | AffContent | 콘텐츠 초안 |
| `product_dict/products_v1.json` | Product | 상품 마스터 |
| `learnings/latest.json` | DiagnosisReport | Learning Deltas |
| `seen_posts.json` | ThreadPost.post_id (UNIQUE) | 중복 제거 |
| `discovered_channels.json` | (별도 Channel 테이블) | 채널 메타 |
| `threads-watch-checkpoint.json` | (별도 CrawlSession 테이블) | 수집 상태 |

---

## 10. Phase 계획

### Phase 1 — 코드 이관 + DB 전환 + 파이프라인 검증

```
목표: 기존 코드를 쓰레드2 구조로 이관하고, DB 기반으로 전환 후 수익 검증
구현: C (직접 구현, LangGraph 없이)

Step 1: 코드 이관 + 정리
├─ scripts/ → src/scraper/ (TS 통일)
├─ agents/ → src/agents/ (그대로)
├─ types.ts 확장 (Account, Snapshot, Diagnosis 타입 추가)
└─ collect-posts.js → collect.ts (TypeScript 전환)

Step 2: DB 도입
├─ JSON 구조 → Drizzle 스키마
├─ 기존 데이터 마이그레이션 스크립트 (migrate-v1-data.ts)
└─ Supabase 또는 로컬 PGlite

Step 3: 수익 검증
├─ 1개 계정으로 수동 포스팅 테스트
├─ 기본 성과 추적 (수동)
└─ 결과: 수익 가능성 판단
```

### Phase 2 — 자동화 (수익 검증 후)

```
목표: 24/7 자동 운영
구현: B (하이브리드 — LLM 체인만 LangGraph)

Step 4: 추적 시스템 (신규)
├─ 스냅샷 수집기 (snapshot.ts, cron)
├─ velocity 지표 계산 (metrics.ts)
└─ 진단 엔진 (diagnosis.ts, performance.md 확장)

Step 5: 발행 시스템 (신규)
├─ 자동 포스팅 (poster.ts, Playwright CDP로 Threads UI 직접 조작)
├─ 워밍업 (warmup.ts, 처음 20개 제휴링크 없이 일반 콘텐츠 발행)
├─ 계정 매니저 (account-manager.ts, 1개 계정으로 시작)
└─ 스케줄러 (scheduler.ts, 자연스러운 간격)

Step 6: 24/7 자동화
├─ orchestrator → daemon 패턴
├─ ②→③→④ LangGraph 그래프 전환 (선택)
├─ cron 설정 (수집/스냅샷/진단)
└─ VPS 배포
```

### Phase 3 — 스케일 (자동화 안정화 후)

```
목표: 10개 계정 + 자가 개선 + 모니터링
구현: B + Paperclip 도입 고려

Step 7: 10개 계정 스케일
├─ 1개 → 10개 계정 확장
├─ 계정 로테이션 자동화 (생성→운영→폐기)
├─ 프록시/fingerprint 인프라 (10개 계정 시 필요)

Step 8: 자가 개선 루프
├─ 주간 TOP/BOTTOM 10% AI 분석 자동화
├─ 진단 → 튜닝 자동 반영
└─ A/B 테스트 프레임워크

Step 9: 대시보드 + 운영
├─ 실시간 수익/계정 상태/진단 결과
├─ 모바일 접근 가능
└─ Paperclip 도입으로 에이전트 관리 (선택)
```

---

## 11. 기술적 난이도 (높은 순)

| 순위 | 항목 | 난이도 | 핵심 이슈 |
|------|------|--------|----------|
| 1 | 계정 자동 생성 | 매우 높음 | 전화번호 인증, CAPTCHA |
| 2 | 10개 계정 운영 | 매우 높음 | IP/fingerprint/행동패턴 분리 |
| 3 | 쓰레드 스크래핑 | 높음 | 공식 API 없음, 반봇 감지 강함 (기존 해결) |
| 4 | 자동 포스팅 | 높음 | 봇 감지 회피, 자연스러운 패턴 |
| 5 | 니즈 분석 | 중간 | 프롬프트 튜닝 필요 (기존 완성) |
| 6 | 제품 매칭 | 중간 | 상품 DB 구축이 관건 (기존 ~50개) |
| 7 | 콘텐츠 생성 | 낮음 | LLM 강점 영역 (기존 완성) |

---

## 12. 아직 구체화 필요한 항목

| 단계 | 미정 사항 | 기존 자산 |
|------|----------|----------|
| ① 수집 | 24/7 상시 스크래핑 구조 | 기존: 수동 트리거, 채널 28키워드 |
| ② 분석 | — | **완성** (프롬프트/카테고리 체계 모두 있음) |
| ③ 매칭 | 제휴 상품 DB 소스 확대 (쿠팡 외?), 매칭 로직 개선 | 기존: ~50개 상품, 5-Criteria 채점 |
| ④ 생성 | — | **완성** (6포맷, 훅 5타입, AI 말투 탐지) |
| ⑤ 발행 | Playwright CDP 포스팅 구현. 워밍업 20개 후 제휴 시작. 프록시는 Phase 3(10개 계정)에서 | login.ts 패턴 재활용 |
| ⑥ 추적 | 제휴 플랫폼의 전환 데이터 수집 방법 | 없음 (신규) |
| ⑦ 진단 | — | 기존 performance.md에서 확장 |

---

## 13. 비용 추정

| 항목 | 월 비용 |
|------|--------|
| LLM API (니즈 분석 + 콘텐츠 생성) | 기존 v1 수준 유지 (opus 2회 + sonnet 4회/사이클) |
| LLM API (진단) | ~$1.7 |
| VPS (24/7 운영) | Phase 2부터 |
| 프록시 | Phase 3부터 (10개 계정 시) |
| 전화번호 서비스 | Phase 3부터 |

---

## 14. 기존 v1 에이전트 상세 (참조)

### 모델 라우팅

```
수집 에이전트     → haiku   (비용 최소)
분류 에이전트 ×4  → sonnet  (속도)
분석 에이전트 ×2  → opus    (추론 깊이)
```

### 에이전트별 핵심 스펙

| 에이전트 | 모델 | 핵심 기능 |
|----------|------|----------|
| [2] 리서처 | Opus | 구매신호 L1-L5 추출, 트렌드 방향 판단, Self-verification |
| [3] 니즈탐지 | Opus | 6개 욕구 유형, Threads 적합도 1-5점, MECE 검증 |
| [4] 상품매칭 | Sonnet | 5-Criteria 채점, novelty_bonus, 니즈당 3개 선택 |
| [5] 포지셔닝 | Sonnet | 6가지 포맷, angle/tone/hook/avoid/cta 설계 |
| [6] 콘텐츠 | Sonnet | 본문 3개 + 훅 5개 + 셀프댓글, AI 말투 탐지 |
| [7] 성과분석 | Opus | Learning Deltas [-2,+2], 신뢰 수준 3단계 |

### 6개 욕구 유형 (기존 체계)

```
1. 불편해소 — 현재 고통 제거
2. 시간절약 — 귀찮은 걸 빠르게
3. 돈절약   — 가성비, 더 싸게
4. 성과향상 — 더 잘하고 싶음
5. 외모건강 — 더 나아보이고 싶음
6. 자기표현 — 취향/정체성
```

### 6가지 콘텐츠 포맷 (기존 체계)

```
1. 문제공감형    — "이 문제 나만 겪는 줄 알았는데"
2. 솔직후기형    — "광고 아니고, 돈 주고 써본 기준"
3. 비교형        — "3개 써봤는데 1개만 남김"
4. 입문추천형    — "이쪽 처음이면 이거부터"
5. 실수방지형    — "이거 사기 전에 이것만 확인해"
6. 비추천형      — "솔직히 이건 별로였고, 대신 이게 나았음"
```

---

## 15. 참고

- **기존 프로젝트**: `workspace/쓰레드/` (v1 — 수집+분석+콘텐츠 완성)
- **기존 스킬**: `threads-watch`, `threads-analyze`
- **MiroFish**: 군집 지능 시뮬레이션 엔진 — 참고용 (다른 용도)
- **Paperclip**: AI 개발팀 오케스트레이션 — Phase 3에서 고려
- **기존 데이터**: raw_posts 1.8MB, 제휴상품 ~50개, Google Sheets 연동
