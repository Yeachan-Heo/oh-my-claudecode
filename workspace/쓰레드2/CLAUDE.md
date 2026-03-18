# 쓰레드2 프로젝트 규칙

## 세션 시작 (필수)
- `handoff.md` 읽기
- 가이드 문서 읽기:
  - `src/agents/DISCOVERY_GUIDE.md` — 채널 발굴/검증 방법
  - `src/agents/COLLECTION_GUIDE.md` — 수집 방법 (CLI 우선)

## 기존 도구 우선 (hard)
- 기존 CLI 도구가 있으면 반드시 재사용한다. 새 스크립트를 만들지 않는다.
- 채널 포스트 수집: `src/scraper/collect.ts`
- 키워드 검색 수집: `scripts/collect-by-keyword.ts`
- 트렌드 수집: `src/scraper/trend-fetcher.ts`
- 트렌드 필터: `src/scraper/trend-filter.ts`
- 분석 파이프라인: `src/analyzer/pipeline.ts`
- 성과 추적: `scripts/track-performance.ts`

## 수집 규칙
- 5개 이상 채널 수집 시 셸 루프로 `collect.ts` 반복 호출
- 채널 검증 = `collect.ts`로 30개 수집 후 DB 데이터로 판단
- 채널 발굴은 웹 검색 API(Exa)로, Playwright는 검증/수집에만 사용
- **백그라운드 실행 시 파이프 금지** — `| tail`, `| head`, `| grep`을 걸면 출력이 버퍼링되어 진행 상황이 안 보임. `2>&1`만 사용

## 분석 규칙
- `pipeline.ts`는 기본적으로 오늘 수집한 미분석 포스트만 분석 (`todayOnly=true`)
- `--source benchmark|trend`로 소스별 분리 분석 가능
- `--all`로 전체 미분석 포스트 분석

## DB
- Supabase PostgreSQL (`db.smexrvpobdeszublfgwq.supabase.co`)
- 임시 DB 쿼리: `_` 접두사 스크립트 → 프로젝트 루트에서 실행 → 실행 후 삭제
- API 비용 $0 대안: `/threads-pipeline` 스킬 사용 (Claude Code가 직접 분석)
