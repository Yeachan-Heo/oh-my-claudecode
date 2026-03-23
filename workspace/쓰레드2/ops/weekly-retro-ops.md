# 주간 전략회의 운영 절차 (weekly-retro-ops)

> **주기**: 매주 일요일
> **참여자**: CEO(민준) + 분석가(서연) + 에디터 대표(빈이)
> **목적**: 주간 성과 리뷰, 전략 조정, 실험 설계, 경쟁사 교체
> **산출물**: `weekly_retro` 리포트 → `agents/memory/strategy-log.md` append
> **선행 작업**: 경쟁사 채널 평가 (회의 전 서연이 쿼리 실행)

---

## 사전 준비 (서연 담당, 회의 전 완료)

```sql
-- 1. 주간 채널 성과 평가 (경쟁사 하위 20% 파악)
SELECT
  c.username,
  c.benchmark_status,
  COUNT(p.id) AS post_count_7d,
  ROUND(AVG(p.view_count)) AS avg_views,
  ROUND(AVG((p.like_count + p.reply_count + p.repost_count)::float
    / NULLIF(p.view_count, 0) * 100), 2) AS avg_engagement_rate,
  MIN(c.verified_at) AS verified_since
FROM channels c
LEFT JOIN thread_posts p ON p.channel_id = c.id
  AND p.collected_at >= NOW() - INTERVAL '7 days'
  AND p.collected_at <= NOW() - INTERVAL '2 days'
WHERE c.benchmark_status = 'verified'
GROUP BY c.username, c.benchmark_status, c.verified_at
ORDER BY avg_views ASC;

-- 2. 주간 자체 포스트 성과
SELECT
  category,
  COUNT(*) AS post_count,
  ROUND(AVG(view_count)) AS avg_views,
  MAX(view_count) AS max_views,
  ROUND(AVG(like_count + reply_count + repost_count)) AS avg_engagement,
  ROUND(AVG((like_count + reply_count + repost_count)::float
    / NULLIF(view_count, 0) * 100), 2) AS avg_engagement_rate
FROM thread_posts
WHERE is_published = true
  AND published_at >= NOW() - INTERVAL '7 days'
GROUP BY category
ORDER BY avg_views DESC;

-- 3. 주간 실험 결과
SELECT
  experiment_id,
  hypothesis,
  variable,
  verdict,
  confidence,
  start_date,
  end_date
FROM content_experiments
WHERE start_date >= NOW() - INTERVAL '14 days'
ORDER BY start_date DESC;
```

---

## 아젠다

### 1. 주간 성과 요약 (서연 보고, 10분)

**보고 내용**:
- 이번 주 총 포스트 수, 총 조회수, 평균 참여율
- 전주 대비 성장 추이 (조회수 %, 팔로워 변화)
- 워밍업 진행 현황 (N/100)

**서연 보고 포맷**:
```
이번 주 성과:
  - 총 게시: N개 (목표: 10개/일 × 7일 = 70개)
  - 총 조회수: N (전주 대비 +/- N%)
  - 평균 조회수: N뷰/포스트
  - 평균 참여율: N%
  - 최고 포스트: [제목] — N뷰 (카테고리: X)
  - 워밍업: N/100 완료
```

**CEO 판단 포인트**:
- 총 조회수 전주 대비 -20% 이상 → 원인 분석 요청 (서연)
- 워밍업 목표 페이스 (10개/일) 미달 → Phase 4 병목 파악

---

### 2. 카테고리 성과 비교 (서연 보고, 10분)

**보고 내용**:
- 카테고리별 ROI 점수 비교 (조회수/1000 × 참여율×100)
- 카테고리별 최고/최저 포스트 사례

**카테고리 ROI 매트릭스**:
```
카테고리 | 포스트 수 | 평균뷰 | 참여율 | ROI점수 | 등급 | 비고
뷰티     |     N    |  N,NNN | N.N%  |   N     |  A  | 선크림 시즌 효과
건강     |     N    |  N,NNN | N.N%  |   N     |  B  | 마그네슘 인기
생활     |     N    |  N,NNN | N.N%  |   N     |  B  | 유지
다이어트 |     N    |  N,NNN | N.N%  |   N     |  C  | 앵글 교체 논의
```

**CEO 판단 포인트**:
- C등급 카테고리 2주 연속 → 다음 주 비율 -1, 실험 슬롯 전환
- A등급 카테고리 3주 연속 → 브랜드 리서치 집중 투자

**빈이 의견 수렴**:
- "이번 주 뷰티 중 어떤 주제가 반응이 좋았나요?"
- "쓰기 어려웠던 주제/앵글이 있었나요?"

---

### 3. 실험 결과 리뷰 (서연 + CEO, 15분)

**이번 주 완료된 실험 결과**:

```
실험 ID    | 가설                          | 결과         | 신뢰도
EXP-...   | 숫자형 훅 > 질문형 훅           | variant_a 승 | replicated (3회)
EXP-...   | 오전 8시 > 밤 10시             | directional  | n=1 (미결론)
```

**판단 기준**:
- `directional` (n=1): 방향성 참고만, 추가 실험 계속
- `replicated` (3회 일관): 전략 반영 → `strategy-log.md` 업데이트

**신규 전략 반영 예시**:
```
반영: 훅에 숫자 포함 시 CTR +N% → 전 에디터 훅 가이드라인 업데이트 (태호에게 요청)
```

---

### 4. 경쟁사 채널 평가 (CEO 주도, 10분)

**하위 20% 제거 기준**:
- 29채널 → 하위 6개 retired 처리
- 신규 등록 7일 미만은 평가 제외

**CEO 판단**:
```
Retire 대상: [@channel1, @channel2, ... @channel6]
사유: 평균 조회수 N뷰 (전체 평균 N뷰의 N% 수준)
```

**retired 처리 (태호에게 지시)**:
```sql
-- CEO가 판단 후 태호에게 실행 요청
UPDATE channels
SET benchmark_status = 'retired', retired_at = NOW()
WHERE username IN ('channel1', 'channel2', ...');
```

**신규 채널 발굴 지시 (준호에게)**:
- 퇴출 채널 수만큼 신규 후보 탐색 (Exa 웹 검색 + 키워드)
- `collect.ts`로 30개 수집 → 평균 조회수 > 전체 평균 70% → verified 요청
- 채널 수 목표: 항상 25~35개 verified 유지

---

### 5. 다음 주 전략 조정 (CEO 주도, 10분)

**전략 조정 항목**:

1. **카테고리 비율** — ROI 기반 조정
   ```
   현행: 뷰티4 / 건강3 / 생활2 / 다이어트1
   조정안: [뷰티N / 건강N / 생활N / 다이어트N]
   근거: [카테고리 ROI 변화 / 계절 요인 / 브랜드 이벤트]
   ```

2. **시간대 슬롯** — 벤치마크 데이터 기반 조정 여부
   ```
   현행 슬롯 유지 or 변경:
   변경 시 근거: 이번 주 N시 평균 조회수 N뷰 → 효율적
   ```

3. **포맷 가이드라인** — 에디터 피드백 반영
   - 빈이 의견 기반 가이드라인 업데이트 여부
   - 태호에게 가이드 문서 수정 요청 여부

4. **수집 소스** — 유효성 점검
   - benchmark 채널 교체 반영
   - 키워드 추가/삭제 여부

---

### 6. 신규 실험 설계 (CEO + 서연, 10분)

다음 주 실험 슬롯(3개/일 × 7일 = 21개) 계획:

**실험 우선순위 선정 기준**:
1. 현재 전략에서 가장 불확실한 변수
2. 이번 주 성과 이상치에서 추론한 가설
3. 빈이/서연이 제안한 아이디어

**신규 실험 포맷**:
```json
[
  {
    "experiment_id": "EXP-YYYYMMDD-W01",
    "hypothesis": "리스트형 포맷이 스토리형보다 저장율이 높다",
    "variable": "post_format",
    "variant_a": "리스트형 (1. 2. 3. ...)",
    "variant_b": "스토리형 (경험 서사)",
    "assigned_category": "뷰티",
    "evaluation_window": "48h",
    "success_metric": "save_rate"
  }
]
```

---

## 회의 산출물: weekly_retro 리포트

회의 종료 후 CEO가 `agents/memory/strategy-log.md`에 append:

```markdown
---
## 주간 전략회의 — YYYY-MM-DD (N주차)

### 성과 요약
- 총 게시: N개 / 총 조회수: N뷰 / 평균 참여율: N%
- 전주 대비: +/- N% (조회수)
- 워밍업: N/100

### 카테고리 ROI
| 카테고리 | ROI점수 | 등급 | 변화 |
|---------|--------|------|------|
| 뷰티     | N      | A    | +N   |
| 건강     | N      | B    | -N   |
| 생활     | N      | B    | 유지  |
| 다이어트 | N      | C    | -N   |

### 실험 결과
- EXP-XXX: [verdict] — [전략 반영 여부]

### 경쟁사 교체
- Retired: [@channel1, @channel2]
- 신규 발굴 지시: 준호에게 N개 탐색 요청

### 다음 주 전략
- 카테고리 비율: 뷰티N / 건강N / 생활N / 다이어트N
- 신규 실험: [EXP ID 목록]
- 특이사항: [계절 요인, 브랜드 이슈 등]

### Action Items
- [ ] 태호: [코드/설정 변경 사항]
- [ ] 준호: [신규 채널 발굴 N개]
- [ ] 서연: [분석 요청 사항]
- [ ] 빈이: [가이드라인 변경 사항 적용]
---
```

---

## 비상 회의 조건

아래 조건 충족 시 일요일 외 임시 회의 소집 (CEO 판단):

| 조건 | 임계값 | 액션 |
|------|--------|------|
| 조회수 급락 | 일평균 -50% 3일 연속 | 즉시 서연 분석 요청 + 긴급 전략회의 |
| 실험 사고 | QA 통과 실패율 > 30% | 콘텐츠 생성 일시 중단 + 도윤 가이드라인 점검 |
| 채널 정지 | Threads 계정 제한 | 시훈 즉시 보고 + 발행 중단 |
| 브랜드 이슈 | 파트너 브랜드 품질 문제 | 해당 브랜드 콘텐츠 즉시 보류 |
