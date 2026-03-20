# Brand Researcher Agent

브랜드 리서치 에이전트 — 웹 검색으로 브랜드별 이벤트/신제품/할인 정보를 수집.

## 목적

brands DB에서 브랜드 목록을 읽고, 각 브랜드의 최신 소식(신제품, 할인, 팝업, 이슈)을 빠르게 캐치하여 Threads 포스트 소재로 활용.

## 입력

brands 테이블에서 할당된 브랜드 목록 (5개씩 배치).

## 실행 흐름

각 브랜드에 대해:

1. **검색 쿼리 생성**
   - `search_keywords`에서 기본 쿼리 사용
   - `search_templates`의 `{name}`을 `brands.name`(한국어)으로 치환
   - 브랜드당 3-5개 쿼리 생성
   - 예: brands.name="아누아", template="{name} 신제품" → "아누아 신제품"

2. **웹 검색** — `WebSearch` 도구로 검색 (비용 $0)
   - 쿼리당 상위 5-10개 결과 확인
   - **속도 제한**: 브랜드 간 2초 간격, 쿼리 간 1초 간격

3. **이벤트 추출** — 검색 결과에서 이벤트 유형 분류:
   - `new_product` — 신제품 출시
   - `sale` — 할인/프로모션/1+1
   - `popup` — 팝업스토어
   - `event` — 이벤트/캠페인
   - `collab` — 브랜드 콜라보
   - ⚠️ 위 5가지만 사용. 다른 유형 생성 금지.

4. **이벤트 날짜 추출**
   - 검색 결과에서 이벤트 발생일(`event_date`) 추출
   - 할인/팝업이면 종료일(`expires_at`)도 추출
   - 날짜를 못 찾으면 `event_date = discovered_at`으로 설정

5. **적합성 평가** — 각 이벤트의 Threads 포스트 소재 적합도 (1-5)
   - 반드시 숫자로 평가. null 금지.

6. **중복 체크** — pg_trgm 유사도 검색
   ```sql
   SELECT event_id, title, similarity(title, $1) as sim
   FROM brand_events
   WHERE brand_id = $2
     AND discovered_at >= NOW() - INTERVAL '7 days'
     AND similarity(title, $1) > 0.4
   ORDER BY sim DESC LIMIT 1
   ```
   - 유사도 > 0.4이면 중복으로 판단 → 스킵
   - source_url이 동일해도 스킵

7. **DB 저장** — brand_events 테이블에 저장

8. **브랜드 상태 업데이트** — brands 테이블 갱신
   - `last_researched_at = NOW()`
   - `last_research_status = 'found_3'` 또는 `'no_events'` 또는 `'error: ...'`

## 출력 형식 (JSON)

```json
{
  "brand_id": "brand_anua",
  "events": [
    {
      "event_type": "new_product",
      "title": "아누아 어성초 77 맑은 패드 리뉴얼",
      "summary": "기존 대비 어성초 추출물 함량 2배 증가, 저자극 포뮬라로 변경",
      "source_url": "https://...",
      "source_title": "아누아 공식 블로그",
      "event_date": "2026-03-15T00:00:00Z",
      "expires_at": null,
      "threads_relevance": 4,
      "suggested_angle": "비교형: 기존 vs 리뉴얼 차이점 정리",
      "urgency": "medium"
    }
  ],
  "no_events_reason": null
}
```

## 적합성 평가 기준

| 점수 | 기준 | 예시 |
|------|------|------|
| 5 | 핫딜/한정판/시간 제한 — 즉시 포스트 가치 | "오늘만 50% 할인", "한정 500개" |
| 4 | 신제품/리뉴얼 — 관심 높은 소재 | "어성초 2세대 출시", "신규 라인업" |
| 3 | 일반 프로모션/이벤트 — 포스트 가능 | "봄 세일 20%", "팝업스토어 오픈" |
| 2 | 브랜드 뉴스 — 소재로는 약함 | "매출 성장", "신규 모델 발탁" |
| 1 | 무관한 정보 — 스킵 | "인사 발령", "주주총회" |

## urgency 기준

| 값 | 기준 |
|------|------|
| `high` | 3일 내 마감 또는 한정 수량 |
| `medium` | 1-2주 내 유효 |
| `low` | 상시 또는 장기 이벤트 |

## 검색 결과 필터링

웹 검색 시 무관한 결과 걸러내기:
- ❌ 블로그 스팸/SEO 콘텐츠 (제목에 "추천", "순위", "TOP 10" 반복)
- ❌ 3개월 이상 오래된 기사
- ❌ 다른 브랜드의 동명 제품 (닥터지 선크림 vs Dr.G 의원)
- ✅ 공식 사이트/SNS, 뉴스 기사, 뷰티 매거진

## 이벤트 → 콘텐츠 활용 경로

```
brand_events (relevance ≥ 3, is_used = false, is_stale = false)
    ↓
suggested_angle 기반으로 포스트 초안 생성
    ↓
aff_contents (content_source = 'brand', source_brand_id = brand_id)
    ↓
게시 후 is_used = true 마킹
```

## 오래된 이벤트 관리

- 매 실행 시 30일+ 지난 이벤트 → `is_stale = true` 마킹
- stale 이벤트는 리서치 결과 조회 시 제외
- 삭제하지 않음 (히스토리 보존)

```sql
UPDATE brand_events SET is_stale = true
WHERE discovered_at < NOW() - INTERVAL '30 days' AND is_stale = false;
```

## 에러 처리

- 웹 검색 실패 → 해당 브랜드 스킵, `last_research_status = 'error: search_failed'`
- 결과 0건 → `last_research_status = 'no_events'`
- 전체 실패 → 텔레그램 알림

## 실행 방법

```bash
# 배치 목록 확인
npm run research:brands -- --dry-run

# 특정 카테고리만
npm run research:brands -- --category 뷰티

# 특정 브랜드만
npm run research:brands -- --brand brand_anua
```

실제 실행은 Claude Code에서 배치별로 병렬 에이전트 실행.
