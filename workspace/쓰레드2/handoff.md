# BiniLab Handoff — 세션 22 (2026-03-26)

## 현재 상태: P0~P2 전체 구현 완료 → Phase 2 (DB 중심 에이전트 시스템) 진입 대기

### 이번 세션(22) 완료 작업

#### 1. P0 — 보안 + 수익 차단 해제 ✅
- [x] **Shell injection 수정** — `agent-spawner.ts` 3개 함수 (buildMessageScript/buildContextReaderScript/buildPhaseContextQuery)
  - heredoc 직접 보간 → `JSON.stringify()` + `process.argv` 패턴으로 전환
  - `PROJECT_ROOT` 절대경로 → `process.cwd()` 동적화
- [x] **계정명 상수 추출** — `duribeon231` 50+ 곳 → `src/constants/accounts.ts` 생성
  - `PRIMARY_ACCOUNT_ID = 'binilab__'`, `WARMUP_TARGET = 20` 확정
  - 소스 코드 전체 치환 + 테스트 파일 + 문서(.md) 반영
- [x] **WARMUP_TARGET 정리** — 20 확정 (코드=20 유지, 제안서 100은 JSDoc 오류)

#### 2. P1 — 안정성 ✅
- [x] **파이프라인 중복 실행 방어** — `strategy_archive.version` uniqueIndex + upsert + 당일 `directive-{today}` 체크로 early return
- [x] **시뮬레이션 [시뮬] 배지** — `simulateAgentReply()`의 `message_type: 'simulation'` + UI 배지 표시
- [x] **enforceTagGate 개선** — `retryFn(attempt, reason)` 시그니처 + `attempt * 500ms` 백오프 + `{ output, quarantined }` 반환

#### 3. P2 — 코드 품질 ✅
- [x] **EDITOR_MAP 중복 제거** — `daily-pipeline.ts` 로컬 정의 제거 → `agent-spawner.ts`의 EDITOR_MAP + AGENT_REGISTRY import
- [x] **PROJECT_ROOT 동적화** — P0에서 완료
- [x] **하단 바 KPI 교체** — BottomBar 개발자 메트릭 → 포스트/워밍업/승인 대기 3개 비즈니스 KPI (placeholder)

#### 4. 기존 에러 수정 ✅
- [x] `collect.ts:1383` TS2322 — bare `return;` → `CollectionResult` 반환
- [x] 22개 테스트 실패 — 3개 테스트 파일 DDL에 `reply_to`/`mentions` 컬럼 추가

---

### 다음 세션 할 일: Phase 2 (DB 중심 에이전트 시스템)

#### Phase 2-A: 신규 테이블 3개
- [ ] `agent_tasks` — 구조화된 업무 할당 (SELECT FOR UPDATE 포함)
- [ ] `agent_prompt_versions` — 프롬프트 버전 관리 (AutoResearch 패턴)
- [ ] `system_state` — 시스템 상태 key-value 저장

#### Phase 2-B: md 기억 → DB 마이그레이션
- [ ] `agents/memory/strategy-log.md` → `agent_memories` scope='global'
- [ ] `agents/memory/experiment-log.md` → `agent_episodes` type='experiment'
- [ ] `agents/memory/category-playbook-*.md` → `agent_memories` scope='department'

#### Phase 2-C: agent_messages 확장
- [ ] `payload` (jsonb) + `message_type` 확장 ('task_assign' | 'task_result' | 'qa_request' | 'approval_request')
- [ ] 구조화된 JSON payload 규칙 적용

---

### 남은 버그

| # | 심각도 | 요약 | 파일:라인 | 상태 |
|---|--------|------|-----------|------|
| 1 | HIGH | "시간" 단위 파싱 누락 → 최근 포스트 수집 실패 | `collect.ts:1485` | 미수정 |
| 4 | MEDIUM | 트렌드 키워드 카운트 전체 덮어씀 | `run-trend-pipeline.ts:168` | 미수정 |

---

### 커밋 이력 (세션 22)

| 커밋 | 설명 |
|------|------|
| `9989b64e` | P0 security + account constant, P1 stability improvements |
| `9f6a4fef` | P2 code quality — deduplicate EDITOR_MAP, replace dev metrics with KPIs |

### 빌드/테스트 상태
- `npx tsc --noEmit` — 에러 0건
- `npm test` — 382 passed, 0 failed

### 인프라 상태
- Agent Town 대시보드: `쓰레드2/agent-town/` (Phaser + Next.js, 동작 중)
- 테스트: 23개 파일 (382 passed)
- DB: 33 Drizzle 테이블 (agent_tasks/prompt_versions/system_state 미구현 → Phase 2에서 구현)
- 브랜치: `feat/threads-watch-p0` → `fork` remote에 push 완료
