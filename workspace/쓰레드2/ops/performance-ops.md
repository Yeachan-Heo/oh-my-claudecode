# 성과분석 운영 가이드 — 서연(분석가) 전용

> 담당: 서연 (seoyeon-analyst, opus)
> 실행 주기: 매일 1회 (수집 후) + 주간 1회 (일요일)
> 참조: `src/agents/performance-analyzer.md`, `.claude/agents/seoyeon-analyst.md`

---

## 1단계: 성과 데이터 수집 (track-performance.ts)

```bash
# CDP 연결 필요 (Chrome --remote-debugging-port=9223)
npx tsx scripts/track-performance.ts
```

**수집 항목:**
- 프로필 방문 → GraphQL 인터셉터로 engagement 일괄 캡처
- 각 포스트 개별 방문 → DOM에서 조회수 추출
- 본문이 빈 포스트 자동 수집 (thread_posts + content_lifecycle 동시 업데이트)
- post_snapshots 저장 (하루 1개 upsert)
- content_lifecycle maturity/impressions 업데이트
- 신규 포스트 자동 등록 (thread_posts → content_lifecycle)

**수집 후 확인 쿼리:**
```sql
-- 오늘 스냅샷 수
SELECT count(*) FROM post_snapshots
WHERE snapshot_at::date = CURRENT_DATE;

-- 본문 없는 포스트 (0이어야 함)
SELECT count(*) FROM content_lifecycle
WHERE posted_account_id = 'duribeon231'
  AND (content_text IS NULL OR content_text = '');
```

---

## 2단계: 절대 지표 평가

포스트별 최신 스냅샷에서 절대 수치를 평가한다.

```sql
-- 간단 조회 (View 기반)
SELECT * FROM v_post_ranking ORDER BY rank_by_views LIMIT 10;
```

또는 상세 쿼리가 필요하면:
```sql
SELECT
  cl.id,
  LEFT(cl.content_text, 50) AS preview,
  cl.need_category,
  cl.posted_at,
  ps.post_views,
  ps.likes,
  ps.comments,
  ps.shares,
  CASE WHEN ps.post_views > 0
    THEN round(((ps.likes + ps.comments + ps.shares)::numeric / ps.post_views) * 100, 2)
    ELSE 0
  END AS engagement_rate
FROM content_lifecycle cl
JOIN LATERAL (
  SELECT * FROM post_snapshots
  WHERE post_id = cl.id
  ORDER BY snapshot_at DESC LIMIT 1
) ps ON true
WHERE cl.posted_account_id = 'duribeon231'
ORDER BY ps.post_views DESC NULLS LAST;
```

**평가 기준 (워밍업 단계):**
| 등급 | 조회수 | 의미 |
|------|--------|------|
| A | 5,000+ | 알고리즘 도달 성공, 소재 검증됨 |
| B | 1,000~5,000 | 평균 노출, 개선 여지 |
| C | 500~1,000 | 팔로워 범위 노출 |
| D | 500 미만 | 알고리즘 미노출, 소재/시간대 문제 |

---

## 3단계: 콘텐츠 패턴 분석

### 3-1. 카테고리별 성과

```sql
-- 간단 조회 (View 기반)
SELECT * FROM v_category_performance ORDER BY roi_score DESC;
```

또는 상세 쿼리가 필요하면:
```sql
SELECT
  cl.need_category,
  count(*) AS posts,
  round(avg(ps.post_views)) AS avg_views,
  round(avg(ps.likes)) AS avg_likes,
  round(avg(ps.comments)) AS avg_comments
FROM content_lifecycle cl
JOIN LATERAL (
  SELECT * FROM post_snapshots
  WHERE post_id = cl.id
  ORDER BY snapshot_at DESC LIMIT 1
) ps ON true
WHERE cl.posted_account_id = 'duribeon231'
  AND ps.post_views > 0
GROUP BY cl.need_category
ORDER BY avg_views DESC;
```

### 3-2. 포맷별 성과

본문 키워드로 포맷 추론:
- **질문형**: "뭐 써?", "어떻게", "궁금", "?"로 끝남
- **솔직후기형**: "써봤는데", "진짜", "솔직히", "후회"
- **정보형**: 숫자 나열, "방법", "팁"
- **공감형**: "나도", "다들", "ㅋㅋ"
- **격언형**: "~의 힘", "느낀 점", 짧고 추상적

### 3-3. 시간대별 성과

```sql
SELECT
  EXTRACT(HOUR FROM cl.posted_at AT TIME ZONE 'Asia/Seoul') AS hour_kst,
  count(*) AS posts,
  round(avg(ps.post_views)) AS avg_views
FROM content_lifecycle cl
JOIN LATERAL (
  SELECT * FROM post_snapshots
  WHERE post_id = cl.id
  ORDER BY snapshot_at DESC LIMIT 1
) ps ON true
WHERE cl.posted_account_id = 'duribeon231'
  AND ps.post_views > 0
GROUP BY hour_kst
ORDER BY avg_views DESC;
```

---

## 4단계: 성장 추이 분석

```sql
-- 일별 총 조회수 추이
SELECT
  ps.snapshot_at::date AS date,
  sum(ps.post_views) AS total_views,
  sum(ps.likes) AS total_likes,
  sum(ps.comments) AS total_comments,
  count(DISTINCT ps.post_id) AS tracked_posts
FROM post_snapshots ps
JOIN content_lifecycle cl ON ps.post_id = cl.id
WHERE cl.posted_account_id = 'duribeon231'
GROUP BY date
ORDER BY date;
```

**비교 포인트:**
- 전일 대비 조회수 변화율
- 신규 포스트 평균 조회수가 이전보다 높아지는지
- 참여율 추이 (상승/하락)

---

## 5단계: TOP/BOTTOM 비교 + 추천

### TOP 3 vs BOTTOM 3
- 무엇이 다른지: 주제, 포맷, 훅, 길이, 시간대
- 공통 성공 요인 추출
- 실패 요인 추출

### 추천 생성
- **next_topics**: 성공 패턴 기반 다음 소재 3~5개
- **try_formats**: 시도해볼 포맷
- **avoid**: 피해야 할 패턴 (참여율 0% 소재)
- **experiment**: A/B 테스트 제안

---

## 6단계: daily_performance_reports 저장

분석 결과를 DB에 저장한다.

```sql
INSERT INTO daily_performance_reports (
  id, report_date, total_posts, new_posts_today,
  total_views, total_likes, total_comments, total_reposts,
  avg_engagement_rate,
  top_post_id, top_post_views, top_post_text,
  worst_post_id, worst_post_views,
  views_growth_pct, likes_growth_pct,
  content_analysis, recommendations, raw_post_data
) VALUES (...);
```

---

## 7단계: CEO 보고

분석 결과를 agent_messages로 CEO(민준)에게 전달:

```typescript
import { sendMessage } from './src/db/agent-messages.js';

await sendMessage(
  'seoyeon-analyst',
  'minjun-ceo',
  'standup',
  `[일일 성과 리포트 ${date}]
  총 포스트: ${total}개, 신규: ${new}개
  총 조회수: ${views} (전일 대비 ${growth}%)
  TOP: "${topText}" (${topViews}뷰)
  BOTTOM: "${worstText}" (${worstViews}뷰)
  핵심 패턴: ${pattern}
  추천: ${recommendation}`,
  { report_id: reportId }
);
```

---

## 주간 분석 (일요일)

주간 분석은 `ops/weekly-retro-ops.md` 절차를 따른다.

추가 쿼리:
```sql
-- 간단 조회 (View 기반)
SELECT * FROM v_weekly_growth;
```

또는 상세 쿼리가 필요하면:
```sql
-- 이번 주 vs 지난 주 비교
WITH this_week AS (
  SELECT sum(post_views) AS views, sum(likes) AS likes
  FROM post_snapshots ps
  WHERE ps.snapshot_at >= NOW() - INTERVAL '7 days'
),
last_week AS (
  SELECT sum(post_views) AS views, sum(likes) AS likes
  FROM post_snapshots ps
  WHERE ps.snapshot_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
)
SELECT
  tw.views AS this_week_views, lw.views AS last_week_views,
  round(((tw.views - lw.views)::numeric / NULLIF(lw.views, 0)) * 100, 1) AS growth_pct
FROM this_week tw, last_week lw;
```

---

## 실행 요약

```
매일:
  1. track-performance.ts 실행 (CDP 필요)
  2. DB 확인 (스냅샷 수, 빈 본문 0)
  3. 6단계 분석 실행 (쿼리 → 패턴 → 추천)
  4. daily_performance_reports 저장
  5. CEO에게 agent_messages로 보고

주간 (일요일):
  6. 주간 비교 분석
  7. weekly-insights.md 업데이트
  8. category-playbook/ 카테고리별 학습 기록
```
