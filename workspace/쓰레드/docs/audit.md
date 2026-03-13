# 코드 현황 감사

> 감사 일시: 2026-03-13
> 대상: threads-watch 관련 전체 코드 + plan2.md P0/P1 요구사항 GAP 분석

## 파일 인벤토리

| 파일 | 역할 | 상태 | plan2.md 매핑 |
|------|------|------|---------------|
| `.claude/skills/threads-watch/SKILL.md` | 스킬 정의 (로그인, 채널발굴, 수집, 분류, Sheets 기록, checkpoint, handoff) | 동작 | P0-1(상태머신), P0-1a(MCP/CLI), P0-4(예산), S-0/S-1/S-2 재활용 |
| `scripts/collect-posts.js` | Playwright CDP CLI 수집기 (피드스크롤 + 포스트클릭 + 쓰레드단위 조합) | 동작 | P0-1a(CLI 수집), P0-5(캐노니컬 스키마 출력), P0-6(채널소진) |
| `scripts/upload-sheets.py` | gspread OAuth로 JSON -> 레퍼런스 시트 기록 | 동작 | S-9(Sheets 기록) |
| `package.json` | Node.js 의존성 (playwright ^1.58.2) | 동작 | 인프라 |
| `.env` | 환경변수 (NAVER API keys 등) | 존재 | 인프라 |
| `data/sheets/reference_template.csv` | 레퍼런스 시트 컬럼 정의 | 동작 | Sheets 구조 참조 |
| `data/sheets/posts_management.csv` | 콘텐츠 캘린더 (셀럽/트렌드 포스트 10+개 사전 작성) | 동작 | Phase 2-3(콘텐츠) 선행 |
| `data/sheets/weekly_tracker.csv` | 주간 성과 추적 템플릿 (W1~W12, 빈값) | 동작 | Phase 3(성과분석) 선행 |
| `data/sheets/hook_reference.csv` | 훅 유형 참조 (10개 유형 정의) | 동작 | Phase 2(포지셔닝) 참조 |
| `data/raw_posts/*.json` | 수집된 포스트 JSON (11개 채널, 22개 런 파일) | 동작 | P0 수집 결과물 |
| `data/snapshots/` | 피드 스크롤 스냅샷, 파싱 결과 (디버깅용) | 보관 | - |
| `data/threads-watch-checkpoint.json` | 수집 진행 상태 checkpoint | **없음** (이전 수집 완료 후 삭제됨) | P0-1 |
| `data/seen_posts.json` | 영속 dedup 원장 | **없음** | P0-3 |
| `data/taxonomy.json` | 태그 분류 단일 진실 소스 | **없음** | P0-2 |
| `data/telemetry/` | 런 텔레메트리 로그 | **없음** | P0-5a |
| `data/quarantine/` | 필드 검증 실패 레코드 격리 | **없음** | P0-5 |
| `data/briefs/` | 리서치/니즈 브리핑 | **없음** | P1-1, P1-2 |
| `data/learnings/` | 성과 학습 리포트 | **없음** | Phase 3 |
| `data/eval/` | 30개 평가 세트 | **없음** | P1-3 |

## 재활용 가능 코드

### collect-posts.js (878줄) — 핵심 재활용 대상

| 기능 | 파일:라인 | plan2.md 대응 | 재활용 판정 |
|------|----------|---------------|------------|
| CDP 연결 + 페이지 제어 | :644-656 | P0-1a(CLI 브릿지) | 그대로 재활용 |
| 가우시안 랜덤 딜레이 | :44-52 | P0 안티봇 | 그대로 재활용 |
| 휴먼 스크롤/마우스/idle | :77-114 | P0 안티봇 | 그대로 재활용 |
| 긴 휴식 (longBreak) | :105-114 | P0 안티봇 | 그대로 재활용 |
| 피드 스크롤 + postId 수집 | :466-503 | P0-1a(수집) | 재활용, noNewCount 로직 = P0-6 채널소진 기초 |
| 훅 페이지 데이터 추출 (extractHookPageData) | :136-423 | P0-5(캐노니컬 스키마) | 재활용, 필드 추가 필요 (tags, crawl_meta) |
| 답글 조회수 추출 (extractReplyViewCount) | :429-462 | P0-5 | 그대로 재활용 |
| 쓰레드 유닛 빌더 (buildThreadUnit) | :507-584 | P0-5(캐노니컬 스키마) | 재활용, 출력 스키마를 plan2.md 형식으로 확장 필요 |
| 체크포인트 load/save/clear | :588-606 | P0-1(상태머신) | **대폭 개편 필요** — 현재는 채널별 단순 checkpoint, plan2.md는 글로벌 상태머신 |
| 로그인 상태 확인 (checkLoginStatus) | :610-622 | P0-1b(헬스게이트) | 재활용, 주기 로직 추가 필요 (매 10포스트) |
| 차단 감지 + exit code | :770-776 | P0-7(장애 주입) | 재활용, 3단계 대응 로직 추가 필요 |
| 한글 숫자 파싱 (parseNum) | :139-145 | 유틸리티 | 그대로 재활용 |
| l.threads.com 리다이렉트 디코딩 | :148-157 | 유틸리티 | 그대로 재활용 |
| 제휴링크 추출 (extractAffLinks) | :160-173 | P0-2(태그 분류 입력) | 재활용 |
| 클린 텍스트 추출 (extractCleanText) | :176-215 | P0-5 | 재활용 |
| 미디어 추출 (extractMedia) | :218-228 | P0-5 | 재활용 |
| 버튼 카운트 추출 (extractButtonCount) | :233-247 | P0-5 | 재활용 |

### upload-sheets.py (167줄) — 재활용 대상

| 기능 | 파일:라인 | plan2.md 대응 | 재활용 판정 |
|------|----------|---------------|------------|
| gspread OAuth 연결 | :109-111 | P0-1b(헬스게이트), S-9 | 그대로 재활용 |
| 중복 체크 (hook_post_id 기준) | :133-136 | P0-3(dedup) | 부분 재활용 — seen_posts.json과 통합 필요 |
| append 기록 | :158-160 | S-9 | 그대로 재활용 |
| 미디어 분류 (classify_media) | :47-52 | 유틸리티 | 그대로 재활용 |
| HEADERS 정의 | :26-44 | P0-5(스키마) | 확장 필요 — tags, crawl_meta 등 추가 |

### SKILL.md (647줄) — 스킬 정의

| 기능 | 섹션 | plan2.md 대응 | 재활용 판정 |
|------|------|---------------|------------|
| Chrome 자동 실행 (Step 0) | :177-190 | P0-1b(헬스게이트) | 그대로 재활용 |
| 로그인 흐름 (Step 1) | :196-241 | S-0 | 그대로 재활용 |
| 채널 탐색 (Step 2) | :244-287 | P0-3(듀얼트랙) | 확장 필요 — 소비자 트랙 추가 |
| 수집 흐름 (Step 3-4) | :289-446 | P0-1a(수집) | 그대로 재활용 |
| AI 분류 (Step 5) | :449-488 | P0-2(태그 taxonomy) | **대폭 개편** — 카테고리 -> 6태그 taxonomy로 전환 |
| Sheets 기록 (Step 6) | :493-529 | S-9 | 재활용, 스키마 확장 반영 |
| Checkpoint (Step 7) | :532-598 | P0-1(상태머신) | **대폭 개편** — 글로벌 상태머신 + frontier 추가 |
| 컨텍스트 예산 관리 | :113-126 | P0-4 | 재활용, browser_ops 카운터 추가 |
| 안티봇 전략 | :423-428 | P0 | 그대로 재활용 |
| handoff 자동 이어하기 | :127-163 | P0-1 | 그대로 재활용 |

## 새로 작성 필요

| plan2.md 요구사항 | 설명 | 예상 작업량 |
|-------------------|------|------------|
| **상태머신 엔진** (P0-1) | `[시작]->헬스체크->채널발굴->수집->분류->다음채널?->핸드오프/완료` 상태 전이 로직. 현재는 스킬이 순차적으로 단계를 호출할 뿐, 명시적 상태머신 없음 | L |
| **글로벌 checkpoint** (P0-1) | per-channel frontier (last_post_id + last_timestamp), overlap-resume, 원자적 쓰기. 현재 checkpoint는 채널별 단순 진행 상태 | M |
| **헬스 게이트** (P0-1b) | 시작 시 CDP+MCP+gspread 3종 확인 + 매 10포스트 재검증. 현재는 CDP 연결만 확인 | S |
| **태그 taxonomy 파일** (P0-2) | `data/taxonomy.json` — 6태그 + precedence + rules. 현재는 카테고리(패션/뷰티/...) 분류만 존재 | S |
| **소비자 트랙 채널 발굴** (P0-3) | 듀얼 트랙: 마케터 트랙(기존) + 소비자 트랙(구매신호 포스트 기반). 현재는 제휴마케터 채널만 대상 | M |
| **영속 dedup 원장** (P0-3) | `data/seen_posts.json` — channel_id+post_id 복합키, 크로스 런 중복 방지. 현재는 Sheets의 hook_post_id 중복 체크만 | S |
| **컨텍스트 예산 자가 모니터** (P0-4) | browser_ops 카운터를 checkpoint에 저장, 임계치 초과 시 auto-handoff. 현재는 SKILL.md에 규칙만 있고 CLI에는 미구현 | M |
| **캐노니컬 JSON 스키마** (P0-5) | 필드 유효성 검증 (post_id 정규식, timestamp ISO8601, text 비공 등) + quarantine 폴더. 현재는 검증 없이 저장 | M |
| **셀렉터 매니페스트 + 텔레메트리** (P0-5a) | 셀렉터 3-tier 성공률 기록, `data/telemetry/{date}_run.json`. 현재는 없음 | M |
| **채널 소진 graceful 처리** (P0-6) | 스크롤 3회 연속 새 포스트 0 -> exhausted 태그. collect-posts.js에 noNewCount 로직은 있으나 태그/로그 미흡 | S |
| **장애 주입 테스트** (P0-7) | 7개 시나리오 시뮬레이션. 현재는 테스트 프레임워크 자체가 없음 | L |
| **리서처 에이전트** (P1-1) | opus 기반 키워드/구매신호 추출. 전혀 없음 | L |
| **니즈탐지 에이전트** (P1-2) | opus 기반 문제 카테고리 분류. 전혀 없음 | L |
| **30개 eval 세트** (P1-3) | taxonomy+schema 버전 고정 후 수동 라벨링. 전혀 없음 | M |
| **의존성 게이트** (P1-3a) | taxonomy->schema->eval 순서 강제. 전혀 없음 | S |

## GAP 목록

| # | plan2.md 요구 | 현재 상태 | GAP | 작업량 |
|---|--------------|-----------|-----|--------|
| 1 | **P0-1 상태머신**: `[시작]->헬스체크->채널발굴->수집->분류->다음채널?` 상태 전이 + checkpoint 기록 | SKILL.md에 순차 파이프라인 정의만 있음. 명시적 상태 enum/전이/checkpoint 기록 없음 | 상태머신 엔진 + 글로벌 checkpoint 구현 필요 | L |
| 2 | **P0-1 per-channel frontier**: `last_post_id + last_timestamp` 저장, overlap-resume (20개 오버랩) | collect-posts.js에 채널별 `checkpoint_{channelId}.json` 있으나, frontier/overlap 없음. 수집 완료 시 삭제됨 | frontier 필드 추가 + overlap-resume 로직 구현 | M |
| 3 | **P0-1 원자적 쓰기**: tmp 파일 -> rename | collect-posts.js의 `saveCheckpoint()`는 직접 writeFileSync. tmp->rename 패턴 아님 | writeFileSync를 tmp+rename으로 교체 | S |
| 4 | **P0-1a MCP<->CLI 브릿지**: checkpoint의 state 필드로 MCP/CLI 전환 관리 | SKILL.md에 역할분담 정의는 있으나, state 필드 기반 자동 전환 로직 없음 | state 필드 기반 전환 로직 구현 | M |
| 5 | **P0-1b 헬스 게이트 (시작)**: CDP+MCP+gspread 3종 확인, 하나라도 실패 시 중단 | SKILL.md Step 0에서 CDP만 확인. MCP/gspread는 각 단계에서 개별 확인 | 통합 헬스 게이트 (3종 동시 확인) 구현 | S |
| 6 | **P0-1b 헬스 게이트 (중간)**: 매 10포스트 로그인+CDP 재검증 | collect-posts.js에 longBreak 후 checkLoginStatus 있으나, "매 10포스트"는 아님 (12-20포스트 간격) | 10포스트 주기 재검증으로 변경 | S |
| 7 | **P0-2 태그 taxonomy**: 6태그(affiliate/purchase_signal/review/complaint/interest/general) + precedence + primary/secondary | SKILL.md Step 5는 카테고리(패션/뷰티/전자기기/...) 분류. plan2.md의 6태그 체계와 완전히 다름 | `data/taxonomy.json` 생성 + 분류 로직 전면 교체 | M |
| 8 | **P0-3 듀얼 트랙 채널 발굴**: 마케터 트랙 + 소비자 트랙 | SKILL.md Step 2는 제휴마케팅 채널만 대상 (팔로워>=200, 광고>=3건) | 소비자 트랙 (구매신호 포스트>=2건) 추가 | M |
| 9 | **P0-3 영속 dedup 원장**: `data/seen_posts.json` (channel_id+post_id 복합키) | upload-sheets.py에 Sheets 기반 hook_post_id 중복 체크만 있음. 파일 기반 dedup 없음 | `seen_posts.json` 파일 생성 + collect-posts.js 연동 | S |
| 10 | **P0-4 컨텍스트 예산 모니터**: browser_ops<=150, channels_completed<=3, 컨텍스트<=70% | SKILL.md에 규칙 정의는 있으나, collect-posts.js에 browser_ops 카운터 없음 | checkpoint에 budget 카운터 추가 + 자동 핸드오프 | M |
| 11 | **P0-5 캐노니컬 스키마 + 필드 검증**: post_id 정규식, timestamp ISO8601, text 비공, view_count>=0 or null, channel_id 비공 | collect-posts.js는 검증 없이 저장. view_count=-1도 그대로 출력 | JSON Schema 정의 + 수집 시 검증 + quarantine 폴더 | M |
| 12 | **P0-5 validity rate**: 유효 레코드/전체 >= 90%, 미달 시 수집 중단 | 없음 | validity rate 체크 로직 추가 | S |
| 13 | **P0-5a 셀렉터 매니페스트**: 3-tier 전략 성공률 기록, fallback_rate>20% 시 경고 | collect-posts.js에 셀렉터 사용은 있으나 (region, blockMap, pressable fallback), tier별 통계 없음 | 셀렉터 tier별 카운터 + 텔레메트리 출력 | M |
| 14 | **P0-5a 런 텔레메트리**: `data/telemetry/{date}_run.json` | 없음 | 런 텔레메트리 로깅 시스템 구현 | M |
| 15 | **P0-6 채널 소진 처리**: exhausted/skipped 태그, 연속 5개 중복 윈도우 | collect-posts.js에 noNewCount>=3 시 스크롤 중단은 있으나, 태그/로그/중복 윈도우 판정 없음 | exhausted 태그 + 중복 윈도우 감지 추가 | S |
| 16 | **P0-7 장애 주입 테스트**: 7개 시나리오 | 테스트 프레임워크 자체 없음 | 테스트 시나리오 구현 (모의 환경 필요) | L |
| 17 | **P1-1 리서처 에이전트**: opus, 키워드/질문/구매신호 추출, citation>=80% | 전혀 없음 | 프롬프트 + 입출력 파이프라인 구현 | L |
| 18 | **P1-2 니즈탐지 에이전트**: opus, 문제 카테고리 분류, gspread 멱등 upsert | 전혀 없음 | 프롬프트 + 입출력 파이프라인 구현 | L |
| 19 | **P1-3 30개 eval 세트**: 수동 라벨링, signal precision>=0.8, needs accuracy>=0.7 | 전혀 없음 | P0 수집물에서 30개 선별 + 라벨링 | M |
| 20 | **P1-3a 의존성 게이트**: taxonomy+schema 버전 고정 -> eval 생성 순서 강제 | 전혀 없음 | 버전 메타데이터 + 순서 검증 로직 | S |
| 21 | **plan2.md 출력 스키마**: `data/raw_posts/{date}/{channel}/{post_id}.json` 구조 | 현재는 `data/raw_posts/{channel_id}_{run_id}.json` (채널별 단일 파일). 날짜/채널/포스트ID 디렉토리 구조 아님 | 출력 디렉토리 구조 변경 OR 기존 구조 유지하고 스키마만 맞추기 | M |
| 22 | **plan2.md raw post 필드**: tags(배열), crawl_meta(crawl_at, selector_tier, login_status), comments(배열), permalink | 현재 thread_unit 구조: hook_*/reply_* 평탄화. tags/crawl_meta/comments/permalink 없음 | 출력 필드 확장 | M |

## checkpoint.json 현재 vs 목표 스키마 비교

### 현재 스키마 (collect-posts.js 내부, 채널별)

```json
{
  "runId": "run_20260312_2142",
  "channelId": "teri.hous",
  "completedHooks": ["postId1", "postId2"],
  "postIds": ["postId1", "postId2", "postId3"],
  "threadUnits": [{ /* thread_unit 객체 */ }]
}
```

- 경로: `data/raw_posts/checkpoint_{channelId}.json`
- 수집 완료 시 삭제됨
- 채널별 독립 파일
- 상태(state) 필드 없음
- frontier 없음
- budget 카운터 없음

### 현재 스키마 (SKILL.md 정의, 글로벌)

```json
{
  "run_id": "run_20260315_0900",
  "target_channels": 20,
  "target_posts_per_channel": 40,
  "channels_completed": [{"channel_id": "...", "threads_collected": 5, "session": 1}],
  "channels_queue": ["channel4", "channel5"],
  "channels_discovered": ["channel6", "channel7"],
  "current_channel": null,
  "current_channel_posts": [],
  "total_threads_collected": 8,
  "total_sheets_rows": 8,
  "session_count": 1,
  "browser_ops_this_session": 0,
  "blocked_channels": [],
  "timestamp": "2026-03-15T09:45:00",
  "status": "paused_context_limit"
}
```

- 경로: `data/threads-watch-checkpoint.json`
- SKILL.md에만 정의됨, 실제 코드에서는 사용하지 않음
- collect-posts.js의 채널별 checkpoint와 별개

### plan2.md 목표 스키마 (P0-1)

```json
{
  "version": "1.0",
  "run_id": "run_20260313_0900",
  "state": "collect",
  "states_enum": ["health_check", "discover", "collect", "classify", "next_channel", "handoff", "completed"],
  "channels": {
    "completed": [
      {
        "channel_id": "teri.hous",
        "threads_collected": 23,
        "frontier": {
          "last_post_id": "DVkTKlekurD",
          "last_timestamp": "2026-03-07T02:54:06.000Z"
        },
        "status": "completed",
        "session": 1
      }
    ],
    "queue": ["channel4", "channel5"],
    "discovered": ["channel6"],
    "current": null,
    "blocked": [],
    "exhausted": []
  },
  "budget": {
    "browser_ops": 142,
    "browser_ops_limit": 150,
    "channels_completed": 3,
    "channels_limit": 3,
    "model_calls": {"haiku": 0, "sonnet": 95, "opus": 0}
  },
  "dedup": {
    "seen_posts_file": "data/seen_posts.json",
    "total_seen": 245
  },
  "overlap_resume": {
    "enabled": true,
    "overlap_count": 20,
    "current_channel_tail": []
  },
  "telemetry": {
    "stages_completed": ["health_check", "discover"],
    "errors": [],
    "selector_stats": {"tier1_rate": 0.0, "tier2_rate": 0.0, "tier3_rate": 0.0},
    "validity_rate": 0.0
  },
  "session_count": 1,
  "timestamp": "2026-03-13T09:45:00Z",
  "status": "collect"
}
```

### GAP 요약

| 항목 | 현재 | 목표 | GAP |
|------|------|------|-----|
| state enum | 없음 | 7개 상태 | 상태머신 추가 |
| per-channel frontier | 없음 | last_post_id + last_timestamp | frontier 추가 |
| overlap-resume | 없음 | 마지막 20개 오버랩 | 오버랩 로직 추가 |
| budget 카운터 | SKILL.md 규칙만 | checkpoint에 저장 | 카운터 구현 |
| dedup 통합 | Sheets 기반만 | seen_posts.json + checkpoint 연동 | 파일 기반 dedup |
| 텔레메트리 | 없음 | stages/errors/selector/validity | 텔레메트리 로깅 |
| 원자적 쓰기 | writeFileSync | tmp -> rename | 쓰기 패턴 변경 |
| 글로벌 vs 채널별 | CLI=채널별, SKILL=글로벌(미구현) | 단일 글로벌 checkpoint | 통합 필요 |
