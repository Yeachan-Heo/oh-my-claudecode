# Threads2 Handoff — 2026-03-18 (세션 6)

## 현재 상태: PM 전략 수립 + 파이프라인 고도화 + 벤치마크 확장 수집 중

### 이번 세션(6) 완료 작업

| # | 작업 | 상태 |
|---|------|------|
| 1 | PM 전략 캔버스 (9섹션) — `/strategy` | ✅ |
| 2 | North Star 프레임워크 — `/north-star` (2단계: 답글비율 → 클릭수) | ✅ |
| 3 | GTM Plan — `/plan-launch` (워밍업→제휴 전환 타임라인) | ✅ |
| 4 | PM 보고서 PDF + MD 생성 (바탕화면) | ✅ |
| 5 | PM 보고서 리뷰 + 팩트 교정 + 신규 섹션 추가 (v2) | ✅ |
| 6 | pipeline.ts — todayOnly/source/analyzed_at 필터 추가 | ✅ |
| 7 | schema.ts — analyzed_at 컬럼 (thread_posts) | ✅ |
| 8 | schema.ts — source_type 컬럼 (aff_contents: trend/benchmark) | ✅ |
| 9 | schema.ts — trend_keywords 테이블 (X 트렌드 DB 저장) | ✅ |
| 10 | trend-fetcher.ts — 수집 후 99개 전부 DB 저장 | ✅ |
| 11 | trend-filter.ts — selected/reason DB 마킹 + Apify 중복호출 방지 | ✅ |
| 12 | run-trend-pipeline.ts — posts_collected 업데이트 | ✅ |
| 13 | 기존 499개 포스트 analyzed_at 마킹 (전부 분석완료 처리) | ✅ |
| 14 | X 트렌드 수집 + 필터 실행 (99개 → 2개 통과: 미세먼지, 로킷헬스케) | ✅ |
| 15 | 중복 트렌드 삭제 (198→99개) | ✅ |
| 16 | CLAUDE.md 생성 (쓰레드2 프로젝트 전용 규칙) | ✅ |
| 17 | DISCOVERY_GUIDE.md 생성 (검색 발굴 + 브라우저 검증 패턴) | ✅ |
| 18 | 벤치마크 채널 후보 21개 웹 검색 (건강7/생활7/다이어트7) | ✅ |
| 19 | 벤치마크 21개 채널 collect.ts 수집 (셸 루프) | 🔄 진행 중 |

### DB (Supabase PostgreSQL 17.6)

| 테이블 | 행 수 | 비고 |
|--------|-------|------|
| thread_posts | **499+** | 499(기존, analyzed_at 마킹) + 벤치마크 수집 진행 중 |
| needs | **64** | 쿠팡 바이어블 48개 |
| aff_contents | **12** | source_type 컬럼 추가 (trend/benchmark) |
| products | 2 | 쿠팡 파트너스 링크 |
| channels | 33 | verified 9개 + rejected 15개 + 21개 추가 예정 |
| trend_keywords | **99** | 오늘 X 트렌드 (selected 2개) |
| post_snapshots | 18 | @duribeon231 성과 |
| thread_comments | 68 | --with-comments 수집분 |

### 파이프라인 개선사항

**분석 파이프라인 (pipeline.ts)**:
- `todayOnly=true` (기본) — 오늘 수집한 포스트만 분석
- `--source benchmark|trend` — 소스별 분리 분석
- `--all` — 전체 미분석 포스트 대상
- `analyzed_at` — 분석 완료 자동 마킹 (중복 분석 방지)
- `source_type` — 생성된 콘텐츠에 소스 태깅 (성과 비교용)

**트렌드 파이프라인**:
- trend_keywords 테이블에 99개 전부 저장
- AI 필터 → selected=true/false + 이유 마킹
- Apify 중복 호출 방지 (오늘 DB에 있으면 재사용)

### PM 전략 보고서

바탕화면에 2개 파일:
- `빈이_채널전략_PM보고서_2026.pdf` (138KB)
- `빈이_채널전략_PM보고서_2026.md` (23KB)

내용: Strategy Canvas + North Star (답글 포스트 비율 80%) + GTM (워밍업→제휴 전환) + 수익 시뮬레이션 + A/B 테스트 설계

### 벤치마크 채널 확장 (진행 중)

21개 후보 (Exa 웹 검색으로 발굴):

**건강/영양제**: @yaksamom, @alpaca_yaksa, @yak_secret, @bibi_yaksa, @yaksa_tipbox, @jy_yaksa, @myyaksa
**생활용품**: @salimpop_official, @appasallim, @mingziroom, @sallim_gajang, @salrim.100, @salim_nam_official, @ilsangthd
**다이어트/운동**: @daani._.e, @hanjobody, @crush_kimcoka, @gubonkang_diet, @raybangfitness, @mimoade_, @hongpro_diet

수집 방식: `collect.ts`를 셸 루프로 순차 호출 (채널당 30개 포스트)
상태: 백그라운드 실행 중

### 가이드 문서 (신규)

| 문서 | 위치 | 핵심 |
|------|------|------|
| CLAUDE.md | 프로젝트 루트 | 세션 시작 시 가이드 읽기, 기존 도구 우선, 셸 루프 규칙 |
| DISCOVERY_GUIDE.md | src/agents/ | 검색 발굴 + 브라우저 검증 패턴, collect.ts 재사용 |
| COLLECTION_GUIDE.md | src/agents/ | CLI 수집 방법 |

### 핵심 규칙 (이번 세션에서 추가)

1. **가이드 문서 필수 참조** — 작업 전 DISCOVERY_GUIDE.md, COLLECTION_GUIDE.md 읽기
2. **기존 도구 재사용** — 새 스크립트 만들지 않기 (collect.ts, collect-by-keyword.ts 활용)
3. **5개+ 채널 수집 → 셸 루프** — for 루프로 collect.ts 반복 호출
4. **백그라운드 실행 시 파이프 금지** — `| tail`, `| head` 걸면 출력 버퍼링됨
5. **채널 검증 = collect.ts로 30개 수집 후 DB 데이터로 판단**

### 다음 세션 우선순위

#### 1. 벤치마크 수집 완료 확인 + DB 검증
- 21개 채널 수집 결과 확인 (존재 여부, 활동 여부, 참여율)
- 통과 채널 → channels 테이블에 is_benchmark=true 등록
- 실패 채널 → 대체 후보 검색

#### 2. 트렌드 vs 벤치마크 비교 분석
- 오늘 트렌드 키워드(미세먼지, 로킷헬스케)로 포스트 수집
- --source benchmark / --source trend 분리 분석
- 참여율/답글/조회수 비교 리포트

#### 3. trend-filter 개선
- 필터 통과율 2% (99개 중 2개) → 너무 낮음
- 식품(크루아상, 서브웨이), 생활 키워드 매핑 확대
- Claude 2단계 판단 추가 고려

#### 4. 워밍업 포스트 추가 게시
- 현재 5/20개, 15개 더 필요
- DB에 12개 콘텐츠 준비됨

#### 5. discover.ts 정리
- 가이드에서 웹 검색 API로 대체됨
- 삭제할지 사용자 확인 필요

### 수정한 파일

| 파일 | 변경 |
|------|------|
| `CLAUDE.md` | **신규** — 프로젝트 전용 규칙 (가이드 참조, 기존 도구, 파이프 금지) |
| `src/agents/DISCOVERY_GUIDE.md` | **신규** — 검색 발굴 + 검증 패턴 |
| `src/analyzer/pipeline.ts` | todayOnly/source/analyzed_at 필터 + 소스 태깅 |
| `src/db/schema.ts` | analyzed_at, source_type, trend_keywords 테이블 |
| `src/scraper/trend-fetcher.ts` | DB 저장 추가 |
| `src/scraper/trend-filter.ts` | DB 마킹 + Apify 중복 방지 |
| `scripts/run-trend-pipeline.ts` | posts_collected 업데이트 + drizzle import |
