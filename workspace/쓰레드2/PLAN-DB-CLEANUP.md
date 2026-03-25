# PLAN: DB 정리 + 에이전트 친화적 구조 v3

> 작성일: 2026-03-24
> 검증: 9개 병렬 에이전트 (DB 실사, 코드 정밀, 에이전트/스킬, 폴더구조, 비판적 리뷰, 운영흐름, 라인검증, View설계, 최종비평)
> 목표: **에이전트가 복잡한 JOIN 없이 간단한 SELECT로 데이터에 접근**할 수 있는 구조
> 원칙: View로 추상화 → 코드 단순화 → 가이드 동기화 → 검증
> 참조: 데이터베이스_개념정리.txt (개념 3,7,8,11,12번 적용)

---

## v2 → v3 변경사항

| 추가 | 근거 (DB 개념문서) |
|------|------------------|
| 에이전트용 View 7개 설계 | 개념 11번: "자주 쓰는 복잡한 쿼리를 이름 붙여서 저장" |
| 인덱스 3개 추가 | 개념 3번: "DB에서 데이터를 빨리 찾기 위한 목차" |
| Phase 5 트랜잭션 래핑 | 개념 8번: "전부 성공하거나 전부 실패" |
| Phase B 전 백업 | 개념 12번: "대량 삭제 전에 백업" |
| BiniLab 운영 흐름 매핑 | 에이전트별 DB 접근 패턴 가시화 |
| 콜드 스타트 검증 추가 | content_lifecycle 48h 필터 시 0행 가능 |

---

## BiniLab 일일 운영 흐름 + 데이터 경로

```
Phase 1: 준호(수집)
  collect.ts → thread_posts (post_source='benchmark')
  collect-by-keyword.ts → thread_posts (post_source='keyword_search')
  trend-fetcher.ts → trend_keywords
  research-brands.ts → brands, brand_events
  collect-youtube-comments.ts → youtube_videos, community_posts
  ┌────────────────────────────────────┐
  │ gatePhase1(): thread_posts 24h > 0 │
  └────────────────────────────────────┘

Phase 2: 서연(분석)
  thread_posts → 카테고리별 avg_views, engagement_rate 집계
  content_lifecycle → 다양성 체크 (포맷/카테고리 편중)
  post_snapshots → TOP/BOTTOM 포스트 비교
  → agent_messages로 민준에게 보고
  ┌──────────────────────────────────────────────┐
  │ gatePhase2(): seoyeon의 오늘자 분석 메시지 존재 │
  └──────────────────────────────────────────────┘

Phase 3: 민준(CEO)
  서연 보고 + brand_events(유효) + experiments(active) + diversity 경고
  → directive 생성 (카테고리 배분, 소재 선택, 실험 설계)
  → agent_messages로 에디터에게 배포
  ┌──────────────────────────────────────────────┐
  │ gatePhase3(): minjun의 오늘자 directive 메시지  │
  └──────────────────────────────────────────────┘

Phase 4: 에디터(빈이/하나/소라/지우)
  directive + brand_events + needs → 포스트 초안 작성
  → 도윤(QA) 검증 (톤/글자수/CTA/이미지)
  → 통과 시 aff_contents INSERT (status='ready')

Phase 5: Safety Gates + 게시
  gates.ts 8개 체크 → 통과 시 게시
  content_lifecycle 업데이트 (threads_post_id, posted_at)
  brand_events.is_used = true
```

### 에이전트별 DB 접근 — 현재 문제점

| 에이전트 | 자주 하는 조회 | 현재 복잡도 | View 적용 후 |
|---------|-------------|-----------|-------------|
| 서연 | 카테고리별 ROI | `content_lifecycle GROUP BY + CASE WHEN 계산` | `SELECT * FROM v_category_performance` |
| 서연 | 이번주 vs 지난주 | `2개 서브쿼리 + 비율 계산` | `SELECT * FROM v_weekly_growth` |
| 서연 | TOP/BOTTOM 포스트 | `content_lifecycle JOIN post_snapshots LATERAL` | `SELECT * FROM v_post_ranking ORDER BY rank_by_views` |
| 민준 | 유효 브랜드 소재 | `brands JOIN brand_events WHERE stale=false AND used=false AND expires_at>=NOW()` | `SELECT * FROM v_brand_radar` |
| 준호 | 수집 현황 | `thread_posts GROUP BY post_source, DATE(crawl_at)` | `SELECT * FROM v_collection_status` |
| 준호 | 채널 점수표 | `channels LEFT JOIN thread_posts GROUP BY + 점수 공식` | `SELECT * FROM v_channel_scorecard` |
| 민준 | 일별 수익 | `revenue_tracking GROUP BY tracked_date + SUM` | `SELECT * FROM v_daily_revenue` |

**핵심**: View를 만들면 에이전트가 ops 문서의 SQL 템플릿을 **JOIN 없이 단순 SELECT**로 대체 가능.

---

## DB 실사 결과 (2026-03-24 실측)

| 테이블 | 행 수 | 핵심 상태 |
|--------|-------|----------|
| thread_posts | **1,374** | 기타 735(53%), NULL 30, 미분석 789(57%), primary_tag: general 753 + NULL 621 |
| post_snapshots | 38 | 성과 데이터 부족 |
| content_lifecycle | 16 | |
| aff_contents | 19 | status 컬럼 **이미 존재** (default='draft') |
| needs | 73 | |
| brands | 43 | 컬럼명 `name` 사용 중 (brand_name 아님) |
| brand_events | 85 | stale 78(92%), used **0** |
| channels | 29 | verified만 남음 |
| agent_messages | 33 | |
| trend_keywords | 597 | selected 7, posts_collected **0** |
| daily_performance_reports | 1 | |
| youtube_channels | 49 | |
| youtube_videos | 67 | |
| community_posts | 39 | |
| thread_comments | 343 | |
| products | **2** | fallback 불가 수준 |
| experiments | 0 | |
| revenue_tracking | 0 | |
| accounts | 0 | |
| crawl_sessions | 0 | |
| diagnosis_reports | 0 | |
| source_performance | 0 | |
| tuning_actions | 0 | |

**schema.ts ↔ 실제 DB**: 23개 테이블 완전 일치. 추가/누락 없음.

---

## v1 PLAN의 오류 (v2에서 수정)

| v1 주장 | 실제 | 수정 |
|---------|------|------|
| aff_contents에 status 없음 → 마이그레이션 필요 | **이미 존재** (schema.ts line 380, DB 확인) | Step 1a 삭제 |
| brands에 brand_name vs name 불일치 | DB에 `name`만 존재, `brand_name` 어디에도 없음 | Issue 3 재작성 |
| daily-standup-ops.md에 brand_name 참조 | 실제 없음. 대신 `collected_at`, `username`, `content`, `category` 오류 | 실제 오류로 교체 |
| classifyByText() 추가 필요 | **이미 구현됨** (line 218-238, TEXT_KEYWORDS ~200개) | 보강으로 변경 |
| topic-classifier가 analyzed_at 업데이트 | **하지 않음** (topic_category만 UPDATE) | 수정 코드 추가 |
| drizzle/migrations/ 경로 | 실제: `src/db/migrations/` | 경로 수정 |
| daily-pipeline.ts는 데이터만 정리하면 됨 | **4개 컬럼 참조 오류로 실행 자체 불가** | 최우선 이슈 추가 |

---

## 이슈 목록 (우선순위순)

### 🔴 Issue 0 (NEW): daily-pipeline.ts 컬럼 참조 오류 — 파이프라인 실행 불가

**현재 상태**: `fetchPhase2Data()`와 리사이클 쿼리가 schema.ts에 없는 컬럼을 참조 → SQL 에러

| 코드 위치 | 사용 중인 컬럼 | 실제 스키마 컬럼 | 수정 |
|-----------|-------------|---------------|------|
| fetchPhase2Data() ~line 103 | `thread_posts.is_published` | ❌ 없음 | content_lifecycle.threads_post_id IS NOT NULL로 대체 |
| fetchPhase2Data() ~line 103 | `thread_posts.published_at` | ❌ 없음 | content_lifecycle.posted_at 사용 |
| fetchPhase2Data() ~line 103 | `thread_posts.category` | `topic_category` | 컬럼명 수정 |
| fetchPhase2Data() ~line 112 | `brand_events.valid_until` | `expires_at` | 컬럼명 수정 |
| 리사이클 쿼리 ~line 216 | `thread_posts.is_published` | ❌ 없음 | content_lifecycle JOIN으로 변경 |
| 리사이클 쿼리 ~line 221 | `thread_posts.id` | `post_id` | 컬럼명 수정 |

**영향받는 컴포넌트**:
- `/daily-run` Phase 2~3 전체 (CEO 스탠드업, ROI 계산, 카테고리 배분)
- `/daily-run` Phase 5 리사이클 후보 선정
- 민준(CEO) 에이전트의 directive 생성

**구체적 수정**:

```typescript
// fetchPhase2Data() 수정 — 기존 (실행 불가)
// WHERE tp.is_published = true
//   AND tp.published_at >= NOW() - INTERVAL '48h'
//   AND tp.category IS NOT NULL

// 수정안: content_lifecycle JOIN으로 "우리가 게시한 포스트" 식별
const phase2 = await db.execute(sql`
  SELECT
    tp.topic_category as category,
    AVG(tp.view_count) as avg_views,
    AVG(tp.like_count) as avg_likes,
    COUNT(*) as post_count
  FROM content_lifecycle cl
  JOIN thread_posts tp ON cl.threads_post_id = tp.post_id
  WHERE cl.posted_at >= NOW() - INTERVAL '48 hours'
    AND cl.posted_at < NOW() - INTERVAL '24 hours'
    AND tp.topic_category IS NOT NULL
  GROUP BY tp.topic_category
`);

// brand_events 수정
const brandEventCount = await db.execute(sql`
  SELECT COUNT(*) as cnt FROM brand_events
  WHERE is_stale = false AND is_used = false
    AND expires_at >= NOW()
`);

// 리사이클 후보 수정
const recycleCandidates = await db.execute(sql`
  SELECT tp.post_id
  FROM content_lifecycle cl
  JOIN thread_posts tp ON cl.threads_post_id = tp.post_id
  WHERE cl.posted_at <= NOW() - INTERVAL '14 days'
  ORDER BY tp.view_count DESC
  LIMIT 5
`);
```

---

### 🔴 Issue 0b (NEW): daily-pipeline.ts Phase 5 aff_contents INSERT 스키마 오류

**현재 상태**: Phase 5 INSERT가 schema.ts에 없는 컬럼 사용

| 코드 ~line 615-625 | 실제 스키마 |
|---------------------|-----------|
| `category` | ❌ 없음 → `format` (positionFormatEnum) |
| `editor_agent` | ❌ 없음 → 삭제 (agent_messages로 추적) |
| `scheduled_time` | ❌ 없음 → 삭제 (content_lifecycle.posted_at으로 관리) |
| `brief` | ❌ 없음 → `positioning` |

**구체적 수정**:
```typescript
// Phase 5: aff_contents INSERT 수정
await db.insert(affContents).values({
  id: crypto.randomUUID(),
  product_id: matched.product_id,
  need_id: matched.need_id,
  format: directive.format,        // was: category
  hook: content.hook,
  bodies: content.bodies,
  positioning: directive.brief,    // was: brief
  status: 'ready',                 // 이미 존재하는 컬럼
  content_source: 'daily_pipeline',
});
```

---

### 🟡 Issue 1: topic_category 53%가 '기타'

**현재 상태**: 1,374개 중 735개(53%) '기타', 30개 NULL
**원인**: TAG_MAP ~110개 + TEXT_KEYWORDS ~200개로도 부족

**classifyByText()는 이미 존재** (topic-classifier.ts line 218-238). 추가가 아니라 **보강**.

**영향받는 컴포넌트**: (v1과 동일)
- daily-pipeline.ts fetchPhase2Data() — 카테고리별 집계 왜곡
- `/threads-plan` — 기회점수 부정확
- `/analyze-performance` — 카테고리 비교 무의미
- diversity-checker.ts — 편중 경고 부정확

**구체적 수정**:
```
1. 기타 735개 중 랜덤 100개 텍스트 읽기
2. 빈도 높은 미분류 주제 파악 (예: 반려동물, 자동차, 여행, 교육 등)
3. TEXT_KEYWORDS에 해당 카테고리 키워드 추가
4. 필요시 새 카테고리 추가 (topic_category는 text 타입이라 enum 제약 없음)
5. 재분류 실행:
   - npx tsx -e "import { classifyTopics } from './src/analyzer/topic-classifier.js'; classifyTopics(2000, true)"
   - includeEtc=true 필수 ('기타' 포스트도 재분류 대상에 포함)
   - limit=2000 (전체 포스트 커버)
```

**목표**: 기타 53% → 20% 이하

---

### 🟡 Issue 2: thread_posts 57% 미분석 (analyzed_at = NULL)

**현재 상태**: 789개 analyzed_at NULL
**문제**: topic-classifier.ts가 `analyzed_at`을 업데이트하지 않음 (topic_category만 UPDATE)

**구체적 수정**:
```typescript
// src/analyzer/topic-classifier.ts classifyTopics() 내부 수정
// 기존: .set({ topic_category: category })
// 수정:
.set({
  topic_category: category,
  analyzed_at: new Date(),  // 분류 완료 시점 기록
})
```

이 수정 후 Issue 1의 재분류 실행 시 analyzed_at도 동시에 업데이트됨.

**테스트 추가**:
```typescript
// src/__tests__/topic-classifier.test.ts
it('should update analyzed_at when classifying', async () => {
  // INSERT test post with analyzed_at = null
  // Run classifyTopics()
  // Assert analyzed_at is not null
});
```

---

### 🟡 Issue 3: primary_tag 미세분화

**현재 상태**: general 753 + NULL 621 = 실질 태그 0개
**원인**: primary_tag 분류 코드가 topic-classifier에 없음

**구체적 수정**:
```typescript
// src/analyzer/topic-classifier.ts에 추가
export function classifyPrimaryTag(text: string, linkUrl?: string | null): string {
  const lower = text.toLowerCase();

  // 제휴 링크 감지
  if (linkUrl && /coupang|coupa\.ng|link\.coupang/.test(linkUrl)) return 'affiliate';

  // 구매 신호
  if (/추천해|살까|어디서.*사|비교|뭐가.*나을|골라/.test(lower)) return 'purchase_signal';

  // 리뷰
  if (/후기|리뷰|솔직|써봤|써보니|사용해보니/.test(lower)) return 'review';

  // 불만
  if (/실망|짜증|불편|별로|최악|환불/.test(lower)) return 'complaint';

  // 관심
  if (/궁금|알려줘|어때|좋을까/.test(lower)) return 'interest';

  return 'general';
}
```

**classifyTopics() 수정**: primary_tag도 동시 업데이트
```typescript
.set({
  topic_category: category,
  primary_tag: classifyPrimaryTag(post.text, post.link_url),
  analyzed_at: new Date(),
})
```

---

### 🟡 Issue 4: brand_events 전부 미사용 (is_used = 0)

**현재 상태**: 85건 중 stale 78, used 0

**구체적 수정**:
```typescript
// src/orchestrator/daily-pipeline.ts Phase 5 — 게시 후 이벤트 마킹
// aff_contents INSERT 이후:
if (directive.source_brand_event_id) {
  await db.update(brandEvents)
    .set({ is_used: true })
    .where(eq(brandEvents.event_id, directive.source_brand_event_id));
}
```

---

### 🟡 Issue 5: 트렌드 키워드 수집 미연결

**현재 상태**: selected=7, posts_collected 전부 0
**원인 2가지**:
1. collect-by-keyword.ts에 `post_source` 태깅 없음
2. run-trend-pipeline.ts가 `--source x_trend` 전달 안 함

**구체적 수정**:

```typescript
// scripts/collect-by-keyword.ts — INSERT에 post_source 추가
// 기존 (~line 551):
// post_source 없음

// 수정: CLI 파라미터 추가
const source = args.includes('--source') ?
  args[args.indexOf('--source') + 1] : 'keyword_search';

// threadPosts INSERT에 추가:
post_source: source as any,
```

```typescript
// scripts/run-trend-pipeline.ts ~line 127 — 호출 시 --source 전달
// 기존:
// npx tsx scripts/collect-by-keyword.ts --keywords ...

// 수정:
// npx tsx scripts/collect-by-keyword.ts --keywords ... --source x_trend
```

```typescript
// scripts/run-trend-pipeline.ts Step 4 — posts_collected 업데이트 쿼리 수정
// 기존 (~line 160): run_id LIKE 'search_%'로만 식별
// 수정: post_source = 'x_trend' 조건 추가
const cnt = await db.execute(sql`
  SELECT COUNT(*) FROM thread_posts
  WHERE post_source = 'x_trend'
    AND crawl_at >= ${todayStart}
    AND text ILIKE ${'%' + keyword + '%'}
`);
```

---

### 🟡 Issue 6: 성과 리포트 1건만

**수정 불필요** — 실행만 하면 됨.
- `track-performance.ts` 매일 실행
- `/analyze-performance` 매일 실행
- 향후 cron 자동화

단, `track-performance.ts`에서 threadPosts INSERT 시 `post_source` 태깅 추가:
```typescript
// ~line 256: post_source 없음 → 추가
post_source: 'benchmark' as any,  // 우리 포스트는 benchmark 소스
```

---

### 🟢 Issue 7 (NEW): daily-standup-ops.md SQL 컬럼 전면 오류

**현재 상태**: SQL 템플릿이 4곳에서 잘못된 컬럼명 사용

| ops 위치 | 사용 중 | 실제 스키마 |
|---------|--------|-----------|
| ~line 80 | `category` | `topic_category` |
| ~line 85 | `collected_at` | `crawl_at` |
| ~line 96 | `username` | `author` |
| ~line 97 | `content` | `text` |
| ~line 120 | `be.valid_until` | `be.expires_at` |

---

### 🟢 Issue 8 (NEW): nullable 불일치 (revenue_tracking, experiments)

**현재 상태**: schema.ts에서 `notNull()`이지만 DB에서 nullable

| 테이블 | 컬럼 | schema.ts | 실제 DB |
|--------|------|----------|--------|
| revenue_tracking | click_count | notNull().default(0) | nullable, default 0 |
| revenue_tracking | purchase_count | notNull().default(0) | nullable, default 0 |
| revenue_tracking | created_at | notNull() | nullable |
| experiments | autonomy_level | notNull().default(0) | nullable, default 0 |

**수정**: 마이그레이션으로 NOT NULL 제약 추가
```sql
-- src/db/migrations/XXXX_fix_nullable.sql
ALTER TABLE revenue_tracking ALTER COLUMN click_count SET NOT NULL;
ALTER TABLE revenue_tracking ALTER COLUMN purchase_count SET NOT NULL;
ALTER TABLE revenue_tracking ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE revenue_tracking ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE experiments ALTER COLUMN autonomy_level SET NOT NULL;
```

---

## 실행 순서 (의존성 기반, v3)

```
Phase A: 파이프라인 블로커 해소 + 에이전트용 View 생성
├─ A0. DB 백업 (개념 12번)
│   └─ supabase db dump -f backup_before_cleanup_$(date +%Y%m%d).sql
│
├─ A1. daily-pipeline.ts 컬럼 참조 전면 수정 [Issue 0, 0b]
├─ A2. daily-standup-ops.md SQL 컬럼 수정 [Issue 7]
├─ A3. 마이그레이션: nullable 수정 + View 생성 + 인덱스 추가 [Issue 8, NEW]
│   ├─ revenue_tracking/experiments NOT NULL 제약
│   ├─ View 4개 즉시 생성 (v_collection_status, v_brand_radar,
│   │   v_category_performance, v_weekly_growth)
│   └─ 인덱스 3개 추가 (topic_category, posted_at, need_category)
│
├─ A4. daily-pipeline.ts fetchPhase2Data()를 View 기반으로 단순화
│   └─ 복잡한 JOIN 쿼리 → SELECT * FROM v_... 로 교체
│
└─ A5. tsc --noEmit + npm test 통과 확인

Phase B: 데이터 분류 품질 올리기
├─ B0. DB 백업 (재분류 전, 개념 12번)
│   └─ 1,374행 대량 UPDATE 안전망
├─ B1. topic-classifier.ts 수정 [Issue 2, 3]
│   ├─ classifyTopics()에 analyzed_at 업데이트 추가
│   ├─ classifyPrimaryTag() 함수 추가
│   └─ 테스트 추가
├─ B2. TEXT_KEYWORDS 보강 [Issue 1]
│   ├─ 기타 735개 중 100개 샘플 분석
│   └─ 미분류 주제 키워드 추가
└─ B3. 전체 재분류 실행
    └─ classifyTopics(2000, true)

Phase C: 수집 소스 추적 연결 (B와 병렬 가능)
├─ C1. collect-by-keyword.ts에 --source 파라미터 + post_source 태깅 [Issue 5]
├─ C2. run-trend-pipeline.ts에서 --source x_trend 전달 [Issue 5]
├─ C3. track-performance.ts에 post_source='benchmark' 태깅 [Issue 6]
└─ C4. daily-pipeline.ts Phase 5에 brand_events.is_used (트랜잭션, 개념 8번) [Issue 4]

Phase D: 가이드/스킬 동기화 + 추가 View
├─ D1. /daily-run SKILL.md — Phase 5 INSERT 컬럼 + View 사용법 반영
├─ D2. ops/performance-ops.md — SQL을 View 기반으로 단순화
├─ D3. ops/daily-standup-ops.md — SQL을 View 기반으로 재작성
└─ D4. View 3개 추가 생성 (v_channel_scorecard, v_post_ranking, v_daily_revenue)

Phase E: 검증 + 데이터 축적
├─ E1. npm test (전체 통과)
├─ E2. tsc --noEmit (0 에러)
├─ E3. DB 검증 쿼리 (아래 참조)
├─ E4. 콜드 스타트 검증 (48h 이내 데이터 0행일 때 에러 없이 동작)
├─ E5. track-performance.ts 실행 (성과 축적 시작)
└─ E6. /analyze-performance 실행 (리포트 축적 시작)
```

**Phase B와 C는 병렬 실행 가능** (서로 의존성 없음)

---

## Phase별 수정 파일 목록

### Phase A: 파이프라인 블로커 해소 + View/인덱스 (최우선)

| # | 파일 | 수정 내용 | 라인 |
|---|------|---------|------|
| A0 | (CLI) | `supabase db dump -f backup_before_cleanup_$(date +%Y%m%d).sql` | - |
| A1-1 | `src/orchestrator/daily-pipeline.ts` | fetchPhase2Data() — is_published/published_at → content_lifecycle JOIN | ~92-125 |
| A1-2 | `src/orchestrator/daily-pipeline.ts` | fetchPhase2Data() — category → topic_category | ~96 |
| A1-3 | `src/orchestrator/daily-pipeline.ts` | fetchPhase2Data() — valid_until → expires_at | ~112 |
| A1-4 | `src/orchestrator/daily-pipeline.ts` | 리사이클 — is_published → content_lifecycle JOIN | ~213-221 |
| A1-5 | `src/orchestrator/daily-pipeline.ts` | 리사이클 — SELECT id → SELECT post_id | ~214 |
| A1-6 | `src/orchestrator/daily-pipeline.ts` | Phase 5 INSERT — category/editor_agent/scheduled_time/brief 수정 | ~614-626 |
| A2-1 | `ops/daily-standup-ops.md` | collected_at→crawl_at, username→author, content→text, category→topic_category, valid_until→expires_at | ~80-127 |
| A3-1 | `src/db/migrations/XXXX_views_indexes.sql` | View 4개 + 인덱스 3개 + nullable 수정 (통합 마이그레이션) | 신규 |
| A4-1 | `src/orchestrator/daily-pipeline.ts` | fetchPhase2Data()의 raw SQL → View 기반 SELECT로 단순화 | ~92-125 |

### Phase B: 데이터 분류 (A 완료 후)

| # | 파일 | 수정 내용 |
|---|------|---------|
| B1-1 | `src/analyzer/topic-classifier.ts` | classifyTopics() `.set()`에 `analyzed_at: new Date()` 추가 |
| B1-2 | `src/analyzer/topic-classifier.ts` | `classifyPrimaryTag()` 함수 추가 (export) |
| B1-3 | `src/analyzer/topic-classifier.ts` | classifyTopics() `.set()`에 primary_tag 추가 |
| B1-4 | `src/__tests__/topic-classifier.test.ts` | analyzed_at + primary_tag 테스트 추가 |
| B2-1 | `src/analyzer/topic-classifier.ts` | TEXT_KEYWORDS 보강 (기타 샘플 분석 후) |

### Phase C: 수집 소스 연결 (A 완료 후, B와 병렬 가능)

| # | 파일 | 수정 내용 |
|---|------|---------|
| C1-1 | `scripts/collect-by-keyword.ts` | --source CLI 파라미터 추가 (~line 534) |
| C1-2 | `scripts/collect-by-keyword.ts` | threadPosts INSERT에 post_source 필드 추가 (~line 540-554) |
| C2-1 | `scripts/run-trend-pipeline.ts` | collect-by-keyword 호출 시 --source x_trend 전달 (~line 127) |
| C2-2 | `scripts/run-trend-pipeline.ts` | Step 4 posts_collected 쿼리에 post_source 조건 추가 (~line 158-176) |
| C3-1 | `scripts/track-performance.ts` | threadPosts INSERT에 post_source='benchmark' 추가 (~line 243-257) |
| C4-1 | `src/orchestrator/daily-pipeline.ts` | Phase 5에 트랜잭션 래핑: aff_contents INSERT + brand_events.is_used (개념 8번) |

### Phase D: 가이드/스킬 + 추가 View

| # | 파일 | 수정 내용 |
|---|------|---------|
| D1-1 | `~/.claude/skills/daily-run/SKILL.md` | Phase 5 INSERT 컬럼 + View 사용법 반영 |
| D2-1 | `ops/performance-ops.md` | SQL 템플릿을 v_category_performance, v_post_ranking View 기반으로 단순화 |
| D3-1 | `ops/daily-standup-ops.md` | SQL 템플릿을 v_collection_status, v_brand_radar View 기반으로 재작성 |
| D4-1 | `src/db/migrations/XXXX_views_phase2.sql` | View 3개 추가 (v_channel_scorecard, v_post_ranking, v_daily_revenue) |

---

---

## NEW: 에이전트용 View 7개 (개념 11번 적용)

> "자주 쓰는 복잡한 쿼리를 이름 붙여서 저장한 가상 테이블.
>  원본이 바뀌면 자동으로 바뀜." — 데이터베이스_개념정리.txt

### Phase A3에서 즉시 생성 (4개)

**View 1: v_collection_status** — 준호(리서처)용 수집 현황
```sql
CREATE OR REPLACE VIEW v_collection_status AS
SELECT
  post_source,
  DATE(crawl_at) AS crawl_date,
  COUNT(*)::int AS collected,
  COUNT(*) FILTER (WHERE analyzed_at IS NOT NULL)::int AS analyzed,
  COUNT(*) FILTER (WHERE analyzed_at IS NULL)::int AS pending,
  COUNT(*) FILTER (WHERE primary_tag = 'purchase_signal')::int AS purchase_signals,
  COALESCE(ROUND(AVG(view_count)), 0)::int AS avg_views
FROM thread_posts
GROUP BY post_source, DATE(crawl_at);
-- 사용: SELECT * FROM v_collection_status WHERE crawl_date >= CURRENT_DATE - 7
```

**View 2: v_brand_radar** — 에디터/민준(CEO)용 쓸 수 있는 소재
```sql
CREATE OR REPLACE VIEW v_brand_radar AS
SELECT
  b.brand_id, b.name AS brand_name, b.category AS brand_category,
  e.event_id, e.event_type, e.title AS event_title,
  e.threads_relevance, e.urgency, e.expires_at,
  EXTRACT(DAY FROM e.expires_at - NOW())::int AS days_until_expiry
FROM brands b
JOIN brand_events e ON e.brand_id = b.brand_id
WHERE e.is_stale = false AND e.is_used = false AND e.expires_at >= NOW();
-- 사용: SELECT * FROM v_brand_radar ORDER BY urgency DESC, threads_relevance DESC
```

**View 3: v_category_performance** — 서연(분석가)/민준(CEO)용 카테고리별 ROI
```sql
CREATE OR REPLACE VIEW v_category_performance AS
SELECT
  need_category AS category,
  COUNT(*)::int AS post_count,
  COALESCE(ROUND(AVG(current_impressions)), 0)::int AS avg_views,
  COALESCE(MAX(current_impressions), 0)::int AS max_views,
  ROUND(COALESCE(AVG(current_impressions),0)/1000.0
    * COALESCE(AVG(CASE WHEN current_impressions > 0
        THEN current_clicks::numeric/current_impressions*100 ELSE 0 END), 0))::int AS roi_score
FROM content_lifecycle
WHERE posted_at IS NOT NULL
GROUP BY need_category;
-- 사용: SELECT * FROM v_category_performance ORDER BY roi_score DESC
```

**View 4: v_weekly_growth** — 민준(CEO)용 주간 성장률
```sql
CREATE OR REPLACE VIEW v_weekly_growth AS
WITH tw AS (
  SELECT COUNT(*)::int AS posts, COALESCE(SUM(current_impressions),0)::bigint AS views
  FROM content_lifecycle WHERE posted_at >= NOW() - INTERVAL '7 days'
), lw AS (
  SELECT COUNT(*)::int AS posts, COALESCE(SUM(current_impressions),0)::bigint AS views
  FROM content_lifecycle
  WHERE posted_at >= NOW() - INTERVAL '14 days' AND posted_at < NOW() - INTERVAL '7 days'
)
SELECT tw.posts, tw.views, lw.posts AS last_week_posts, lw.views AS last_week_views,
  CASE WHEN lw.views=0 THEN 0
    ELSE ROUND((tw.views-lw.views)::numeric/lw.views*100) END::int AS growth_pct
FROM tw, lw;
-- 사용: SELECT * FROM v_weekly_growth
```

### Phase D4에서 추가 생성 (3개)

**View 5: v_channel_scorecard** — 채널 평가 점수표
```sql
CREATE OR REPLACE VIEW v_channel_scorecard AS
SELECT c.channel_id, c.display_name, c.category, c.benchmark_status,
  COUNT(p.post_id)::int AS post_count,
  COALESCE(ROUND(AVG(p.view_count)),0)::int AS avg_views,
  ROUND((COALESCE(AVG(p.view_count),0)*0.4
    + COALESCE(AVG(CASE WHEN COALESCE(p.view_count,0)>0
        THEN (COALESCE(p.like_count,0)+COALESCE(p.reply_count,0))::numeric/p.view_count*100
        ELSE 0 END),0)*0.3
    + COUNT(p.post_id)*0.3)::numeric, 2)::float AS score
FROM channels c LEFT JOIN thread_posts p ON p.channel_id = c.channel_id
GROUP BY c.channel_id, c.display_name, c.category, c.benchmark_status;
```

**View 6: v_post_ranking** — 자체 포스트 성과 순위
```sql
CREATE OR REPLACE VIEW v_post_ranking AS
SELECT cl.id, cl.content_text, cl.content_style, cl.hook_type,
  cl.need_category, cl.posted_at, cl.maturity,
  cl.current_impressions AS views, cl.current_clicks AS clicks,
  RANK() OVER (ORDER BY cl.current_impressions DESC)::int AS rank_by_views
FROM content_lifecycle cl WHERE cl.posted_at IS NOT NULL;
```

**View 7: v_daily_revenue** — 일별 수익 (워밍업 완료 후 활성화)
```sql
CREATE OR REPLACE VIEW v_daily_revenue AS
SELECT tracked_date,
  SUM(click_count)::int AS clicks, SUM(purchase_count)::int AS purchases,
  SUM(revenue::numeric)::numeric(10,2) AS total_revenue,
  CASE WHEN SUM(click_count)>0
    THEN ROUND(SUM(purchase_count)::numeric/SUM(click_count)*100, 2) ELSE 0
  END::float AS conversion_pct
FROM revenue_tracking GROUP BY tracked_date;
```

### View 적용 효과

| 수정 전 (ops SQL 템플릿) | 수정 후 |
|------------------------|--------|
| `SELECT topic_category, AVG(view_count)... FROM content_lifecycle cl JOIN thread_posts tp ON... GROUP BY... HAVING...` | `SELECT * FROM v_category_performance` |
| `SELECT be.*, b.name FROM brand_events be JOIN brands b ON... WHERE be.is_stale=false AND be.is_used=false AND be.valid_until>=NOW()` | `SELECT * FROM v_brand_radar` |
| `WITH tw AS (...), lw AS (...) SELECT ...비율계산...` | `SELECT * FROM v_weekly_growth` |

---

## NEW: 인덱스 3개 추가 (개념 3번 적용)

> "인덱스 없으면 전체 테이블을 처음부터 끝까지 다 읽어야 함" — 데이터베이스_개념정리.txt

```sql
-- 1. 카테고리별 집계에 필수 (fetchPhase2Data GROUP BY + 재분류 WHERE)
CREATE INDEX idx_posts_topic_category ON thread_posts(topic_category);

-- 2. 최근 N일 필터에 필수 (weekly-retro, daily-performance)
CREATE INDEX idx_lifecycle_posted_at ON content_lifecycle(posted_at);

-- 3. 카테고리별 성과 집계 (v_category_performance View)
CREATE INDEX idx_lifecycle_need_category ON content_lifecycle(need_category);
```

---

## NEW: Issue 4 트랜잭션 래핑 (개념 8번 적용)

> "A에서 빠졌는데 B에 안 들어가면? 돈이 증발.
>  둘 다 성공하거나 둘 다 취소해야 함" — 데이터베이스_개념정리.txt

Phase 5에서 `aff_contents INSERT` + `brand_events.is_used UPDATE`를 트랜잭션으로 묶기:

```typescript
// daily-pipeline.ts Phase 5 수정
await db.transaction(async (tx) => {
  // 1. 콘텐츠 저장
  await tx.insert(affContents).values({
    id: crypto.randomUUID(),
    product_id: matched.product_id,
    need_id: matched.need_id,
    format: directive.format,
    hook: content.hook,
    bodies: content.bodies,
    positioning: directive.brief,
    status: 'ready',
    content_source: 'daily_pipeline',
  });

  // 2. 사용한 이벤트 마킹 (1과 원자적)
  if (directive.source_brand_event_id) {
    await tx.update(brandEvents)
      .set({ is_used: true })
      .where(eq(brandEvents.event_id, directive.source_brand_event_id));
  }
});
// → 둘 다 성공하거나 둘 다 롤백
```

---

## 수정하지 않는 것 (검증 완료)

| 컴포넌트 | 검증 결과 |
|---------|----------|
| `src/db/schema.ts` | DB와 23개 테이블 완전 일치. aff_contents.status 이미 존재 |
| `src/db/agent-messages.ts` | 스키마 정상 |
| `src/db/experiments.ts` | 로직 정상 (nullable만 수정) |
| `src/db/revenue.ts` | 로직 정상 (nullable만 수정) |
| `src/safety/gates.ts` | gate 로직 자체 정상 (daily-pipeline 수정으로 호출 경로 복구) |
| `src/learning/diversity-checker.ts` | 메모리 기반, DB 의존성 없음 |
| `src/learning/strategy-logger.ts` | 파일 기반, DB 의존성 없음 |
| `src/scraper/collect.ts` | 수집 로직 정상 |
| `src/scraper/db-adapter.ts` | upsert 로직 정상 |
| `src/analyzer/product-matcher.ts` | CDP 기반, DB 의존성 최소 |
| `.claude/agents/*.md` (전체) | DB 직접 참조 없음 (도구 통해 간접 접근) |
| `souls/bini-persona.md` | DB 참조 없음 |
| `ops/debate-ops.md` | DB 참조 없음 |
| `ops/writing-guide-ops.md` | DB 참조 없음 |
| `ops/safety-ops.md` | DB 참조 없음 |
| `ops/learning-ops.md` | 파일 기반 |
| `ops/content-creation-ops.md` | DB 참조 없음 |
| `ops/naver-data-ops.md` | 외부 API만 |

---

## 예상 작업량

| Phase | 코드 수정 | 문서 수정 | 마이그레이션 | 비고 |
|-------|---------|---------|-----------|------|
| **A** | 1개 (daily-pipeline.ts) | 1개 (standup-ops) | 1개 (View 4 + 인덱스 3 + nullable) | 최우선, 블로커 |
| **B** | 2개 (classifier + test) | 0 | 0 | 중간 크기 |
| **C** | 3개 (keyword + trend + track) + pipeline | 0 | 0 | 작음 |
| **D** | 0 | 3개 (SKILL + perf-ops + standup-ops) | 1개 (View 3 추가) | 작음 |
| **E** | 0 | 0 | 0 | 검증만 |
| **합계** | **6개 파일** | **4개 파일** | **2개** | + 백업 2회 |

---

## 성공 기준

```sql
-- 1. View 존재 확인 (Phase A 완료 기준)
SELECT table_name FROM information_schema.views
WHERE table_schema = 'public' AND table_name LIKE 'v_%';
-- 기대: v_collection_status, v_brand_radar, v_category_performance, v_weekly_growth

-- 2. View 조회 가능 (Phase A 완료 기준)
SELECT * FROM v_collection_status LIMIT 1;
SELECT * FROM v_weekly_growth;
-- 기대: 에러 없이 결과 반환 (0행이어도 OK)

-- 3. 파이프라인 실행 가능 (Phase A 완료 기준)
-- daily-pipeline.ts의 fetchPhase2Data() 에러 없이 실행

-- 4. 콜드 스타트 안전 (Phase A 완료 기준)
-- content_lifecycle에 48h 이내 데이터 0행일 때 fetchPhase2Data()가 빈 배열 반환

-- 5. 기타 카테고리 20% 이하 (Phase B 완료 기준)
SELECT ROUND(COUNT(*) FILTER (WHERE topic_category = '기타')::numeric / COUNT(*) * 100) AS pct
FROM thread_posts;
-- 기대: ≤ 20

-- 6. 미분석 0% (Phase B 완료 기준)
SELECT COUNT(*) FROM thread_posts WHERE analyzed_at IS NULL;
-- 기대: 0

-- 7. primary_tag 실질 태그 존재 (Phase B 완료 기준)
SELECT primary_tag, COUNT(*) FROM thread_posts
WHERE primary_tag NOT IN ('general') AND primary_tag IS NOT NULL GROUP BY 1;
-- 기대: purchase_signal, review 등 1개 이상

-- 8. post_source 태깅 동작 (Phase C 완료 기준)
SELECT post_source, COUNT(*) FROM thread_posts GROUP BY 1;
-- 기대: keyword_search, x_trend, benchmark 각각 존재

-- 9. 트랜잭션 래핑 확인 (Phase C 완료 기준)
-- daily-pipeline.ts에 db.transaction() 블록 존재

-- 10. 인덱스 존재 (Phase A 완료 기준)
SELECT indexname FROM pg_indexes WHERE tablename = 'thread_posts' AND indexname = 'idx_posts_topic_category';
SELECT indexname FROM pg_indexes WHERE tablename = 'content_lifecycle' AND indexname LIKE 'idx_lifecycle_%';
-- 기대: 3개 인덱스

-- 11. 빌드 + 테스트 (Phase E)
-- tsc --noEmit: 0 errors
-- npm test: 170+ tests PASS
```

---

## 위험 관리

| 위험 | 대응 |
|------|------|
| **마이그레이션 전 데이터 손실** | Phase A0, B0에서 `supabase db dump` 백업 (개념 12번) |
| 재분류 시 기존 analyzed_at 덮어씀 | **정책**: analyzed_at = NOW() 업데이트 (최신 분류 시점 반영) |
| 동시 수집 중 재분류 충돌 | **정책**: 수집 중단 불필요. 누락 포스트는 다음 분류에서 처리 |
| daily-pipeline.ts 대규모 수정 | Phase A5에서 즉시 `tsc --noEmit` + `npm test` 검증 |
| nullable 마이그레이션 실패 | 기존 데이터 0행이라 NOT NULL 제약 안전 |
| Phase 5 INSERT + UPDATE 부분 실패 | **트랜잭션 래핑**으로 원자성 보장 (개념 8번) |
| 48h 이내 데이터 0행 (콜드 스타트) | Phase E4에서 빈 데이터 시 에러 없이 빈 배열 반환 검증 |
| View 성능 문제 | 현재 데이터 수천 건 → 일반 View 충분. 1만 건 초과 시 Materialized View 전환 |
