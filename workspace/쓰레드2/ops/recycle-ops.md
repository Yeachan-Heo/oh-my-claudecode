# 포스트 리사이클 운영 절차 (recycle-ops)

> **주기**: 매일 (CEO 스탠드업 Phase 3에서 실행)
> **목적**: 고성과 포스트 소재를 새 앵글/포맷으로 재활용하여 콘텐츠 품질 유지
> **담당**: CEO(민준) 선정 → 에디터 변형 → 토론 → QA → 게시

---

## 후보 선정 기준

| 조건 | 값 |
|------|-----|
| 게시 경과 | 14일 이상 |
| 조회수 기준 | 해당 계정 전체 상위 20% |
| 중복 방지 | 같은 주제 최근 7일 미게시 |
| 대상 계정 | `duribeon231` |

---

## Step 1: 후보 조회

```typescript
import { getCandidates } from '../src/recycler/recycle.js';

const candidates = await getCandidates(5);
// → 조회수 상위 5개 반환
```

또는 직접 SQL:

```sql
SELECT cl.id, cl.content_text, cl.need_category, cl.hook_type, ps.post_views
FROM content_lifecycle cl
JOIN LATERAL (
  SELECT post_views FROM post_snapshots WHERE post_id = cl.id ORDER BY snapshot_at DESC LIMIT 1
) ps ON true
WHERE cl.posted_account_id = 'duribeon231'
  AND cl.posted_at < NOW() - INTERVAL '14 days'
  AND ps.post_views IS NOT NULL
ORDER BY ps.post_views DESC
LIMIT 5;
```

---

## Step 2: 소재 추출 (generateVariationTemplate)

```typescript
import { generateVariationTemplate } from '../src/recycler/recycle.js';

const template = generateVariationTemplate(candidate);
// → { original_id, topic, key_facts[], suggested_angle, suggested_hook_candidates[3], suggested_pattern }
```

**CEO 판단**: template을 참고해 새 앵글 1개 선택

---

## Step 3: 유사도 검사 (checkSimilarity)

변형 초안 작성 후 원본과 비교:

```typescript
import { checkSimilarity } from '../src/recycler/recycle.js';

const result = checkSimilarity(originalText, newDraftText);
// score < 0.7 → 통과 ("충분히 다름 — 통과")
// score >= 0.7 → 반려 ("너무 유사 — 앵글 변경 필요")
```

**기준**: Jaccard 유사도(bigram) < 0.7 통과

---

## Step 4: 변형 워크플로우

```
원본 포스트 선정
  → generateVariationTemplate() 으로 소재 추출
  → 새 앵글 선택 (반전/질문/숫자 중 1개)
  → 에디터 에이전트에게 변형 초안 요청
  → checkSimilarity() 로 유사도 검사 (< 0.7 확인)
  → post-debate-system.md 토론 시스템 통과
  → QA 체크리스트 통과
  → 시훈 승인 후 게시
```

---

## Step 5: DB 태깅

게시 후 `content_lifecycle` 테이블에 태깅:

```sql
UPDATE content_lifecycle
SET content_style = 'recycle',
    original_post_id = '<원본 ID>'
WHERE id = '<신규 포스트 ID>';
```

---

## CEO 판단 포인트

- 하루 최대 1~2개 리사이클 (전체 10개 중 20% 초과 금지)
- 리사이클 포스트는 원본 게시 14일+ 이후에만
- 같은 소재 연속 리사이클 금지 (최소 30일 간격)
- 리사이클 성과 추적: `content_lifecycle.content_style = 'recycle'` 필터로 일반 포스트 대비 성과 비교

---

## 리사이클 금지 케이스

- 조회수 하위 80% 포스트 (비고성과 소재 재활용 의미 없음)
- 시즌/이벤트 한정 소재 (이미 시의성 소멸)
- 정보 오류가 있었던 포스트
