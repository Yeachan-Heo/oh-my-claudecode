# 쓰레드2 프로젝트 규칙

## 세션 시작 (필수)
- `handoff.md` 읽기
- 가이드 문서 읽기:
  - `src/agents/DISCOVERY_GUIDE.md` — 채널 발굴/검증 방법
  - `src/agents/COLLECTION_GUIDE.md` — 수집 방법 (CLI 우선)
  - `src/agents/brand-researcher.md` — 브랜드 리서치 에이전트 스펙
  - `src/agents/performance-analyzer.md` — 성과분석 에이전트 스펙

## API 금지 (hard)
- Anthropic API 직접 호출 금지 (`@anthropic-ai/sdk` 삭제됨, `callLLM()` 없음)
- 분석/생성은 반드시 Claude Code가 스킬을 통해 직접 수행
- `src/analyzer/` 모듈은 유틸 함수만 제공:
  - `topic-classifier.ts` — TAG_MAP 규칙 기반 분류 (LLM 없음)
  - `product-matcher.ts` — 쿠팡 CDP 검색 + DB 조회 (LLM 없음)
  - `content-generator.ts` — 포맷 선택, 워밍업 감지, 훅 새니타이징 (LLM 없음)

## 기존 도구 우선 (hard)
- 기존 CLI 도구가 있으면 반드시 재사용한다. 새 스크립트를 만들지 않는다.
- 채널 포스트 수집: `src/scraper/collect.ts`
- 키워드 검색 수집: `scripts/collect-by-keyword.ts`
- 트렌드 수집: `src/scraper/trend-fetcher.ts`
- 트렌드 필터: `src/scraper/trend-filter.ts`
- 분석 파이프라인: `/threads-pipeline` 스킬 (Claude Code 직접 분석, API 비용 $0)
- 성과 수집: `scripts/track-performance.ts`
- 성과 분석: `/analyze-performance` 스킬 (Claude Code 직접 분석)
- 브랜드 리서치: `scripts/research-brands.ts`
- 네이버 카페 수집: `scripts/collect-naver-cafe.ts` (`npm run collect:cafe`)
- 더쿠 수집: `scripts/collect-theqoo.ts` (`npm run collect:theqoo`)
- 인스티즈 수집: `scripts/collect-instiz.ts` (`npm run collect:instiz`)
- YouTube 댓글 수집: `scripts/collect-youtube-comments.ts` (`npm run collect:youtube`)
- YouTube 니즈 분석: `src/agents/youtube-needs-analyzer.md` 가이드 참조 (Claude Code 직접 분석)
- **YouTube 채널 발굴: `scripts/discover-youtube-channels.py`** (scrapetube, API 쿼터 0) — 채널 검색/검증은 반드시 이 스크립트 사용. YouTube Data API로 채널 검색 금지 (쿼터 낭비)
- **포스트 작성 시 토론 시스템 필수** (hard):
  - `src/agents/post-debate-system.md` — 가이드+빈이 토론 시스템 (단독 작성 금지)
  - `src/agents/post-writing-guide.md` — 조회수 1만+ 209개 분석 기반 글쓰기 지침서
  - `src/agents/content.md` — 빈이 페르소나 + 6단계 CoT
  - 포스트 작성 = 반드시 가이드 에이전트 + 빈이 에이전트 토론 → 체크리스트 통과 → 승인 후 전달

## 수집 규칙
- 5개 이상 채널 수집 시 셸 루프로 `collect.ts` 반복 호출
- 채널 검증 = `collect.ts`로 30개 수집 후 DB 데이터로 판단
- 채널 발굴은 웹 검색 API(Exa)로, Playwright는 검증/수집에만 사용
- **백그라운드 실행 시 파이프 금지** — `| tail`, `| head`, `| grep`을 걸면 출력이 버퍼링되어 진행 상황이 안 보임. `2>&1`만 사용

## 분석 규칙
- 분석은 `/threads-pipeline` 스킬로 실행 (Claude Code 직접 분석, API 비용 $0)
- `--today`로 오늘 수집분만, `--category 뷰티`로 카테고리별, `--skip-content`로 니즈+매칭만
- 포스트에 `post_source` 컬럼으로 수집 소스 태깅

## 트렌드 파이프라인 흐름
- Step 1: `fetchTrends()` → X 트렌드 99개 → `trend_keywords` 테이블 저장 (자동)
- Step 2: Claude Code가 `trend-analyzer.md`로 분석 → `selected=true` 마킹 (**에이전트 개입 필요**)
- Step 3: 선택된 키워드로 `collect-by-keyword.ts` 호출
- **주의**: Step 3 수집 시 `post_source='x_trend'` 태깅 필요 (현재 미구현 — keyword_search로 태깅됨)

## 소스 체계 (post_source)
| 소스 | 설명 | 수집 도구 |
|------|------|----------|
| `brand` | 브랜드 DB 기반 이벤트/신제품 리서치 | `research-brands.ts` + Exa |
| `keyword_search` | 일반 키워드로 Threads 검색 | `collect-by-keyword.ts` |
| `x_trend` | X 트렌드 기반 | `run-trend-pipeline.ts` |
| `benchmark` | 벤치마크 채널 정기 수집 | `collect.ts` 루프 |

## 워밍업 전략
- 현재 **7/20개** 완료, 13개 남음
- 첫 20개 포스트: 광고/셀프댓글 없이 순수 콘텐츠만 발행
- 비광고형 앵글: 실생활 공감, 정보 공유, 질문형
- 워밍업 완료 후 제휴 콘텐츠 + 셀프댓글 시작

## 이벤트 유효기간 규칙
- `brand_events`: **7일 이내만 유효** (`is_stale=false`)
- 7일 초과 시 `is_stale=true` 마킹
- 브랜드 리서치 재실행 전 stale 마킹 선행
- `is_used=true`인 이벤트는 콘텐츠에 이미 사용됨

## 성과분석 규칙
- **절대 수치 우선**: 조회수, 좋아요, 댓글, 리포스트, 참여율
- 속도 지표(velocity)는 보조로만 사용
- 매일 실행: `track-performance.ts` (수집) → `/analyze-performance` (분석)
- 결과 `daily_performance_reports` 테이블에 저장
- 콘텐츠 패턴 분석: 어떤 주제/포맷/훅이 반응 좋은지 추적
- 전일 대비 성장 추이 비교

## DB
- Supabase PostgreSQL — **Shared Pooler (IPv4)**
  - 호스트: `aws-1-ap-northeast-1.pooler.supabase.com:6543`
  - 직접 연결(`db.xxx.supabase.co`)은 IPv6 전용 → WSL2에서 연결 불가
- 임시 DB 쿼리: `_` 접두사 스크립트 → 프로젝트 루트에서 실행 → 실행 후 삭제
- 주요 테이블: `brands`(40개), `brand_events`, `thread_posts`(post_source), `daily_performance_reports`, `post_snapshots`, `content_lifecycle`, `community_posts`(source_platform: naver_cafe|theqoo|instiz|youtube)
