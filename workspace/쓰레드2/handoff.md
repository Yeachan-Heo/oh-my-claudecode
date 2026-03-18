# Threads2 Handoff — 2026-03-18 (세션 5)

## 현재 상태: 전체 시스템 완성 + pm-skills 설치 + 성과 추적 자동화 완료

### DB (Supabase PostgreSQL 17.6)
- 연결: `postgresql://postgres:fkeldjstm3%23D@db.smexrvpobdeszublfgwq.supabase.co:5432/postgres`

| 테이블 | 행 수 | 비고 |
|--------|-------|------|
| thread_posts | **464** | 194(기존) + 270(벤치마크 9채널×30) |
| needs | **56** | 38(기존) + 18(신규). 쿠팡 바이어블 48개 |
| aff_contents | **7** | 2(기존) + 5(워밍업 공감형) |
| products | 2 | 쿠팡 파트너스 링크 |
| channels | 9 verified | 5개 모니터링 완료 |
| thread_comments | 0 | 미사용 |

### 수집 시스템 (GraphQL 인터셉션 적용)

**핵심 변경**: 3개 수집 경로 모두 GraphQL 대응 완료

| 수집 방식 | 파일 | GraphQL | 비고 |
|----------|------|---------|------|
| 키워드 검색 | `scripts/collect-by-keyword.ts` | ✅ 적용 | 테스트 통과, 20개 캡처 확인 |
| 채널 수집 | `src/scraper/collect.ts` | ✅ 적용 | 타입체크 통과, DOM 폴백 유지 |
| MCP 에이전트 | 스킬 가이드 업데이트 | ✅ CLI 권장 | `COLLECTION_GUIDE.md` 생성 |

**GraphQL 인터셉터**: `src/scraper/graphql-interceptor.ts` (신규)
- `page.on('response')`로 `/graphql/query` 응답 자동 캡처
- `searchResults.edges` (검색) + `mediaData.edges` (프로필) 두 형태 모두 처리
- DOM 파싱 자동 폴백

**개선 효과**:
- like_count: "1.8만" 파싱 → **정확한 정수** (18033)
- timestamp: "3일 전" → **정확한 unix epoch**
- text: UI 아티팩트 없이 깨끗한 본문
- 검색 1회 로드로 20개 포스트 캡처 (DOM은 개별 방문 필요)
- view_count는 여전히 개별 방문 필요 (GraphQL 미포함)

**추가 수정**:
- 키워드 검색 스크롤 5→10회 확대
- 최신순 탭 자동 전환 시도 (없으면 기본 정렬 폴백)

### 벤치마크 모니터링 결과 (5채널)

| 채널 | 평균조회 | 참여율 | 제휴% | 인사이트 |
|------|---------|--------|------|---------|
| ez_yaksa | 2,511 | **14.21%** | 0% | 전문 정보 + 논문 레퍼런스 |
| jonses98 | 675 | **15.84%** | 30% | 동료형 톤, 답글 최다 |
| manyjjju_yaksa | 1,551 | 1.68% | 20% | 약사 권위 + 리스트형 |
| peach_bly | 503 | 2.79% | 100% | 본문=정보, 후속글=쿠팡 분리 |
| ilipmaster_ | 1,227 | 0.24% | 90% | 과도한 제휴 → 참여 저하 |

### 페르소나 업그레이드 (persona-writer.md)

1. **문체 가이드라인 (데이터 기반)**
   - 163개 포스트 Top30 vs Bottom30 비교
   - 훅 20자 이내, 이미지 필수(80%), 이모지 0개, ㅜㅠ 적극 사용
   - SHORT-SHORT-TEXT-SHORT 구조, 137자 이내

2. **호모필리(Homophily) 원칙**
   - 빈이 = 전문가(↓)가 아니라 동료(→)
   - 건강/의료 안전 규칙: 효능 단정 금지, 개인 경험 한정

3. **심리 트리거 × 패턴 로테이션**
   - 4 트리거: 손실회피(3.3x), FOMO(1.7x), 사회적증거(1.3x), 선택과부하
   - 3 패턴: A(경험), B(공감), C(발견) = 12가지 조합 순환

### 심리 트리거 분석 결과 (464개 포스트)

| 트리거 | 평균 조회수 | 배수 | 최고 예시 |
|--------|-----------|------|----------|
| **손실회피** | 105,374 | **3.3x** | "협찬제품 샀다가 후회" (135만뷰) |
| **FOMO** | 66,406 | **1.7x** | "알고 나면 못 돌아감" |
| **사회적증거** | 46,887 | 1.3x | "다들 이거 쓰더라" |
| **선택과부하** | 28,709 | 0.7x | 조합 시 효과적 |

최강 조합: **손실회피 + 선택과부하** = 평균 12.6만뷰

### 이번 세션 완료 작업

| # | 작업 | 상태 |
|---|------|------|
| 1 | 벤치마크 9채널 × 30포스트 수집 (270개) | ✅ |
| 2 | 벤치마크 5채널 모니터링 + Obsidian 저장 | ✅ |
| 3 | 분석 파이프라인 실행 (277개 분류 + 니즈 56개) | ✅ |
| 4 | 워밍업 공감형 포스트 5개 생성 (DB 저장) | ✅ |
| 5 | persona-writer.md — 문체 가이드라인 (163개 분석) | ✅ |
| 6 | persona-writer.md — 호모필리 원칙 + 건강 안전 규칙 | ✅ |
| 7 | persona-writer.md — 심리 트리거 × 패턴 로테이션 | ✅ |
| 8 | 심리 트리거 분석 (손실회피 3.3x 발견) | ✅ |
| 9 | GraphQL 인터셉터 모듈 생성 + 3개 수집 경로 적용 | ✅ |
| 10 | X 트렌드 파이프라인 (fetcher + filter + orchestrator) | ✅ |
| 11 | 성과 추적 CLI (track-performance.ts) + DOM 폴백 수정 | ✅ |
| 12 | 미세먼지 트렌드 E2E 검증 (수집→댓글분석→니즈4개→콘텐츠3개) | ✅ |
| 13 | 벚꽃 수집 + 니즈 분석 (19포스트→니즈4개→콘텐츠2개) | ✅ |
| 14 | --with-comments 플래그 추가 (답글10개+ 포스트 댓글 수집) | ✅ |
| 15 | --today 옵션 (당일 수집분만 분석) 스킬 문서 추가 | ✅ |
| 16 | 빈이 페르소나 → 똘끼+밝은 자조형 캐릭터 업데이트 | ✅ |
| 17 | AI 냄새 제거 규칙 추가 (문장 미완성, 감정 먼저, 정보 1개) | ✅ |
| 18 | MCP 에이전트 CLI 수집 가이드 + COLLECTION_GUIDE.md | ✅ |
| 19 | 미세먼지 포스트 1개 게시 (@duribeon231) | ✅ |
| 20 | 벚꽃 포스트 텍스트 입력 (사진 첨부 대기 중) | 🔄 |

### 에이전트 프롬프트 (8개)

| 에이전트 | 용도 |
|---------|------|
| `researcher.md` | 포스트 → 리서치 브리핑 |
| `needs-detector.md` | 브리핑 → 니즈 클러스터링 (6단계 CoT) |
| `product-matcher.md` | 니즈 → 제품 매칭 |
| `positioning.md` | 니즈+제품 → 포지셔닝 카드 |
| `content.md` | 포지셔닝 → 콘텐츠 생성 |
| `persona-writer.md` | 빈이 페르소나 (문체+호모필리+심리 로테이션) |
| `performance.md` | 성과 분석 |
| `COLLECTION_GUIDE.md` | **신규** — 에이전트용 수집 방법 가이드 (CLI 우선) |

### 스킬 체계 (3개)

| 스킬 | 설명 |
|------|------|
| `/threads-pipeline` | 분석 파이프라인 (API $0, Phase 5.5 페르소나 리라이트 포함) |
| `/threads-post` | Threads 자동 포스팅 (CDP, anti-bot, 세션당 5개) |
| `/threads-analyze` | 채널 성과 분석 + **CLI 수집 권장 섹션 추가** |

### X 트렌드 파이프라인 (신규)

**흐름:**
```
Apify API → 한국 X 트렌딩 99개
  → trend-filter로 제품 연결 가능한 키워드 필터 (뷰티/건강 우선)
  → 필터된 키워드로 Threads 검색 수집 (collect-by-keyword.ts)
  → /threads-pipeline으로 니즈 분석 → 콘텐츠 생성 → 게시
```

**CLI:**
```bash
npx tsx scripts/run-trend-pipeline.ts           # 전체 자동 실행
npx tsx scripts/run-trend-pipeline.ts --dry-run  # 트렌드+필터만 (수집 안 함)
npx tsx src/scraper/trend-fetcher.ts             # 트렌드 수집만
npx tsx src/scraper/trend-filter.ts              # 필터링만
```

**테스트 결과 (2026-03-17):**
- 99개 트렌드 중 "미세먼지" 1개 통과 (나머지: 게임/연예/정치/스포츠)
- "미세먼지"로 Threads 검색 → 8개 포스트 수집
- 댓글 분석 결과 니즈 발견: 안경 김서림(3명), KF94 대량구매, 가습마스크, 알레르기, 목 보호

**댓글 수집 (`--with-comments` 구현 완료):**
```bash
npx tsx scripts/collect-by-keyword.ts --keywords "미세먼지" --with-comments
```
- 모든 키워드에 사용 가능 (미세먼지, 벚꽃, 선크림 등)
- 답글 10개 이상 포스트만 댓글 수집 → thread_comments 테이블 저장
- 기본은 본문만, `--with-comments` 붙이면 댓글도 수집

**당일 분석 (`--today` 옵션):**
```bash
/threads-pipeline --today    # 오늘 수집분만 분석
```
- `crawl_at >= CURRENT_DATE` 조건으로 당일 포스트만 대상

**비용:** Apify $0.04/회 (월 ~$1.20)

### 성과 추적 시스템 (신규)

**CLI:** `npx tsx scripts/track-performance.ts`

**동작:**
1. @duribeon231 포스트를 content_lifecycle에 자동 등록
2. 프로필 스크롤 → GraphQL로 engagement 일괄 수집
3. 개별 방문 → DOM에서 view_count 추출 (GraphQL에 없음)
4. DOM 폴백으로 좋아요/답글도 수집 (GraphQL 캡처 실패 시)
5. post_snapshots에 저장 + content_lifecycle 업데이트

**테스트 결과 (2026-03-17):**
| 포스트 | 조회수 | 좋아요 | 답글 | 참여율 |
|--------|--------|--------|------|--------|
| DV-FZd_geXn | 681 | 2 | 1 | 0.44% |
| DV8ld0QgYXa (선크림) | 976 | 3 | 6 | 0.92% |
| DV54gfFAdmj | 891 | 0 | 0 | 0.00% |

### Threads 알고리즘 조사 결과

- **니치 페널티 없음** — 유튜브와 달리 다양한 주제 포스팅 OK
- **핵심 신호 = 답글 깊이** — 좋아요보다 대화(multi-turn replies)가 중요
- "Threads doesn't want you to go viral. It wants you to spark discussions."
- 트렌드 주제로 포스팅해도 대화를 촉발하면 알고리즘 부스트

### DB 현황

| 테이블 | 행 수 | 비고 |
|--------|-------|------|
| thread_posts | ~490 | 464 + 미세먼지 8 + 벚꽃 19 |
| needs | **64** | 56기존 + 미세먼지4 + 벚꽃4 |
| aff_contents | **12** | 7워밍업 + 미세먼지3 + 벚꽃2 |
| post_snapshots | 6 | @duribeon231 성과 스냅샷 |
| thread_comments | 0 | --with-comments 구현 완료, 아직 미사용 |

### 다음 세션 우선순위

### 이번 세션(5) 추가 완료 작업

| # | 작업 | 상태 |
|---|------|------|
| 1 | track-performance.ts — DOM 폴백 포스트 발견 (직접 게시 포스트도 자동 추적) | ✅ |
| 2 | track-performance.ts — GraphQL→자동등록→lifecycle 순서 수정 | ✅ |
| 3 | 성과 추적 실행 — 5개 포스트 전체 추적 확인 | ✅ |
| 4 | pm-skills 8개 플러그인 설치 (다음 세션부터 사용 가능) | ✅ |
| 5 | 벚꽃 포스트 직접 게시 (사진 첨부) | ✅ |
| 6 | 미세먼지 마스크 포스트 게시 | ✅ |

### 성과 추적 최신 (2026-03-18)

| 포스트 | 조회수 | 좋아요 | 답글 | 참여율 | 상태 |
|--------|--------|--------|------|--------|------|
| DV-7LM (미세먼지 마스크) | 230 | 4 | 0 | 1.74% | warmup |
| DV-nld (벚꽃 피크닉) | 751 | 1 | 0 | 0.13% | warmup |
| DV-FZd (클렌징) | 947 | 4 | 8 | **1.27%** | early |
| DV8ld0 (선크림) | 978 | 3 | 6 | 0.92% | early |
| DV54gf (초기) | 891 | 0 | 0 | 0.00% | early |

**인사이트**: 클렌징 포스트가 답글 8개로 최다 참여. 질문형 마무리 + 공감 톤이 효과적.

### pm-skills 플러그인 (설치 완료, 다음 세션에서 활성화)

| 플러그인 | 주요 커맨드 | 쓰레드2 활용 |
|---------|-----------|------------|
| pm-product-discovery | `/discover` | 니즈 탐색 프레임워크 |
| pm-product-strategy | `/strategy` | 빈이 채널 전략 |
| pm-execution | `/write-prd` | 기능 기획 구조화 |
| pm-market-research | 페르소나/세그먼트 | 타겟 오디언스 분석 |
| pm-marketing-growth | `/north-star` | 핵심 지표 정의 |
| pm-go-to-market | `/plan-launch` | 워밍업→제휴링크 전환 계획 |
| pm-data-analytics | A/B 테스트 | 포스트 성과 비교 |
| pm-toolkit | 유틸리티 | 기타 PM 도구 |

### 다음 세션 우선순위

#### 1. pm-skills로 전략 수립
- `/strategy`로 빈이 채널 전략 정리
- `/north-star`로 핵심 지표 정의 (참여율? 전환율? 팔로워?)
- `/plan-launch`로 워밍업→제휴링크 전환 계획

#### 2. 워밍업 포스트 추가 게시
- 현재: 5개 게시
- DB에 콘텐츠 12개 준비됨
- 빈이 똘끼 톤으로 새로 생성 권장
- 15개 더 게시하면 워밍업 완료

#### 3. trend-filter 개선
- Claude 2단계 판단 추가
- 제품명 트렌드("네이처 클렌징폼", "리스테린") 잡기

#### 4. 빈이 프로필 이미지 + 소개
- 똘끼 캐릭터 (NanoBanana V2 프롬프트 준비됨)
- 소개: "이상한 거 사서 후회하는 기록 남기는 중 / 가끔 진짜 좋은 것도 찾음 (가끔)"

#### 5. 워밍업 20개 → 제휴링크 시작
- peach_bly 모델 (본문=정보, 후속글=쿠팡링크)

### 수정한 파일

| 파일 | 변경 |
|------|------|
| `src/scraper/graphql-interceptor.ts` | **신규** — GraphQL 응답 캡처 + 파싱 모듈 |
| `scripts/collect-by-keyword.ts` | GraphQL + --with-comments + 스크롤10회 + 최신순 |
| `src/scraper/collect.ts` | GraphQL 인터셉터 레이어 추가 (DOM 폴백 유지) |
| `src/agents/persona-writer.md` | 똘끼 캐릭터 + 문체 + 호모필리 + 심리 로테이션 + AI냄새 제거 |
| `src/agents/COLLECTION_GUIDE.md` | **신규** — 에이전트용 수집 방법 가이드 |
| `~/.claude/skills/threads-analyze/SKILL.md` | CLI 수집 권장 섹션 추가 |
| `~/.claude/skills/threads-pipeline/SKILL.md` | --today 옵션 추가 |
| `src/scraper/trend-fetcher.ts` | **신규** — Apify X 트렌드 수집 |
| `src/scraper/trend-filter.ts` | **신규** — 트렌드 → 제품 키워드 필터 |
| `scripts/run-trend-pipeline.ts` | **신규** — 트렌드 파이프라인 오케스트레이터 |
| `scripts/track-performance.ts` | **신규** — @duribeon231 성과 추적 CLI |
| `.env` | APIFY_TOKEN 추가 |
| `package.json` | apify-client 패키지 추가 |
