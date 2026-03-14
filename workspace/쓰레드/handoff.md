# Handoff — P3 완료 (콘텐츠 생성 + 성과분석), 운영 단계 진입

> 작성: 2026-03-14T15:00:00Z
> 브랜치: `feat/threads-watch-p0`
> 최신 커밋: `57a666ae` (P3 pipeline integration)

## 완료 상태

### 전체 파이프라인 — 7단계 완성

```
normalize → researcher → needs-detector → product-matcher → positioning → content-generator → performance-analyzer
                                                                              ↓                       ↓
                                                                   content_drafts.json       analysis_report.json
                                                                                              learnings/latest.json
```

### P3 구현 — ALL TARGETS MET

| 완료 기준 | 상태 |
|-----------|------|
| 포지셔닝 카드 → 포스트 초안 (본문 3 + 훅 5 + 댓글 2) | PASS (18 drafts) |
| 포맷별 engagement 분석 | PASS (227 posts analyzed) |
| 시간대별 성과 패턴 | PASS (4 buckets: 새벽/오전/오후/밤) |
| 학습 피드백 자동 계산 → learnings.json | PASS (delta clamping [-2,2]) |
| 파이프라인 Step 6+7 통합 | PASS |

### 테스트 — 106/106 PASS

| 테스트 파일 | 테스트 수 | 대상 |
|-------------|-----------|------|
| product-matcher.test.ts | 40 | clamp, round1, parsePriceMin, assessCompetition, countKeywordMatches, scoreThreadsFitness, loadLearnings, validateProductDict, validateLearnings |
| positioning.test.ts | 16 | generateHook(4변형), buildVariant, CATEGORY_FORMATS, BASE_AVOID |
| product-dict.test.ts | 8 | 스키마 검증, 유니크, 카테고리 커버리지 |
| llm-enhance.test.ts | 5 | validateLLMProductOutput, validateLLMPositioningOutput |
| content-generator.test.ts | 22 | generatePostBody, generateHookVariants, generateSelfComments, buildContentDraft |
| performance-analyzer.test.ts | 15 | calcEngagementStats, analyzeTimePatterns, calcLearningDeltas |

```bash
npm test          # vitest run (106 tests)
npx tsc --noEmit  # 0 errors
```

## 파일 구조

| 파일 | 역할 |
|------|------|
| `scripts/types.ts` | 공유 타입 (P1~P3 전체) |
| `scripts/product-matcher.ts` | P2-1 상품매칭 + 스코어링 + 검증 |
| `scripts/positioning.ts` | P2-2 포지셔닝 6포맷 + 훅 4변형 |
| `scripts/llm-enhance.ts` | LLM 출력 스키마 검증 |
| `scripts/content-generator.ts` | P3-1 콘텐츠 생성 (본문/훅/댓글) |
| `scripts/performance-analyzer.ts` | P3-2 성과분석 (engagement/시간대/학습) |
| `scripts/run-pipeline.ts` | 오케스트레이터 (7단계 + flags) |
| `data/product_dict/products_v1.json` | 상품사전 50개 |
| `data/learnings/latest.json` | 학습 피드백 (performance-analyzer 출력) |

## 실행 명령

```bash
# 전체 파이프라인 (7단계)
npm run pipeline              # normalize→research→needs→products→positioning→content→analyze
npm run pipeline -- --brief   # + 브리핑 출력
npm run pipeline -- --prompt  # + LLM 프롬프트 생성

# 부분 실행
npm run pipeline:p1           # P1만 (normalize→research→needs)
npm run pipeline -- --content-only  # P3 콘텐츠만 (analyze 건너뜀)

# 개별 실행
npm run products              # product-matcher
npm run positioning           # positioning
npm run content               # content-generator
npm run analyze               # performance-analyzer

# 검증
npm test                      # vitest 106 tests
npm run validate              # JS + tsc --noEmit
```

## LLM 강화 워크플로우

```bash
# 1. 파이프라인 + 프롬프트 생성
npm run pipeline -- --prompt --brief

# 2. Claude Code에게 "LLM enhance 해줘"
#    → *_products_prompt.txt, *_positioning_prompt.txt, *_content_prompt.txt 읽기
#    → 개선 결과를 *_llm.json으로 작성

# 3. brief 재생성 (자동으로 *_llm.json 우선 참조)
npm run pipeline -- --brief
```

## 다음 작업

### 운영 단계
1. **쿠팡 링크 입력**: products_v1.json에 affiliate_link 수동 추가
2. **콘텐츠 게시**: content_drafts.json → Threads에 실제 포스팅
3. **성과 추적**: 게시 후 데이터 재수집 → `npm run analyze` → 학습 피드백 축적

### 기능 확장
1. **Google Sheets 연동**: 콘텐츠 초안 → 포스트 관리 시트 자동 기록
2. **자동 수집 스케줄링**: 주기적 크롤링 + 분석 자동화
3. **트렌드 상관분석**: 90일 데이터 축적 후 S-6~S-8 착수

## 커밋 히스토리 (이번 세션)

| 커밋 | 내용 |
|------|------|
| `e192d96f` | P2 리팩토링 (LearningEntry, angle, casts) |
| `24b2e757` | countKeywordMatches 버그 수정 |
| `92902c72` | console.warn + JSON 검증 |
| `5ef6d081` | 훅 확장 + 학습 검증 + affiliate_link |
| `81d7d5c8` | LLM 검증 + *_llm.json 로드 |
| `df1acf23` | 타입 통합 |
| `0ecdab5c` | P3 타입 + content-generator |
| `4373d343` | performance-analyzer |
| `57a666ae` | P3 pipeline 통합 |

## 환경

- Chrome CDP: `cmd.exe /c start "" "C:\Users\campu\OneDrive\Desktop\Chrome (Claude).lnk"`
- gspread: `.venv/bin/python`, 스프레드시트 `1U-m4sJvV_EyELTRk7ECDYXLLlvF8Kqf4YmrjzVnDJgE`
- Node.js: v22.17.0, TypeScript: 5.9.3, tsx: 4.21.0
