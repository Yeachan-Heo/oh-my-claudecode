# Threads2 Handoff — 2026-03-20 (세션 9)

## 현재 상태: 커뮤니티 크롤러 확장 완료 (인스티즈 + YouTube), 파서 버그 수정, 속닥 발견

### 이번 세션(9) 완료 작업

| # | 작업 | 상태 |
|---|------|------|
| 1 | 마이그레이션 정리 — 충돌 4파일 → 깨끗한 1파일 재생성 | ✅ |
| 2 | CLAUDE.md 업데이트 — community_posts + 수집 도구 추가 | ✅ |
| 3 | 인스티즈 크롤러 구현 — types/parser/fetcher/collector + CLI + 에이전트 가이드 | ✅ |
| 4 | 네이버 카페 모듈 분리 — 676줄 → ~120줄 CLI + src/scraper/naver-cafe/ 4파일 | ✅ |
| 5 | 더쿠 파서 버그 수정 — viewCount(항상 16), postedAt(항상 null) 수정 + 뷰티 보드 추가 | ✅ |
| 6 | 인스티즈 파서 버그 수정 — postedAt null, 댓글 0, 제목 오염, 중복, commentCount 5개 버그 수정 | ✅ |
| 7 | 16시간 필터 추가 — 더쿠/인스티즈 collector에 stale 스킵 로직 | ✅ |
| 8 | 커뮤니티 리서치 — 10개 사이트 조사, 속닥(socdoc.co.kr) 1순위 발견 | ✅ |
| 9 | YouTube 댓글 수집 모듈 구축 — Data API v3, types/api/channels/collector/CLI | ✅ |
| 10 | YouTube 채널 리서치 — 16개 채널 검증, 10개 시드 등록 | ✅ |
| 11 | YouTube 첫 수집 — 10영상, 700댓글 수집 성공 | ✅ |
| 12 | 더쿠 기본 보드 hot → beauty 변경 | ✅ |
| 13 | YouTube 댓글 429개 니즈 분석 — 183개(42.7%) 니즈 발견, 리포트 작성 | ✅ |
| 14 | YouTube 답글(reply) 수집 기능 추가 — replyCount>=2 스레드의 답글 수집 | ✅ |
| 15 | YouTube 기본값 변경 — daysBack 7→2, maxComments 100→300 | ✅ |
| 16 | YouTube API 키 로테이션 — 3개 키 자동 전환 (403 시 다음 키) | ✅ |
| 17 | YouTube 채널 발굴 스크립트 — discover-youtube-channels.py (yt-dlp+scrapetube, API 쿼터 0) | ✅ |
| 18 | YouTube 채널 59개 등록 — 뷰티 키워드 9개 병렬 검색, 구독자 2만+ 기준 | ✅ |
| 19 | 대본 자동 요약 — 10K자 초과 시 규칙 기반 추출형 압축 | ✅ |
| 20 | YouTube 59채널 전체 수집 — 29영상, 1,418댓글, 대본 포함 | ✅ |
| 21 | YouTube 댓글 니즈 분석 (Phase 1~4) — 15영상 분석, 5개 콘텐츠 기획+초안 | ✅ |
| 22 | YouTube 채널 발굴 스크립트 yt-dlp 기반 재작성 (API 쿼터 0) | ✅ |
| 23 | 포스트 작성 지침서 — 조회수 1만+ 209개 분석 기반 5대 패턴 | ✅ |
| 24 | 포스트 토론 시스템 — 가이드+빈이 에이전트 2인 토론 (단독 작성 금지) | ✅ |
| 25 | YouTube 수집 병렬화 — --from/--to 옵션 추가 | ✅ |
| 26 | YouTube 중복 수집 방지 — DB 사전 체크 (API+yt-dlp 시간 절약) | ✅ |

### 수집 시스템 현황

```
[Threads]        src/scraper/collect.ts              (Playwright CDP)     ✅ 기존
[키워드검색]     scripts/collect-by-keyword.ts        (Playwright CDP)     ✅ 기존
[네이버카페]     scripts/collect-naver-cafe.ts        (Playwright CDP)     ✅ 모듈 분리 완료
                 src/scraper/naver-cafe/              (types, parser, collector, index)

[더쿠]           scripts/collect-theqoo.ts            (HTTP + cheerio)     ✅ 파서 수정 완료
                 src/scraper/theqoo/                  (types, parser, fetcher, collector)

[인스티즈]       scripts/collect-instiz.ts             (HTTP + cheerio)     ✅ 신규
                 src/scraper/instiz/                  (types, parser, fetcher, collector)

[YouTube]        scripts/collect-youtube-comments.ts  (YouTube API v3)     ✅ 신규
                 src/scraper/youtube/                 (types, api, channels, collector)

[채널 발굴]      scripts/discover-youtube-channels.py  (yt-dlp+scrapetube, 쿼터 0)  ✅
```

### YouTube 채널 현황
- 시드 채널: 59개 (메이크업 13, 리뷰 11, 가성비 11, 루틴 10, 피부고민 9, 비교 4, 남성뷰티 1)
- 구독자 범위: 2만~190만
- API 키: 3개 (일일 30,000 units)
- 수집 설정: 2일 이내 영상, 댓글 300개, 답글 포함

### 니즈 분석 결과
- data/needs-analysis-2026-03-20.md — 전체 커뮤니티 니즈 분석
- data/youtube-needs-analysis-2026-03-20.md — YouTube 429댓글 심층 분석
- 니즈 Top 3: 제품 추천 요청(61건), 구매 의향(34건), 피부 고민(30건)
- Threads 소재 Top 3: 더블웨어 리뷰, 지성vs건성 파데 비교, 속건조 토너 해결

### DB 테이블

```
[Threads 수집]      thread_posts → content_lifecycle → post_snapshots → daily_performance_reports
[커뮤니티 수집]     community_posts (naver_cafe | theqoo | instiz | youtube)
[브랜드]           brands → brand_events
[기타]             channels, needs, aff_contents, trend_keywords
```

### 수집 데이터 현황

| 소스 | 수집량 |
|------|--------|
| thread_posts | 1,100개 |
| community_posts (naver_cafe) | ~15개 |
| community_posts (theqoo) | ~7개 |
| community_posts (instiz) | ~5개 |
| community_posts (youtube) | ~10영상 700댓글 |
| 워밍업 포스트 | 7/20개 |

### YouTube 시드 채널 (10개)

| 채널 | 카테고리 | 구독자 |
|------|----------|--------|
| 로지선 RohJiSun | 리뷰 | 55.7K |
| 알라 ALLA BEAUTY | 리뷰 | 34K |
| 박비비 VIVI | 리뷰 | 82.3K |
| 화니 HWANE | 리뷰 | 169K |
| 담쓰 Dams Beauty | 피부고민 | 208K |
| 제이나 Jaina | 비교 | 284K |
| 빛날영 bitnal young | 가성비 | 139K |
| 아우라M | 가성비 | 125K |
| 효블리 Hyovely | 루틴 | 122K |
| 뽐니 bbomni | 루틴 | 228K |

### 커뮤니티 확장 로드맵

```
data/community-research.md 참고

Phase 1 (HTTP+cheerio): 속닥(socdoc.co.kr) ← 1순위, 네이트판, DC미용갤
Phase 2 (Playwright):   글로우픽, 언니의파우치
```

### 카페 정보

| 카페 | cafeId | clubid | 가입 |
|------|--------|--------|------|
| 아프니까 사장이다 | jihosoccer123 | 23611966 | 가입됨 |
| 직장인 탐구생활 | workee | 24470111 | 미가입 |
| 파우더룸 | cosmania | 10050813 | 미확인 |

### 참고 파일

- `data/community-research.md` — 커뮤니티 10개 사이트 조사 결과
- `data/youtube-channels.md` — YouTube 16개 채널 리서치 결과
- `docs/superpowers/plans/2026-03-20-youtube-beauty-comments.md` — YouTube 구현 계획서
- `src/agents/youtube-crawler.md` — YouTube 크롤러 에이전트 가이드
- `src/agents/instiz-crawler.md` — 인스티즈 크롤러 에이전트 가이드
- `scripts/discover-youtube-channels.py` — YouTube 채널 발굴 (yt-dlp+scrapetube, API 쿼터 0)
- `data/youtube-needs-analysis-2026-03-20.md` — YouTube 댓글 니즈 심층 분석
- `data/needs-analysis-2026-03-20.md` — 전체 커뮤니티 니즈 분석
- `src/agents/post-writing-guide.md` — 조회수 1만+ 209개 분석 기반 글쓰기 지침서
- `src/agents/post-debate-system.md` — 가이드+빈이 토론 시스템 (포스트 작성 필수)
- `src/agents/youtube-needs-analyzer.md` — YouTube 니즈 분석 4-Phase 가이드

### 포스트 작성 시스템 (hard rule)
- 단독 작성 금지 — 반드시 가이드 에이전트 + 빈이 에이전트 토론
- 최소 2라운드, 최대 4라운드
- 체크리스트 10개 전부 통과해야 승인
- 참조: post-debate-system.md, post-writing-guide.md, content.md

### 다음 세션 우선순위

#### 1. 토론 시스템으로 포스트 작성 실전 테스트
- 기획 5개 중 선택하여 가이드+빈이 토론 → 게시
- `post-debate-system.md` 절차 따르기

#### 2. YouTube 59채널 일일 수집 자동화
- 병렬 3분할, 2일 기준
- 기존 `collect-youtube-comments.ts` --from/--to 옵션 활용

#### 3. 속닥 크롤러 구현
- socdoc.co.kr — 1순위 커뮤니티, HTTP+cheerio
- `src/scraper/socdoc/` + `scripts/collect-socdoc.ts`

#### 4. 뷰티 셀럽 채널 등록
- 이사배, 포니, 조효진 등 5개

#### 5. 워밍업 포스트 (8~20)
- 토론 시스템으로 품질 보장
