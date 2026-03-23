# Experiment Ops Guide

## 목적
A/B 실험으로 콘텐츠 최적화 인사이트를 체계적으로 수집한다.
n=1은 directional, 3회 일관 재현되면 replicated → 실제 전략에 반영.

---

## 실험 유형

| 유형 | variable 값 | 예시 variant_a / variant_b |
|------|-------------|---------------------------|
| 훅 최적화 | `훅 스타일` | `감정공감형` / `정보형` |
| 포맷 실험 | `포맷` | `리스트형` / `서술형` |
| 시간대 실험 | `시간대` | `오전 8시` / `오후 9시` |
| 길이 실험 | `글 길이` | `100자 이하` / `200자 이상` |
| 이미지 실험 | `이미지 유무` | `이미지 포함` / `텍스트만` |

---

## 실험 할당 규칙

- **10개 포스트 중 3개**를 실험에 배정한다 (나머지 7개는 검증된 패턴 사용).
- 동시 진행 실험은 **변수 1개씩** — 훅/포맷/시간대를 동시에 바꾸면 해석 불가.
- 실험 포스트는 같은 날, 같은 주제로 variant_a / variant_b 쌍을 구성한다.

---

## 실험 라이프사이클

```
createExperiment() → 포스트 발행 → post_id_a / post_id_b 업데이트
→ 48h 대기 → evaluateExperiment() → closeExperiment()
```

1. **생성**: CEO가 daily_directive에서 실험 배정
   ```
   createExperiment(hypothesis, variable, variant_a, variant_b)
   ```
2. **연결**: 포스트 발행 후 post_id_a / post_id_b를 실험에 업데이트
3. **평가**: 48h 후 `evaluateExperiment(id)` — post_snapshots mature 기준 비교
4. **종료**: `closeExperiment(id, verdict, confidence)`

---

## 평가 기준

| 지표 | 기준 |
|------|------|
| 기본 지표 | post_views (mature snapshot, 48h) |
| 보조 지표 | likes, comments |
| 승자 결정 | 조회수 차이 > 10% → 높은 쪽 승 |
| 무승부 | 차이 ≤ 10% → `no_difference` |

---

## Confidence 레벨

| 레벨 | 조건 | 의미 |
|------|------|------|
| `directional` | n=1, 단일 실험 | 방향성 신호 — 참고용 |
| `replicated` | 같은 변수로 3회 일관된 결과 | 전략 반영 가능 |

---

## CEO 배정 예시 (daily_directive)

```
오늘 실험:
- 실험 A: 훅 스타일 테스트
  hypothesis: "감정공감형 훅이 정보형 훅보다 48h 조회수가 높다"
  variant_a: 감정공감형 → post_id_a: [발행 후 업데이트]
  variant_b: 정보형     → post_id_b: [발행 후 업데이트]
```

---

## DB 조회

```sql
-- 활성 실험 목록
SELECT id, hypothesis, variable, variant_a, variant_b, start_date
FROM experiments WHERE status = 'active' ORDER BY start_date DESC;

-- 완료 실험 결과
SELECT hypothesis, variable, verdict, confidence, start_date, end_date
FROM experiments WHERE status = 'closed' ORDER BY end_date DESC;

-- replicated 수준 인사이트
SELECT variable, verdict, COUNT(*) as n
FROM experiments
WHERE status = 'closed' AND confidence = 'replicated'
GROUP BY variable, verdict;
```

---

## 자율 실험 권한 체계

CEO(`minjun-ceo`)가 성과 데이터를 기반으로 실험을 자동 설계하고, 자율 레벨에 따라 승인 없이 실행하거나 시훈에게 승인을 요청한다.

### 레벨별 조건 및 범위

| Level | 이름 | 진입 조건 | 자율 실험 범위 |
|-------|------|----------|--------------|
| 0 | manual | 기본 | 모든 실험 시훈 승인 필요 |
| 1 | low-risk | 성공 3회+ | 훅 변형, 시간대 이동 자율 실행 |
| 2 | medium-risk | 성공 10회+ | 카테고리 비율 조정 자율 실행 |
| 3 | high-risk-only | 성공 20회+ | high-risk(새 카테고리, 톤 변경)만 승인 |

> **성공 기준**: `experiments.status = 'closed' AND verdict = 'success'`

### 실험 설계 트리거

| 우선순위 | 트리거 | 실험 유형 |
|---------|--------|----------|
| 1 | 하위 20% 카테고리 존재 | 포맷 실험 (리스트형 vs 비교형) |
| 2 | 신규 트렌드 키워드 | 시간대 실험 (08:00 vs 20:00) |
| 3 | 훅 반복 3회+ 감지 | 훅 실험 (반복 훅 vs 질문형) |

### 승인 플로우

```
designExperiment(performanceData)
  → proposeExperiment(design)
      ├─ risk ≤ autonomy_level → AUTO_APPROVED: executeApprovedExperiment()
      └─ risk > autonomy_level → PENDING_APPROVAL: agent_messages(sihun)
  → 48h 후 evaluateAndDecide(experimentId)
      ├─ WAIT: N h remaining
      └─ READY_FOR_EVALUATION → evaluateExperiment() → closeExperiment()
```

### 관련 코드

- `src/orchestrator/auto-experiment.ts` — 자율 실험 모듈
- `src/db/schema.ts` — `experiments.autonomy_level` 컬럼
