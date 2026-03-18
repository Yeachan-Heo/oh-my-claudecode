# Threads2 Handoff — 2026-03-18 (세션 6)

## 현재 상태: PM 전략 수립 + 파이프라인 고도화 + 벤치마크 확장 수집 + 트렌드 에이전트 + 콘텐츠 게시

### 이번 세션(6) 완료 작업

| # | 작업 | 상태 |
|---|------|------|
| 1 | PM 전략 캔버스 (9섹션) — `/strategy` | ✅ |
| 2 | North Star 프레임워크 — `/north-star` (2단계: 답글비율 → 클릭수) | ✅ |
| 3 | GTM Plan — `/plan-launch` (워밍업→제휴 전환 타임라인) | ✅ |
| 4 | PM 보고서 PDF + MD 생성 (바탕화면) + v2 리뷰 교정 | ✅ |
| 5 | pipeline.ts — todayOnly/source/analyzed_at 필터 추가 | ✅ |
| 6 | schema.ts — analyzed_at (thread_posts), source_type (aff_contents), trend_keywords 테이블 | ✅ |
| 7 | trend-fetcher.ts — DB 저장 + trend-filter.ts — 에이전트 방식 교체 | ✅ |
| 8 | trend-analyzer.md — 에이전트 프롬프트 생성 (직장인 관점, 지역맛집 스킵) | ✅ |
| 9 | X 트렌드 수집 (99개) + 에이전트 분석 (8개 선택, 기존 규칙 2개 → 4배) | ✅ |
| 10 | 중복 트렌드 삭제 (198→99) + Apify 중복호출 방지 | ✅ |
| 11 | CLAUDE.md (쓰레드2 전용) + DISCOVERY_GUIDE.md 생성 | ✅ |
| 12 | 벤치마크 채널 후보 21개 웹 검색 (건강7/생활7/다이어트7) | ✅ |
| 13 | 벤치마크 21개 채널 collect.ts 셸 루프 수집 | 🔄 17/21 완료 |
| 14 | 목이버섯 포스트 게시 (@duribeon231) + 댓글 대응 | ✅ |
| 15 | 점심 도시락 포스트 게시 (@duribeon231) + 댓글 대응 | ✅ |
| 16 | 목이버섯 요리 이미지 수집 (바탕화면 /목이버섯/, /목이버섯_중국/) | ✅ |
| 17 | 뷰티/건강 브랜드 리서치 (~40개 브랜드 목록 정리) | ✅ |

### 게시된 포스트 (총 7개, 워밍업 13개 남음)

| # | 주제 | 상태 | 댓글 |
|---|------|------|------|
| 1~5 | 기존 (클렌징, 선크림, 미세먼지 등) | 게시 완료 | - |
| 6 | 목이버섯 (철분, 직장인 퇴근 후 간편식) | 게시 완료 | @michu_dora 탕수육 레시피 → 공감 답변 |
| 7 | 점심 도시락 (직장인 20만원/월 절약) | 게시 완료 | @sallynsnoopy 계란+고구마 팁, @studio_2nd_ 여름 냄새 팁 → 답변 |

### DB (Supabase PostgreSQL 17.6)

| 테이블 | 행 수 | 비고 |
|--------|-------|------|
| thread_posts | **499 + 수집중** | 499(기존 analyzed_at 마킹) + 벤치마크 17채널 수집 완료 |
| needs | **64** | 쿠팡 바이어블 48개 |
| aff_contents | **12** | source_type 컬럼 추가 (trend/benchmark) |
| trend_keywords | **99** | 오늘 X 트렌드 (selected 8개 — 에이전트 분석) |
| channels | 33 + 21예정 | verified 9 + rejected 15 + 21개 벤치마크 추가 예정 |

### 파이프라인 변경사항

**분석 파이프라인 (pipeline.ts)**:
- `todayOnly=true` 기본 — 오늘 수집 미분석 포스트만
- `--source benchmark|trend` — 소스별 분리 분석
- `analyzed_at` — 분석 완료 자동 마킹
- `source_type` — 콘텐츠에 소스 태깅

**트렌드 파이프라인**:
- `trend-fetcher.ts` → 99개 DB 저장
- `trend-analyzer.md` (에이전트, Opus) → 99개 전부 판단 ($0)
- `trend-filter.ts` → DB 마킹 헬퍼만 (규칙 기반 제거됨)
- Apify 중복호출 방지 (DB 재사용)

**트렌드 에이전트 분석 결과 (2026-03-18)**:
- 99개 → 8개 선택 (8%): 미세먼지, 크루아상, 크로와상, 서브웨이, 할라피뇨, 목이버섯, 카트리지, 개강 2주동안
- 기존 규칙 기반 2개 → 에이전트 8개 (4배 향상)
- 직장인 관점 + 지역맛집 스킵 + 쿠팡 제품 연결 기준

### 가이드 문서

| 문서 | 핵심 |
|------|------|
| CLAUDE.md | 세션 시작 시 가이드 읽기, 기존 도구 우선, 파이프 금지, 셸 루프 |
| DISCOVERY_GUIDE.md | 검색 발굴 + 브라우저 검증, collect.ts 재사용 |
| COLLECTION_GUIDE.md | CLI 수집 방법 |
| trend-analyzer.md | 트렌드 키워드 분석 에이전트 (직장인 관점) |

### 핵심 규칙 (이번 세션 추가)

1. 가이드 문서 필수 참조 (DISCOVERY_GUIDE.md, COLLECTION_GUIDE.md)
2. 기존 도구 재사용 — 새 스크립트 만들지 않기
3. 5개+ 채널 수집 → 셸 루프
4. 백그라운드 실행 시 `| tail` 파이프 금지
5. 채널 검증 = collect.ts 30개 수집 후 DB 데이터로 판단
6. 트렌드 필터 = 에이전트(trend-analyzer.md)로 판단, 규칙 사전 아님

### 벤치마크 확장 (진행 중)

21개 후보 (Exa 웹 검색 발굴 → collect.ts 셸 루프 수집):

**건강/영양제**: @yaksamom, @alpaca_yaksa, @yak_secret, @bibi_yaksa, @yaksa_tipbox, @jy_yaksa, @myyaksa
**생활용품**: @salimpop_official, @appasallim, @mingziroom, @sallim_gajang, @salrim.100, @salim_nam_official, @ilsangthd
**다이어트/운동**: @daani._.e, @hanjobody, @crush_kimcoka, @gubonkang_diet, @raybangfitness, @mimoade_, @hongpro_diet

수집 상태: 17/21 완료, 나머지 4개 진행 중

### 다음 세션 우선순위

#### 1. 브랜드 DB + 이벤트 모니터링 스킬 (신규)
- `brands` 테이블 생성 (~40개 브랜드 하드코딩)
- `brand_events` 테이블 (이벤트/신제품/세일 정보)
- 매일 웹 검색으로 브랜드별 새 소식 수집
- 빈이가 다룰 수 있는 이벤트 필터 → 포스트 생성

브랜드 목록 (리서치 완료):
- **스킨케어**: 이니스프리, 라네즈, 미샤, 토코보, 조선미녀, 코스알엑스, 아누아, 라운드랩, 닥터지, 마녀공장 등
- **메이크업**: 클리오, 롬앤, 페리페라, 바닐라코, 에뛰드, 헤라 등
- **건강/영양제**: 종근당, 대웅제약, 유한양행, 동아제약, 광동제약, 고려은단 등
- **리테일러**: 올리브영, 시코르, 무신사 뷰티

#### 2. 벤치마크 수집 완료 + DB 검증
- 21개 채널 수집 결과 확인 (존재/활동/참여율)
- 통과 채널 → channels 테이블에 is_benchmark=true 등록
- 실패 채널 → 대체 후보

#### 3. 트렌드 vs 벤치마크 비교 분석
- 오늘 트렌드 키워드(미세먼지 등)로 Threads 포스트 수집
- `--source benchmark` vs `--source trend` 분리 분석
- 참여율/답글/조회수 비교 리포트

#### 4. trend-filter.ts 에이전트 연동 자동화
- 현재: 수동으로 에이전트 호출 → JSON → applyAnalysis()
- 목표: 스킬에서 자동으로 에이전트 호출 → DB 마킹 → 수집까지 원클릭

#### 5. 워밍업 포스트 추가
- 현재 7/20, 13개 남음
- 트렌드 키워드 활용 (크루아상, 서브웨이, 할라피뇨 등)

### PM 전략 보고서 (바탕화면)

- `빈이_채널전략_PM보고서_2026.pdf` (138KB)
- `빈이_채널전략_PM보고서_2026.md` (23KB)

### 수정한 파일

| 파일 | 변경 |
|------|------|
| `CLAUDE.md` | **신규** — 프로젝트 규칙 |
| `src/agents/DISCOVERY_GUIDE.md` | **신규** — 검색 발굴 + 검증 패턴 |
| `src/agents/trend-analyzer.md` | **신규** — 트렌드 키워드 분석 에이전트 |
| `src/analyzer/pipeline.ts` | todayOnly/source/analyzed_at + source_type 태깅 |
| `src/db/schema.ts` | analyzed_at, source_type, trend_keywords 테이블 |
| `src/scraper/trend-fetcher.ts` | DB 저장 추가 |
| `src/scraper/trend-filter.ts` | 에이전트 방식으로 전면 교체 (규칙 기반 제거) |
| `scripts/run-trend-pipeline.ts` | posts_collected + drizzle import |
