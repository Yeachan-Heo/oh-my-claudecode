# 실험 로그 (Experiment Log)

> 가설 → 실험 → 검증 결과 기록. **append-only.**

---

## 사용 방법

새 실험은 파일 끝에 추가. 수정 금지. verdict 판정 후 해당 항목에 결과 추가.

```
## EXP-YYYY-MM-DD-N

### 가설
[무엇이 무엇보다 더 나을 것이다]

### 변수
- variant_a: [A 조건]
- variant_b: [B 조건]

### 실행
- start_date: YYYY-MM-DD
- end_date: YYYY-MM-DD
- post_ids: [ID 목록]

### 결과
- variant_a 조회수: N뷰
- variant_b 조회수: N뷰
- 참여율 차이: +N%

### Verdict
- status: directional | replicated | inconclusive
- confidence: low | medium | high
- 전략 반영: O/X → [반영 내용]
```

**신뢰도 기준**:
- n=1 → `directional` (방향성 참고만)
- 3회 일관된 방향 → `replicated` (전략 반영)

---

<!-- 실험 기록은 이 아래에 추가 -->
