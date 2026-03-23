# 데일리 스탠드업 운영 절차 (daily-standup-ops)

> **주기**: 매일 실행
> **참여자**: CEO(민준) 주도, 전 에이전트 참여
> **목적**: 오늘 할 일 결정, 어제 성과 리뷰, daily_directive 생성
> **산출물**: `daily_directive` (JSON) → `agents/memory/strategy-log.md` append

---

## 전체 파이프라인 요약

```
Phase 1: 데이터 수집 (병렬, 준호 담당)
Phase 2: 분석 (서연 담당)
Phase 3: CEO 스탠드업 → daily_directive 생성  ← 이 문서의 범위
Phase 4: 콘텐츠 생성 (에디터 담당)
Phase 5: 게시 (시간대별 분산, 시훈 승인)
Phase 6: 사후 관리 (24h 후 성과 수집)
```

---

## Phase 1: 데이터 수집

**담당**: 준호(리서처)
**병렬 실행**, 완료 목표 시간: 수집 시작 후 60분 이내

### 수집 항목

```bash
# 1. 벤치마크 채널 (--since 24h)
npx tsx src/scraper/collect.ts --since 24h

# 2. YouTube 채널 (--days 1)
# youtube-channels 테이블 순회

# 3. X트렌드 수집 + 필터
# trend-fetcher.ts → trend-filter.ts

# 4. 네이버 검색량 (카테고리 대표 키워드)
python3 naver-keyword-search/search.py "선크림" "영양제" "생활용품" "다이어트 식품" --no-expand

# 5. 네이버 트렌드 (30일)
python3 naver-keyword-search/trend.py "선크림" "영양제 추천" "가성비 생활템" --period 30

# 6. 브랜드 리서치 (stale 처리 후 재실행)
npx tsx scripts/research-brands.ts
```

### Phase 1 완료 확인 쿼리

```sql
-- 최근 24h 수집 건수 (소스별)
SELECT
  post_source,
  COUNT(*) AS count,
  MAX(collected_at) AS last_collected
FROM thread_posts
WHERE collected_at >= NOW() - INTERVAL '24 hours'
GROUP BY post_source
ORDER BY count DESC;
```

**CEO 판단 포인트**:
- 소스별 수집 건수가 전일 대비 50% 미만이면 → 준호에게 재수집 지시
- brand 소스 0건이면 → stale 처리 후 research-brands.ts 재실행

---

## Phase 2: 분석

**담당**: 서연(분석가)
**의존**: Phase 1 완료 후 실행

### 2-1. 카테고리 분포 확인

```sql
-- 최근 24h 수집 포스트 카테고리 분포
SELECT
  category,
  COUNT(*) AS count,
  ROUND(AVG(view_count)) AS avg_views,
  ROUND(AVG(like_count::float / NULLIF(view_count, 0) * 100), 2) AS avg_like_rate
FROM thread_posts
WHERE collected_at >= NOW() - INTERVAL '24 hours'
  AND category IS NOT NULL
GROUP BY category
ORDER BY count DESC;
```

### 2-2. 고성과 포스트 (TOP 10)

```sql
-- 최근 24h 수집 중 조회수 TOP 10
SELECT
  username,
  content,
  view_count,
  like_count,
  reply_count,
  repost_count,
  category,
  post_source
FROM thread_posts
WHERE collected_at >= NOW() - INTERVAL '24 hours'
ORDER BY view_count DESC
LIMIT 10;
```

### 2-3. 브랜드 이벤트 (유효기간 7일 이내)

```sql
-- 유효 브랜드 이벤트
SELECT
  b.name AS brand,
  be.event_type,
  be.title,
  be.description,
  be.valid_until,
  be.is_used
FROM brand_events be
JOIN brands b ON b.id = be.brand_id
WHERE be.is_stale = false
  AND be.is_used = false
  AND be.valid_until >= NOW()
ORDER BY be.valid_until ASC
LIMIT 20;
```

### 2-4. 전일 게시 포스트 성과

```sql
-- 어제 게시한 포스트 24h 성과
SELECT
  p.content,
  p.category,
  p.view_count,
  p.like_count,
  p.reply_count,
  p.repost_count,
  ROUND((p.like_count + p.reply_count + p.repost_count)::float / NULLIF(p.view_count, 0) * 100, 2) AS engagement_rate,
  p.post_source,
  p.published_at
FROM thread_posts p
WHERE p.is_published = true
  AND p.published_at >= NOW() - INTERVAL '48 hours'
  AND p.published_at < NOW() - INTERVAL '24 hours'
ORDER BY p.view_count DESC;
```

**CEO 판단 포인트**:
- 전일 포스트 중 engagement_rate > 3% → 해당 카테고리 오늘 비율 +1 검토
- 전일 포스트 중 view_count < 300 → C등급 경고, 앵글 교체 검토
- 브랜드 이벤트 3개 미만 → 서연에게 네이버 키워드 추가 검색 요청

---

## Phase 3: CEO 스탠드업

**담당**: 민준(CEO)
**의존**: Phase 2 완료 후 실행
**산출물**: `daily_directive` JSON

### 3-1. CEO 판단 절차

```
Step 1: Phase 2 결과 종합
  → 카테고리 ROI 점수 계산 (조회수/1000 × 참여율×100)
  → 등급 분류 (A: 15+, B: 8~14, C: 7-)

Step 2: 카테고리 비율 결정
  → 기본: 뷰티4 / 건강3 / 생활2 / 다이어트1
  → A등급 카테고리 +1 (최대 5개), C등급 3일 연속 -1 (최소 1개)
  → 네이버 검색량 급등 키워드 카테고리 +1 (당일만)
  → 합계 = 10 (일반7 + 실험3)

Step 3: 다양성 체크
  → 단일 포맷 > 60% → 교체
  → 단일 카테고리 > 50% → 보정

Step 4: 실험 슬롯 배정 (3개)
  → 진행 중인 A/B 실험 변형본 우선
  → 신규 가설 (변수 1개만)
  → 밤 22:00 슬롯은 항상 실험 전용

Step 5: 리사이클 후보 선정 (최대 1~2개)
  → 14일+ 경과, 조회수 상위 20%

Step 6: daily_directive 생성 → strategy-log.md append
```

### 3-2. daily_directive 출력 포맷

```json
{
  "date": "YYYY-MM-DD",
  "total_posts": 10,
  "category_allocation": {
    "뷰티": 4,
    "건강": 3,
    "생활": 2,
    "다이어트": 1
  },
  "regular_posts": 7,
  "experiment_posts": 3,
  "time_slots": [
    {
      "time": "08:00",
      "category": "뷰티",
      "type": "regular",
      "editor": "bini-beauty-editor",
      "brief": "선크림 성분 비교 — 워터/에센스 타입"
    },
    {
      "time": "08:00",
      "category": "건강",
      "type": "regular",
      "editor": "hana-health-editor",
      "brief": "아침 공복 영양제 순서"
    },
    {
      "time": "11:00",
      "category": "뷰티",
      "type": "regular",
      "editor": "bini-beauty-editor",
      "brief": "올리브영 신상 후기"
    },
    {
      "time": "14:00",
      "category": "생활",
      "type": "regular",
      "editor": "sora-lifestyle-editor",
      "brief": "다이소 주방템 TOP5"
    },
    {
      "time": "15:00",
      "category": "건강",
      "type": "regular",
      "editor": "hana-health-editor",
      "brief": "마그네슘 효능 + 추천 제품"
    },
    {
      "time": "18:00",
      "category": "뷰티",
      "type": "regular",
      "editor": "bini-beauty-editor",
      "brief": "저녁 스킨케어 루틴"
    },
    {
      "time": "20:00",
      "category": "생활",
      "type": "regular",
      "editor": "sora-lifestyle-editor",
      "brief": "쿠팡 배송 빠른 생활템"
    },
    {
      "time": "20:00",
      "category": "다이어트",
      "type": "regular",
      "editor": "jiu-diet-editor",
      "brief": "현실적인 간식 대체법"
    },
    {
      "time": "21:00",
      "category": "건강",
      "type": "experiment",
      "editor": "hana-health-editor",
      "experiment_id": "EXP-YYYYMMDD-001",
      "brief": "variant_b: 질문형 훅 테스트"
    },
    {
      "time": "22:00",
      "category": "뷰티",
      "type": "experiment",
      "editor": "bini-beauty-editor",
      "experiment_id": "EXP-YYYYMMDD-002",
      "brief": "밤 10시 시간대 실험"
    }
  ],
  "recycle_candidates": [
    {
      "original_post_id": "POST-ID",
      "original_views": 12000,
      "original_angle": "비교형",
      "new_angle": "스토리형",
      "assigned_slot": "11:00"
    }
  ],
  "experiment_active": [
    {
      "experiment_id": "EXP-YYYYMMDD-001",
      "hypothesis": "질문형 훅이 숫자형보다 참여율 높다",
      "variable": "hook_type",
      "status": "running",
      "start_date": "YYYY-MM-DD"
    }
  ],
  "diversity_warnings": [],
  "roi_summary": {
    "뷰티": {"score": 18, "grade": "A"},
    "건강": {"score": 12, "grade": "B"},
    "생활": {"score": 10, "grade": "B"},
    "다이어트": {"score": 6, "grade": "C"}
  },
  "notes": "뷰티 ROI A등급 3일 연속 — 비율 유지. 다이어트 C등급 첫날 — 모니터링."
}
```

---

## Phase 4: 콘텐츠 생성

**담당**: 에디터 (빈이/하나/소라/지우)
**의존**: daily_directive 생성 완료 후 실행

### 콘텐츠 생성 큐 확인

```sql
-- 오늘 콘텐츠 생성 큐
SELECT
  ac.id,
  ac.category,
  ac.scheduled_time,
  ac.status,
  ac.editor_agent,
  ac.brief
FROM aff_contents ac
WHERE DATE(ac.created_at) = CURRENT_DATE
ORDER BY ac.scheduled_time ASC;
```

**CEO 판단 포인트**:
- status='blocked' 콘텐츠 있으면 → 해당 에디터에게 사유 확인
- 오전 08:00 슬롯 콘텐츠가 07:30까지 ready 아니면 → 대기 콘텐츠로 교체

---

## Phase 5: 게시

**담당**: 시훈(사람) 승인 → `/threads-post` 자동 게시
**규칙**: 최소 1시간 간격 엄수

### 게시 대기 확인

```sql
-- 게시 대기 중인 콘텐츠
SELECT
  ac.id,
  ac.scheduled_time,
  ac.category,
  LEFT(ac.content, 50) AS preview,
  ac.status
FROM aff_contents ac
WHERE ac.status = 'ready'
  AND DATE(ac.scheduled_time) = CURRENT_DATE
ORDER BY ac.scheduled_time ASC;
```

**CEO 판단 포인트**:
- 시훈 승인 없을 경우 → 다음 슬롯으로 이월 (당일 자정까지)
- 이월 불가 시 → 내일 오전 08:00 슬롯에 배정

---

## Phase 6: 사후 관리

**담당**: 준호(리서처) 수집, 서연(분석가) 분석
**타이밍**: 게시 24h 후

### 24h 성과 수집

```bash
npx tsx scripts/track-performance.ts
```

### 신규 게시 포스트 초기 성과 확인

```sql
-- 어제 게시 포스트 24h 성과 확인
SELECT
  p.id,
  LEFT(p.content, 60) AS preview,
  p.view_count,
  p.like_count,
  p.reply_count,
  p.repost_count,
  ROUND((p.like_count + p.reply_count + p.repost_count)::float
    / NULLIF(p.view_count, 0) * 100, 2) AS engagement_rate,
  p.category,
  p.published_at
FROM thread_posts p
WHERE p.is_published = true
  AND p.published_at BETWEEN NOW() - INTERVAL '48h' AND NOW() - INTERVAL '20h'
ORDER BY p.view_count DESC;
```

### 실험 결과 기록

```sql
-- 진행 중인 실험 상태
SELECT
  experiment_id,
  hypothesis,
  variable,
  variant_a_post_id,
  variant_b_post_id,
  status,
  start_date,
  verdict
FROM content_experiments
WHERE status = 'running'
ORDER BY start_date DESC;
```

**CEO 판단 포인트**:
- 실험 48h 경과 → verdict 판단 후 `experiment-log.md` 기록
- 3회 replicated 패턴 → 해당 전략 채택, strategy-log.md 업데이트
- 성과 이상치 (전일 대비 -50%) → 서연에게 원인 분석 요청
