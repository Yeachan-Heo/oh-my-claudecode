# P2 코드 품질 + 기능 강화 설계안

## 목표
Threads 쿠팡파트너스 파이프라인의 P2 (상품매칭 + 포지셔닝) 코드 품질 개선 및 기능 강화.
Claude Code 환경에서 동작해야 함 (외부 API 호출 없이, Claude Code 자체를 LLM으로 활용).

## 제약사항
- Anthropic API key 없음 — Claude Code 세션 내에서 직접 LLM 처리
- 쿠팡파트너스 링크는 수동 입력 (API 없음)
- 기존 50개 테스트 유지 (regression 방지)
- TypeScript strict mode, vitest 테스트 프레임워크
- 파이프라인: normalize → researcher → needs-detector → product-matcher → positioning

## Part 1: 코드 품질 (6건)

### 1-1. LearningEntry → types.ts 이동
- 현재: product-matcher.ts에 로컬 interface로 정의
- 변경: types.ts로 이동하여 재사용 가능하게

### 1-2. run-pipeline.ts 중복 인터페이스 제거
- 현재: ResearchData, NeedsData, ProductsData, PositioningData가 run-pipeline.ts에 로컬 정의
- 변경: types.ts에서 import (기존 타입 재사용 또는 필요 시 Pick/Partial)

### 1-3. 불필요한 as 캐스트 제거
- product-matcher.ts:193 `as NeedsCategory` — 이미 타입이 맞음
- product-matcher.ts:209 `as AffiliatePlatform` — 이미 타입이 맞음

### 1-4. positioning.ts 죽은 코드 제거
- positioning.ts:154-157 — template replace 코드 ({카테고리}, {N}, {M})가 실제로 매칭되지 않음
- angle_template에 해당 플레이스홀더가 없어서 replace가 no-op

### 1-5. silent catch → console.warn
- product-matcher.ts:376 — learnings 로드 실패 시 조용히 넘김
- run-pipeline.ts:106-107 — P2 데이터 로드 실패 시 조용히 넘김

### 1-6. JSON parse 런타임 검증
- product-matcher.ts: needs.json, products_v1.json 파싱 후 shape 검증
- positioning.ts: products.json 파싱 후 shape 검증
- 잘못된 파일 입력 시 명확한 에러 메시지

## Part 2: 기능 강화 (4건)

### 2-1. LLM 강화 (Claude Code = LLM)
현재: `--prompt` 플래그로 LLM 프롬프트 파일만 생성
개선: Claude Code가 프롬프트를 직접 처리하여 결과 작성

**워크플로우:**
1. `npm run pipeline --prompt` → 프롬프트 파일 생성 (기존)
2. 사용자: "LLM enhance 해줘"
3. Claude Code가 `*_products_prompt.txt` + `*_positioning_prompt.txt` 읽기
4. 개선된 결과를 `*_products_llm.json` + `*_positioning_llm.json`으로 작성
5. brief 생성 시 `*_llm.json` 우선 참조, 없으면 `*.json` fallback

**구현:**
- `scripts/llm-enhance.ts` — LLM 출력 스키마 검증 유틸리티 (실행 스크립트 아님)
- `validateLLMProductOutput()`, `validateLLMPositioningOutput()` 함수
- brief generator(`run-pipeline.ts`)에서 `*_llm.json` 우선 로드 로직

### 2-2. 훅 템플릿 확장
현재: 포맷별 2개 변형 (hash % 2로 선택)
개선: 포맷별 4~6개 변형으로 확장

- generateHook에서 hash % N (N=4~6)으로 선택
- 더 자연스러운 구어체, 다양한 화법 추가
- 기존 테스트 호환 유지 (deterministic hash 기반)

### 2-3. 학습 피드백 스키마
현재: LearningEntry 인터페이스만 있고, 실제 파일/스키마 없음
개선: 정식 타입 + 샘플 파일 + 로드 검증

- `LearningEntry` 타입을 types.ts에 정의
- `data/learnings/latest.json` 샘플 생성 (빈 배열)
- 로드 시 shape 검증 + console.warn

### 2-4. 상품사전 링크 필드
현재: ProductEntry에 affiliate_link 없음
개선: optional `affiliate_link?: string` 추가

- types.ts ProductEntry에 필드 추가
- brief에서 링크 있으면 표시
- 수동 입력 워크플로우 안내

## TDD 적용 범위

| 항목 | TDD | 이유 |
|------|-----|------|
| 1-1~1-4 | 아니오 | 타입 이동/삭제, 동작 변경 없음 |
| 1-5 console.warn | 예 | 동작 변경 |
| 1-6 JSON 검증 | 예 | 새 동작 |
| 2-1 LLM 검증 | 예 | 새 함수 |
| 2-2 훅 확장 | 예 | 동작 변경 |
| 2-3 학습 스키마 | 예 | 새 동작 |
| 2-4 링크 필드 | 아니오 | optional 타입만 |

## 기존 아키텍처

```
normalize → researcher → needs-detector → product-matcher → positioning
                                              ↓                    ↓
                                    products.json          positioning.json
                                              ↓                    ↓
                                         brief.md (통합 마케팅 브리핑)
```

개선 후:
```
normalize → researcher → needs-detector → product-matcher → positioning
                                              ↓                    ↓
                                    products.json          positioning.json
                                              ↓                    ↓
                                   [Claude Code LLM enhance]
                                              ↓                    ↓
                                  products_llm.json    positioning_llm.json
                                              ↓                    ↓
                                         brief.md (llm 우선 참조)
```
