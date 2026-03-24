---
evaluator:
  command: npx tsx .omc/specs/auto-execute-upgrade/eval-auto-execute.ts
  format: json
  keep_policy: score_improvement
---

## Sandbox Rules

1. SKILL.md의 Step 1.3 섹션만 수정할 것
2. 기존 Step 1.2 (방법론), Step 1.5 (검증), Step 2~5는 변경 금지
3. 라우팅 테이블 형식 유지: `| 키워드 | 스킬 | 설명 |`
4. 복합 체인 형식 유지: `"트리거" (설명)\n  → step1 → step2`
5. test-cases.json은 수정 금지
6. eval-auto-execute.ts는 수정 금지
