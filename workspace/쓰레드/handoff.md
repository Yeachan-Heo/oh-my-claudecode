# Handoff — P0+P1 완료, ALL TARGETS MET

> 작성: 2026-03-13T09:00:00Z
> 브랜치: `feat/threads-watch-p0` (커밋 `61dfc87d` + uncommitted P1+TS work)

## 이번 세션 완료

### P1 Eval 정확도 — ALL TARGETS MET ✓

| Metric | Result | Target |
|--------|--------|--------|
| Tag accuracy | **86.7%** (26/30) | ≥70% |
| Signal precision | **100.0%** (0 FP) | ≥80% |
| Needs accuracy | **90.0%** (9/10) | ≥70% |

### 주요 변경 (이번 세션)

| 파일 | 변경 |
|------|------|
| `scripts/apply-gold-labels.ts` | 30개 gold label 전면 수정 (실제 포스트 텍스트+쿠팡링크 확인) |
| `scripts/researcher.ts` | L2 signal 패턴 정밀화 (과도한 `있(을까\|나\|어)` 제거) |
| `scripts/needs-detector.ts` | 키워드 확장 (메이크업/전시/향/레시피/품질 등) |
| `scripts/build-eval-set.ts` | 재빌드 방지 안전장치 (`--force` 없이 거부) |
| `plan2.md` | P1-3a 동결 정책 신설, P1 완료 기준 업데이트, TS 전환 반영 |
| `handoff.md` | 최종 상태 반영 |

### Eval 세트 동결 규칙 (중요)

- **`eval_set_v1.json` 재빌드 금지** — `build-eval-set.ts`는 `--force` 없이 거부됨
- 분류기 개선 시: `update-eval-tags.ts` → `apply-gold-labels.ts` → `eval-accuracy.ts`
- v2 eval set (100개)는 P2 이후 별도 생성

## 미커밋 파일 목록

```
scripts/
  types.ts, normalize-posts.ts, researcher.ts, needs-detector.ts,
  build-eval-set.ts, apply-gold-labels.ts, update-eval-tags.ts,
  eval-accuracy.ts, run-pipeline.ts
tsconfig.json, package.json
data/eval/eval_set_v1.json, data/eval/accuracy_report.json
data/canonical/posts.json, data/briefs/*, data/taxonomy.json
plan2.md, handoff.md
```

## 다음 작업 (우선순위순)

### 1. git 커밋 (즉시)
P1 작업물 전체를 커밋. 특히 `eval_set_v1.json`은 동결 보장을 위해 반드시 포함.

### 2. LLM 강화 — 잔여 4개 misclassification (P1 후속)
규칙 기반 한계 케이스:
- E-007: complaint→purchase_signal (보험 탐색 + 불만 동시)
- E-011, E-026: complaint→general (타로 조언에 부정 키워드)
- E-022: purchase_signal→general (사업자 자기 이야기)
→ opus 프롬프트로 컨텍스트 기반 분류 추가

### 3. citation rate + evidence 측정 (P1 잔여)
- 현재 규칙 기반 → LLM(opus) 리서치 실행 시 측정
- 목표: citation rate ≥ 80%, evidence ≥ 2/claim

### 4. 시훈 브리핑 검토 (P1 최종)
- `data/briefs/2026-03-13_brief.md` 확인
- "쓸만하다" 판단 → P1 공식 완료

### 5. P2: 상품매칭 + 포지셔닝 (다음 Phase)
- [4] 상품매칭 에이전트 프롬프트 작성
- [5] 포지셔닝 에이전트 프롬프트 작성
- 쿠팡파트너스 상품사전 50개 구축
- plan2.md Phase 2 섹션 참조

## 환경

- Chrome CDP: `cmd.exe /c start "" "C:\Users\campu\OneDrive\Desktop\Chrome (Claude).lnk"`
- gspread: `.venv/bin/python`, 스프레드시트 `1U-m4sJvV_EyELTRk7ECDYXLLlvF8Kqf4YmrjzVnDJgE`
- Node.js: v22.17.0, TypeScript: 5.9.3, tsx: 4.21.0

## 실행 명령

```bash
# 파이프라인
npm run pipeline        # 전체: normalize→research→needs→brief
npm run validate        # JS 문법 + tsc --noEmit

# Eval 워크플로 (분류기 개선 시)
npx tsx scripts/update-eval-tags.ts
npx tsx scripts/apply-gold-labels.ts
npx tsx scripts/eval-accuracy.ts
```
