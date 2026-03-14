# Handoff — P2 구현 완료, P2 검증/개선 대기

> 작성: 2026-03-14T03:40:00Z
> 브랜치: `feat/threads-watch-p0`
> 최신 커밋: (미커밋) ← `ffac8d54` (P1 개선)

## P2 구현 상태 — ALL TARGETS MET

| 완료 기준 | 상태 |
|-----------|------|
| 니즈 5개 입력 → 상품 후보 각 3개 이상 | PASS (6개 니즈 × 7~25개 매칭, 총 96건) |
| Threads 적합도 점수(1~5) 산출 | PASS (5차원 가중평균) |
| 상품별 포지셔닝 3가지 이상 제안 | PASS (18카드 × 3포맷) |
| 상품사전 50개 이상 구축 | PASS (50개, 13 카테고리) |
| "문제→상품→각도" 파이프라인 E2E 동작 | PASS (`npm run pipeline`) |

### P2 구현 파일

| 파일 | 역할 |
|------|------|
| `scripts/types.ts` | P2 타입 추가 (ProductEntry, ProductMatch, ThreadsScore, PositioningCard 등) |
| `data/product_dict/products_v1.json` | 초기 상품사전 50개 (6개 니즈 카테고리 전체 커버) |
| `scripts/product-matcher.ts` | P2-1 상품매칭 에이전트 — 니즈→상품 매칭 + 5차원 Threads 스코어링 |
| `scripts/positioning.ts` | P2-2 포지셔닝 에이전트 — 6포맷 라이브러리 + 훅 생성 |
| `scripts/run-pipeline.ts` | 오케스트레이터 확장 — 5단계 파이프라인 + P2 브리핑 섹션 |
| `package.json` | `products`, `positioning`, `pipeline:p1` 스크립트 추가 |

### P2 아키텍처

```
normalize → researcher → needs-detector → product-matcher → positioning
                                              ↓                    ↓
                                    products.json          positioning.json
                                              ↓                    ↓
                                         brief.md (통합 마케팅 브리핑)
```

### Threads 스코어링 5차원

| 차원 | 가중치 | 설명 |
|------|--------|------|
| naturalness | 0.25 | 소개 자연스러움 (가격<3만→+0.5) |
| clarity | 0.20 | 문제 해결 명확성 (L3+→+0.5) |
| ad_smell | 0.25 | 광고 냄새 안 남 |
| repeatability | 0.15 | 반복 노출 가능성 (키워드 매치→+) |
| story_potential | 0.15 | 후기/스토리 가능성 (외모건강/불편해소→+0.5) |

### 포지셔닝 6포맷

| 포맷 | 카테고리 우선순위 |
|------|-------------------|
| 문제공감형 | 불편해소, 외모건강, 자기표현 |
| 솔직후기형 | 전체 (범용) |
| 비교형 | 시간절약, 돈절약, 성과향상 |
| 입문추천형 | 성과향상, 시간절약, 자기표현 |
| 실수방지형 | 불편해소, 돈절약 |
| 비추천형 | 외모건강 |

## 다음 작업 — P2 개선 + P3 착수

### P2 개선 과제
1. **LLM 강화**: 규칙 기반 스코어링/훅 → LLM(sonnet)으로 업그레이드 (`--prompt` 출력 활용)
2. **상품사전 확장**: 실제 쿠팡파트너스 API/크롤링으로 링크 추가
3. **학습 피드백 연동**: `data/learnings/latest.json` → 매칭/포지셔닝 가중치 조정

### P3 착수 (콘텐츠 생성 + 성과분석)
1. [6] 콘텐츠 에이전트 — 포지셔닝 카드 → Threads 포스트 초안 (본문 3개 + 훅 5개 + 댓글 2개)
2. [7] 성과분석 에이전트 — 반응 데이터 → 학습 리포트 → 피드백 루프

## 실행 명령

```bash
# 전체 P2 파이프라인
npm run pipeline              # normalize→research→needs→products→positioning + brief

# P1만 (상품매칭 없이)
npm run pipeline:p1           # normalize→research→needs + brief

# 개별 실행
npm run products              # product-matcher만
npm run positioning           # positioning만

# 검증
npm run validate              # JS + tsc --noEmit
```

## 환경

- Chrome CDP: `cmd.exe /c start "" "C:\Users\campu\OneDrive\Desktop\Chrome (Claude).lnk"`
- gspread: `.venv/bin/python`, 스프레드시트 `1U-m4sJvV_EyELTRk7ECDYXLLlvF8Kqf4YmrjzVnDJgE`
- Node.js: v22.17.0, TypeScript: 5.9.3, tsx: 4.21.0
