# Threads2 Handoff — 2026-03-23 (세션 14)

## 현재 상태: PLAN v4 전체 완료 + /daily-run v2 에이전트 스폰 기반 업그레이드

### 이번 세션(14) 핵심 작업

| 작업 | 상태 |
|------|------|
| PLAN v4 Phase 1 Foundation (S-1~S-4) | ✅ 9 에이전트 + soul/ops + agent_messages + 리서치 |
| PLAN v4 Phase 2 Round 1 (S-6~S-9) | ✅ 워밍업게이트 + 네이버 + 브랜드확장 + 경쟁사모니터링 |
| PLAN v4 Phase 2 Round 2 (S-5, S-10~S-12) | ✅ /daily-run + 실험 + 리사이클 + 학습 |
| PLAN v4 Phase 3 Round 1 (S-13~S-15) | ✅ Safety Gates + 오케스트레이터 + 주간회의 |
| PLAN v4 Phase 3 Round 2 (S-16~S-17) | ✅ 수익추적 + 자율실험 |
| **/daily-run v2 에이전트 스폰 기반** | ✅ agent-spawner.ts + SKILL.md 재작성 |
| /기획 통합 스캔 수정 | ✅ 5개 별도 → 1개 _signal-scan.ts |
| track-performance.ts 버그수정 | ✅ content_lifecycle 본문 동기화 + 스냅샷 ID |
| 성과 분석 | ✅ 16개 포스트 성과 수집 + 분석 |
| 포스트 게시 2개 | ✅ 클렌징 오일 + 여드름패치 |
| 스킬 등록 | ✅ /daily-run, /수집, /weekly-retro, /기획 |

### /daily-run v2 — 에이전트 스폰 방식 (핵심 업그레이드)

이전: 스킬이 "지시서" → Claude가 직접 모든 작업 수행
이후: 각 Phase에서 Agent 도구로 해당 에이전트를 스폰 → 역할별 독립 실행

```
Phase 1: 준호(리서처) 스폰 → 수집 → agent_messages 보고
Phase 2: 서연(분석가) 스폰 → 분석 → CEO에게 보고
Phase 3: 민준(CEO) 스폰 → directive 생성 → 전체 배포
Phase 4: 에디터 스폰 → 초안 → 도윤(QA) 검증 → 통과/반려 루프
Phase 5: Safety Gates 자동 → aff_contents 'ready'
```

파일: `src/orchestrator/agent-spawner.ts` (AGENT_REGISTRY 9개 + EDITOR_MAP + buildAgentPrompt)
스킬: `~/.claude/skills/daily-run/SKILL.md` (v2 에이전트 스폰 기반)

### 발견된 문제 + 해결

1. **수집→분석 전환 시 완료 대기 누락** → Phase 1 완료 게이트 추가
2. **/기획에서 24h 데이터 안 읽음** → _signal-scan.ts 통합 스크립트로 교체
3. **에이전트가 실제 스폰 안 됨** → /daily-run v2로 재작성 (에이전트 스폰 기반)
4. **content_lifecycle 본문 비어있음** → track-performance.ts에서 동시 업데이트

### 다음 세션 우선순위

1. **`/daily-run --posts 3` 실제 실행** — 에이전트 스폰 파이프라인 E2E 검증
2. **CEO Shadow Mode (S-2b)** — 5일 directive 채점
3. **워밍업 포스트 계속** — 16/100 → 하루 3~5개
4. **agent_messages 실제 사용 검증** — 에이전트 간 소통 로그 확인

### Phase 3 Round 2 검증 결과 (세션 16)

| 항목 | 결과 | 비고 |
|------|------|------|
| tsc --noEmit | ✅ 0 errors | |
| npm test | ✅ 162/162 PASS (13 files) | revenue + experiments 포함 |
| src/db/revenue.ts | ✅ EXISTS | CRUD 헬퍼 |
| src/__tests__/revenue.test.ts | ✅ EXISTS | 6/6 PASS (TDD) |
| src/orchestrator/auto-experiment.ts | ✅ EXISTS | autonomy levels 0-3 |
| src/db/schema.ts experiments.autonomy_level | ✅ EXISTS | integer default 0 |
| ops/revenue-ops.md | ✅ EXISTS | 수익 추적 운영 가이드 |
| ops/experiment-ops.md | ✅ EXISTS | 자율 실험 권한 체계 포함 |
| .claude/agents/minjun-ceo.md | ✅ 자율 실험 section 존재 | |

### PLAN-AI-COMPANY v4 전체 완료 (S-1 ~ S-17)

| Phase | S# | 작업 | 상태 |
|-------|----|------|------|
| Phase 1 | S-1 | Foundation — 9 에이전트, soul/ops 분리, agent_messages DB | ✅ |
| Phase 1 | S-2 | CEO Shadow Mode + daily-standup-ops.md | ✅ |
| Phase 1 | S-3 | performance-ops.md 7단계 분석 가이드 | ✅ |
| Phase 2 | S-4 | aff_contents.status + 워밍업 게이트 TDD | ✅ |
| Phase 2 | S-5 | /daily-run 스킬 — 6 Phase 일일 파이프라인 | ✅ |
| Phase 2 | S-6 | 네이버 검색량/트렌드 → /수집 + /기획 통합 | ✅ |
| Phase 2 | S-7 | 브랜드 리서치 확장 (40→80개/카테고리) | ✅ |
| Phase 2 | S-8 | 경쟁사 모니터링 (evaluate-channels.ts) | ✅ |
| Phase 2 | S-9 | autoresearch 실험 시스템 (experiments DB + TDD) | ✅ |
| Phase 2 | S-10 | 포스트 리사이클 시스템 (recycle.ts + TDD) | ✅ |
| Phase 2 | S-11 | 학습 시스템 (diversity-checker + strategy-logger + TDD) | ✅ |
| Phase 2 | S-12 | /수집 스킬 v2 (7개 수집 도구 통합) | ✅ |
| Phase 3 | S-13 | 8개 Safety Gates TDD (38/38 PASS) | ✅ |
| Phase 3 | S-14 | daily-pipeline.ts 오케스트레이터 + --autonomous 모드 | ✅ |
| Phase 3 | S-15 | run-weekly-retro.ts + /weekly-retro 스킬 | ✅ |
| Phase 3 | S-16 | revenue_tracking 테이블 + TDD helpers (6/6 PASS) | ✅ |
| Phase 3 | S-17 | auto-experiment.ts + autonomy levels (0-3) + CEO update | ✅ |

### /daily-run v2 업그레이드 (2026-03-23)

- `/daily-run v2` — 에이전트 스폰 기반으로 업그레이드. 각 Phase에서 Agent 도구로 에이전트 스폰. `agent_messages` 기록 필수.
- `src/orchestrator/agent-spawner.ts` — AGENT_REGISTRY (9개), EDITOR_MAP, `buildAgentPrompt()`, `buildMessageScript()`, `buildContextReaderScript()`
- SKILL.md: Phase 1(준호) → 완료게이트 → Phase 2(서연) → Phase 3(민준) → Phase 4(에디터+도윤QA) → Phase 5(Safety)

---

### 다음 우선순위 — 운영 단계

1. **워밍업 포스트 완료** — 7/20개 완료, 13개 남음 (하루 2~3개)
2. **/daily-run --autonomous 실전 가동** — dry-run 검증 후 실제 포스트 생산
3. **수익 추적 실전 연동** — 쿠팡 파트너스 클릭/전환 데이터 수집 시작
4. **자율 실험 첫 가동** — autonomy_level 1 (저위험 실험 자동 승인)

---

### Phase 3 Round 1 완료 작업 (S-13 ~ S-15)

| S# | 작업 | 상태 | 비고 |
|----|------|------|------|
| S-13 | 8개 Safety Gates TDD (38/38 PASS) | ✅ | src/safety/gates.ts |
| S-14 | daily-pipeline.ts 오케스트레이터 + --autonomous 모드 + EDITOR_MAP | ✅ | src/orchestrator/ |
| S-15 | run-weekly-retro.ts 자동화 + /weekly-retro 스킬 | ✅ | scripts/ + ~/.claude/skills/ |

---

### Phase 2 전체 완료 작업 (S-5 ~ S-12)

| S# | 작업 | 상태 | 라운드 |
|----|------|------|--------|
| S-5 | `/daily-run` 스킬 — 6 Phase 일일 파이프라인 | ✅ | Round 2 |
| S-6 | aff_contents.status 컬럼 + 워밍업 게이트 TDD | ✅ | Round 1 |
| S-7 | 네이버 검색량/트렌드 → /수집 + /기획 통합 | ✅ | Round 1 |
| S-8 | 브랜드 리서치 확장 (40→80개/카테고리) | ✅ | Round 1 |
| S-9 | 경쟁사 모니터링 시스템 (evaluate-channels.ts) | ✅ | Round 1 |
| S-10 | autoresearch 실험 시스템 (experiments DB + TDD) | ✅ | Round 2 |
| S-11 | 포스트 리사이클 시스템 (recycle.ts + TDD) | ✅ | Round 2 |
| S-12 | 학습 시스템 (diversity-checker + strategy-logger + TDD) | ✅ | Round 2 |

### 다음 우선순위 — Phase 3: Full Automation

1. **CEO Shadow Mode** (S-2b) — minjun-ceo 5일 Shadow, 추천만 / 시훈 채점 ≥80%
2. **워밍업 포스트 완료** — 15개 완료, 85개 남음 (하루 3~5개 목표)
3. **`/daily-run` 실전 실행** — `--dry-run --posts 3`으로 첫 검증 후 전체 파이프라인 가동
4. **실험 시스템 가동** — 첫 A/B 실험 설계 및 experiments 테이블에 등록

---

### 이번 세션(13) 완료 작업

| # | 작업 | 상태 |
|---|------|------|
| 1 | agency.md 작성 (BiniLab 미션/조직도/권한 매트릭스/코드 수정 프로토콜) | ✅ |
| 2 | 9개 에이전트 정의 파일 생성 (.claude/agents/ YAML frontmatter) | ✅ |
| 3 | soul/ops 파일 분리 (content.md→souls/+ops/, debate→ops/, writing→ops/) | ✅ |
| 4 | agents/memory/ 학습 시스템 디렉토리 구조 생성 | ✅ |
| 5 | CEO soul 상세화 (ROI 공식, 시간대, 다양성 체크, 경쟁사 판단) | ✅ |
| 6 | daily-standup-ops.md (Phase 1~6 파이프라인 + DB 쿼리 템플릿) | ✅ |
| 7 | weekly-retro-ops.md (주간 전략회의 가이드) | ✅ |
| 8 | agent_messages DB 테이블 + 3개 인덱스 (Supabase) | ✅ |
| 9 | agent-messages.ts 헬퍼 (sendMessage/getMessages/markAsRead/getUnreadMessages) | ✅ |
| 10 | agent-messages.test.ts TDD (6/6 PASS) | ✅ |
| 11 | 멀티에이전트 소통 리서치 (CrewAI/AutoGen/MetaGPT/ChatDev 분석) | ✅ |
| 12 | 전체 검증 통과 (tsc 0에러, 90테스트 PASS, 참조 정상, PLAN 일치) | ✅ |
| 13 | telegram.ts fetch 기반 리팩토링 (테스트 호환성) | ✅ |

### 생성된 파일 (세션 13)

| 경로 | 설명 |
|------|------|
| `.claude/agents/agency.md` | BiniLab 미션/조직도/권한 |
| `.claude/agents/minjun-ceo.md` | CEO (opus, 판단 기준 상세) |
| `.claude/agents/bini-beauty-editor.md` | 뷰티 에디터 (sonnet) |
| `.claude/agents/hana-health-editor.md` | 건강 에디터 (sonnet) |
| `.claude/agents/sora-lifestyle-editor.md` | 생활 에디터 (sonnet) |
| `.claude/agents/jiu-diet-editor.md` | 다이어트 에디터 (sonnet) |
| `.claude/agents/doyun-qa.md` | QA (opus) |
| `.claude/agents/seoyeon-analyst.md` | 분석가 (opus) |
| `.claude/agents/junho-researcher.md` | 리서처 (sonnet) |
| `.claude/agents/taeho-engineer.md` | 엔지니어 (opus) |
| `souls/bini-persona.md` | 빈이 페르소나 |
| `ops/content-creation-ops.md` | 6단계 CoT 운영 가이드 |
| `ops/debate-ops.md` | 토론 시스템 운영 가이드 |
| `ops/writing-guide-ops.md` | 글쓰기 지침 운영 가이드 |
| `ops/daily-standup-ops.md` | 일일 스탠드업 (DB 쿼리 템플릿 포함) |
| `ops/weekly-retro-ops.md` | 주간 전략회의 가이드 |
| `src/db/agent-messages.ts` | 에이전트 메시지 CRUD 헬퍼 |
| `src/__tests__/agent-messages.test.ts` | 메시지 헬퍼 테스트 (6개) |
| `agents/memory/` | 학습 시스템 (strategy-log, experiment-log 등) |
| `data/research/multi-agent-communication.md` | 멀티에이전트 리서치 보고서 |

### 리서치 핵심 발견

- **외부 프레임워크 도입 불필요** — Python SDK 기반이라 Claude Code에서 직접 실행 불가
- **BiniLab은 이미 올바른 방향** — 4개 프레임워크의 핵심 패턴이 이미 부분 구현됨
- **추천**: MetaGPT Pub/Sub + AutoGen 타입드 이벤트를 agent_messages DB로 하이브리드 구현

### 다음 세션 우선순위 — PLAN v4 Phase 2 Semi-Autonomous

#### 1. CEO Shadow Mode (S-2b)
- minjun-ceo.md 기반 5일 Shadow Mode
- 매일 daily_directive 추천만, 실행 안 함
- 시훈 채점 → 정확도 ≥ 80%

#### 2. `/daily-run` 스킬 구현 (S-5)
- 10개 포스트 자동 생산 파이프라인
- Phase 1~6 자동 오케스트레이션
- 시간대별 분산 게시 (최소 1시간 간격)

#### 3. 네이버 검색량/트렌드 통합 (S-7)
- /수집 + /기획에 네이버 데이터 연동
- 키워드 확장 검색 (L1→L2→L3)

#### 4. 브랜드 리서치 확장 (S-8)
- 40→80개/카테고리 (6에이전트 병렬)

#### 5. 경쟁사 모니터링 (S-9)
- 하위 20% 주간 교체 + 신규 채널 발굴

#### 6. 추가 구현 (S-6, S-10~S-12)
- aff_contents.status 컬럼 + 워밍업 게이트
- autoresearch 실험 시스템
- 포스트 리사이클 시스템
- 학습 시스템 (memory/ + 다양성 체크)

### 이전 세션(12) 완료 작업

| # | 작업 | 상태 |
|---|------|------|
| 1 | brand_events stale 갱신 — 78건 is_stale=true (이미 마킹됨 확인) | ✅ |
| 2 | youtube_videos video_id 수정 — 36건 source_url에서 추출, NULL 0개 | ✅ |
| 3 | 뷰티 YouTube 채널 메타 보강 — 29/29개 구독자수/설명 전부 채움 | ✅ |
| 4 | thread_posts 718개 카테고리 분류 — NULL 0개 (단, 전부 '기타' → TAG_MAP 확장 필요) | ✅ |
| 5 | channels rejected 20개 삭제 — thread_posts 참조 없어 전부 삭제, verified 29개 유지 | ✅ |
| 6 | `/수집` 스킬 생성 — ~/.claude/skills/수집.md (7개 수집 도구 통합) | ✅ |
| 7 | TAG_MAP 확장 — classifyByText() 추가, 72개 본문 매칭 재분류 (기타 804→732) | ✅ |
| 8 | `/기획` E2E 테스트 — 수집→기획→토론→게시 완료 | ✅ |
| 9 | 여드름패치 포스트 게시 — https://www.threads.com/@duribeon231/post/DWNkJLTkZnZ | ✅ |
| 10 | `/수집` 스킬 v2 — YouTube(playlistItems 1unit) + 트렌드 + 벤치마크(--since) + 병렬 | ✅ |
| 11 | YouTube API search→playlistItems 전환 (쿼터 99% 절약) | ✅ |
| 12 | YouTube 채널 ID 변환 (29개 handle→UC, 27/29 성공) | ✅ |
| 13 | YouTube collector 에러 핸들링 (per-channel try-catch) | ✅ |
| 14 | collect.ts --since N 시간 기반 수집 중단 | ✅ |
| 15 | 벤치마크 29채널 전체 수집 — 신규 94개 + 지표 업데이트 156개 | ✅ |
| 16 | PLAN-AI-COMPANY v4 확정 — 9에이전트, 권한 분리, 코드 수정 프로토콜 | ✅ |
| 17 | Claude-Code-Game-Studios 분석 — 6개 적용 패턴 도출 | ✅ |

### DB 현황 (세션 12 정리 후)

| 테이블 | 건수 | 변경사항 |
|--------|------|----------|
| thread_posts | 1,217 | topic_category NULL 0개 (기타 804개 — TAG_MAP 확장 필요) |
| channels | **29** | rejected 20개 삭제, verified 29개만 남음 |
| youtube_channels | 49 | 뷰티 29개 메타 보강 완료 (subscriber_count NULL 0개) |
| youtube_videos | 36 | video_id NULL 0개 (36건 수정) |
| brand_events | 85 | is_stale=true 78건, 활성 7건 |
| community_posts | 27 | 변경 없음 |
| brands | 40 | 변경 없음 |
| needs | 73 | 변경 없음 |
| aff_contents | 12 | 변경 없음 |
| trend_keywords | 297 | 변경 없음 |
| content_lifecycle | 10 | 변경 없음 |
| post_snapshots | 25 | 변경 없음 |
| daily_performance_reports | 1 | 변경 없음 |

### 해소된 DB 이슈 (세션 11 → 12)

| 이슈 | 세션 11 | 세션 12 | 상태 |
|------|---------|---------|------|
| thread_posts 59% 미분류 | 718개 NULL | **0개 NULL** | ✅ 해소 (기타 804개, TAG_MAP 확장 필요) |
| brand_events stale 미갱신 | is_stale=false | **78건 stale** | ✅ 해소 |
| 뷰티 YouTube 메타 누락 | 29개 전부 null | **0개 null** | ✅ 해소 |
| youtube_videos video_id null | 36개 전부 null | **0개 null** | ✅ 해소 |
| channels 비활성 20개 | rejected 20개 | **삭제 완료** | ✅ 해소 |

### 남은 DB 이슈

1. **thread_posts 52% 미분석** — 632개 analyzed_at=null (분석 파이프라인 미실행)
2. **primary_tag 미세분화** — general/null만 존재
3. **brand_events 전부 미사용** — is_used=true가 0개
4. **트렌드 키워드 수집 미가동** — selected=true 7개, posts_collected 전부 0
5. **성과 리포트 1회만 실행** — 3/19 단 1건
6. **스키마-DB 불일치** — brands.name vs brand_name, aff_contents에 status 없음
7. **topic_category '기타' 66%** — TAG_MAP 확장으로 재분류 필요

### 신규 스킬

| 스킬 | 위치 | 설명 |
|------|------|------|
| `/수집` | `~/.claude/skills/수집.md` | 7개 수집 도구 통합 (벤치마크/키워드/커뮤니티/유튜브/성과/브랜드/전체) |

### 수집 시스템 현황

```
[Threads]        src/scraper/collect.ts              (Playwright CDP)     ✅ 기존
[키워드검색]     scripts/collect-by-keyword.ts        (Playwright CDP)     ✅ 기존
[네이버카페]     scripts/collect-naver-cafe.ts        (Playwright CDP)     ✅ 기존
[더쿠]           scripts/collect-theqoo.ts            (HTTP + cheerio)     ✅ 기존
[인스티즈]       scripts/collect-instiz.ts            (HTTP + cheerio)     ✅ 기존
[YouTube]        scripts/collect-youtube-comments.ts  (YouTube API v3)     ✅ 기존
[채널 발굴]      scripts/discover-youtube-channels.py (yt-dlp+scrapetube)  ✅ 기존
[쿠팡 제품]      scripts/coupang-check.ts             (Playwright CDP)     ✅ 기존
[네이버 검색량]  naver-keyword-search/search.py       (검색광고 API)       ✅ 기존
[네이버 트렌드]  naver-keyword-search/trend.py        (DataLab API)        ✅ 기존
[통합 스킬]      ~/.claude/skills/수집.md             (위 도구 통합)       ✅ 신규
```

### 다음 세션 우선순위 — PLAN-AI-COMPANY v4 Phase 1

#### 1. Phase 1 Foundation 구현 (세션 A)
- `agency.md` 작성 (BiniLab 미션/가치관)
- `.claude/agents/` 에 9개 에이전트 정의 파일 생성 (YAML frontmatter)
- 기존 파일 soul/ops 분리 (content.md, post-debate-system.md 등)
- 토론 시스템이 새 구조에서 동작하는지 검증

#### 2. CEO Shadow Mode (세션 B)
- `souls/minjun-ceo.md` 상세화 + `daily-standup-ops.md`
- CEO Shadow Mode 5일 — 추천만, 시훈 채점, 정확도 ≥80%

#### 3. `/daily-pipeline` 구현 (세션 C)
- 10개 포스트 자동 생산 파이프라인
- 네이버 검색량/트렌드 통합
- 게시 큐 (aff_contents.status)
- 경쟁사 모니터링 (하위 20% 주간 교체)

#### 4. 워밍업 포스트 (8/100)
- 하루 10개 목표, ~10일이면 워밍업 완료
- 카테고리별 에디터가 병렬 작성

### 미해결 사항
- agent_messages DB 테이블 (에이전트 소통 시스템)
- 멀티에이전트 소통 시스템 리서치 (CrewAI, AutoGen, MetaGPT 조사 필요)
- 브랜드 리서치 40→80개/카테고리 확장
- 포스트 리사이클 시스템
- 수익 추적 (워밍업 100 완료 후)
