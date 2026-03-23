# Learning Ops — 학습 시스템 운영 가이드

## 담당자
- **서연 (분석가)**: 매일 다양성 체크 실행 및 보고

---

## 일일 루틴: 다양성 체크

### 실행 방법
```typescript
import { getDiversityReport } from '../src/learning/diversity-checker.js';

// 최근 10개 포스트 조회 후 분석
const recentPosts = await db.select()
  .from(threadPosts)
  .orderBy(desc(threadPosts.createdAt))
  .limit(10);

const report = getDiversityReport(recentPosts);
```

### 경고 발생 시 처리
경고가 있으면 `agent_messages` 테이블에 CEO 보고 메시지 삽입:

```sql
INSERT INTO agent_messages (from_agent, to_agent, message_type, content)
VALUES (
  'seoyeon-analyst',
  'ceo',
  'diversity_alert',
  '{"warnings": [...], "isHealthy": false}'
);
```

### 경고 유형별 대응
| 경고 | 조건 | 대응 |
|------|------|------|
| 포맷 단조로움 | 같은 포맷 >60% | 다른 포맷(비교/리스트/질문형) 기획 요청 |
| 카테고리 편중 | 같은 카테고리 >50% | 다른 카테고리 포스트 우선 기획 |
| 훅 반복 | 같은 훅 3회+ | 훅 유형 변경 (공감→반전→질문 순환) |

---

## 주간 회고

매주 월요일, 지난 주 인사이트 기록:

```typescript
import { updateWeeklyInsights } from '../src/learning/strategy-logger.js';

updateWeeklyInsights('2026-W13', `
- 뷰티 카테고리 참여율 평균 4.2% (전주 대비 +0.8%)
- 질문형 훅이 공감형보다 댓글 2.3배 많음
- 워밍업 포맷은 초반 노출에 효과적이나 팔로우 전환율 낮음
`);
```

---

## 카테고리별 플레이북 업데이트

성과 분석 후 카테고리별 학습 내용 기록:

```typescript
import { updatePlaybook } from '../src/learning/strategy-logger.js';

updatePlaybook('뷰티', '아이크림 비교 포스트: 조회수 12,400 — 가격대별 비교 포맷이 효과적');
updatePlaybook('건강', '단백질 보충제 후기: 질문형 훅 → 댓글 47개 (평균 3.2배)');
```

---

## 전략 결정 로그

중요한 콘텐츠 전략 결정은 기록:

```typescript
import { logDecision } from '../src/learning/strategy-logger.js';

logDecision(
  '2026-03-23',
  '뷰티 카테고리 비중 축소',
  '3주 연속 편중 경고 — 다양성 확보를 위해 건강/생활 카테고리 확대',
  '미정'
);
```

---

## 파일 위치
- `agents/memory/strategy-log.md` — 전략 결정 이력
- `agents/memory/experiment-log.md` — 실험 결과
- `agents/memory/weekly-insights.md` — 주간 회고
- `agents/memory/category-playbook/{카테고리}.md` — 카테고리별 학습
