# BiniLab AI Company v2 — /team 구현 프롬프트

이 파일의 내용을 복사해서 `/team` 명령어로 실행하세요.

---

## 실행 방법

```bash
# 아래 프롬프트를 /team에 전달
/team 5:executor "BiniLab AI Company v2 구현"
```

---

## 프롬프트 (아래 내용을 그대로 복사)

```
BiniLab AI Company v2 구현 — PLAN-COMPANY-V2-FINAL.md 기반

## 프로젝트 정보
- 작업 디렉토리: /home/sihun92/projects/oh-my-claudecode/workspace/쓰레드2
- 플랜 파일: /home/sihun92/projects/oh-my-claudecode/workspace/쓰레드2/PLAN-COMPANY-V2-FINAL.md
- 기존 코드: src/orchestrator/agent-spawner.ts, daily-pipeline.ts, src/db/schema.ts
- DB: Supabase PostgreSQL (Drizzle ORM)
- 브랜치: dev (기본), worktree에서 feature/company-v2 브랜치로 작업
- TDD: 테스트 먼저 작성 → 실패 확인 → 구현 → 통과 확인

## 워크트리 설정
모든 작업을 git worktree에서 진행한다:
- 워크트리 생성: git worktree add /tmp/binilab-v2 -b feature/company-v2 dev
- 모든 파일 경로는 워크트리 루트 기준으로 작업
- 완료 후: PR 생성 (--base dev)

## 의존성 그래프 (→ 는 "이걸 먼저 해야 함")

Phase A (병렬 — 의존성 없음):
  T1: DB 스키마 + Drizzle 정의
  T2: COMPANY.md 작성
  T3: 에이전트 캐릭터 설정 (.claude/agents/*.md)

Phase B (T1 완료 후):
  T4: 메모리 헬퍼 (src/db/memory.ts) + 테스트
  T5: 파일→DB 마이그레이션 스크립트

Phase C (T2 + T4 완료 후):
  T6: agent-spawner.ts 확장 (async 전환 + 기억 주입)
  T7: agent-output-parser.ts (태그 파싱 모듈) + 테스트

Phase D (T6 + T7 완료 후):
  T8: 회의 오케스트레이터 (meeting.ts) + 테스트
  T9: 전략 아카이브 + 롤백 (strategy-archive.ts) + 테스트
  T10: daily-pipeline Phase 3 전환

Phase E (모두 완료 후):
  T11: E2E 백엔드 검증 + 리뷰

## 태스크 상세

### T1: DB 스키마 + Drizzle 정의 [Phase A, 병렬]
파일: src/db/schema.ts (수정), Supabase migration
작업:
1. schema.ts에 6개 신규 테이블 Drizzle 정의 추가:
   - agents (에이전트 레지스트리)
   - agent_memories (의미 기억)
   - agent_episodes (에피소드, pipeline_run 포함)
   - strategy_archive (전략 버전)
   - meetings (회의 메타데이터)
   - pending_approvals (승인 대기)
2. agent_messages 테이블에 room_id 컬럼 추가 (text 타입, nullable)
3. 인덱스 7개 추가
4. Drizzle migration 생성: npm run db:generate
5. agents 테이블 초기 시딩 스크립트 (11명 에이전트 INSERT)
TDD:
- 테스트: 각 테이블의 CRUD가 Drizzle로 정상 작동하는지 (PGlite 사용)
- 검증: npx tsc --noEmit (타입 체크) + npm test
수용 기준:
- schema.ts에 28개 테이블 정의 (기존 22 + 신규 6)
- agent_messages에 room_id 컬럼 존재
- 기존 22개 테이블은 일체 변경 없음 (room_id만 추가)

### T2: COMPANY.md 작성 [Phase A, 병렬]
파일: COMPANY.md (신규)
작업:
1. 프로젝트 인덱스 (DB 테이블 28개, 파일 맵, 도구 맵, 스킬 맵)
2. 채널 스코프: Threads 제휴마케팅 전용
3. 수익 목표: 월 2000만원, 분기별 마일스톤
4. 기억 시스템 사용법: [SAVE_MEMORY] 태그 형식, 저장 규칙, 30개/3000토큰 캡
5. 에피소드 기록법: [LOG_EPISODE] 태그 형식
6. 전략 아카이브: [CREATE_STRATEGY_VERSION] 태그 (CEO 전용)
7. 회의 규칙: 자유토론, 반박 방법, 합의 기반 종료 (maxTurns 아님!)
8. 비전문가 톤 강제: 성분명/의학용어 금지
9. 성격 가이드: "반드시 아래 성격에 따라 판단하라"
참조: PLAN-COMPANY-V2-FINAL.md의 "프로젝트 인덱스" 섹션
수용 기준:
- COMPANY.md가 에이전트에게 모든 시스템을 안내하는 SSOT

### T3: 에이전트 캐릭터 설정 [Phase A, 병렬]
파일: .claude/agents/*.md (9개 수정 + 1개 신규)
작업:
1. 각 에이전트 .md 파일에 ## 성격 (업무 영향) 섹션 추가
2. 성격 테이블 기준 (PLAN-COMPANY-V2-FINAL.md의 에이전트 캐릭터 참조):
   - 민준 CEO: 결단력+균형감, "숫자 근거 없으면 결정 안 함"
   - 지현 마케팅팀장: 리더십+포용력 (신규: jihyun-marketing-lead.md)
   - 서연 분석팀장: 냉철+팩트중심, is_team_lead: true 추가
   - 준호 트렌드헌터: 호기심+탐험적
   - 빈이 뷰티크리에이터: 밝고 공감력
   - 하나 건강에디터: 신중+책임감
   - 소라 생활큐레이터: 실용+효율
   - 지우 다이어트코치: 동기부여형
   - 도윤 품질검수관: 꼼꼼+보수적
   - 태호 시스템엔지니어: 논리+효율
3. 역할명 변경 (분석가→성과추적관, 리서처→트렌드헌터 등)
4. agency.md 조직도 업데이트 (팀장 구조 반영)
수용 기준:
- 11개 에이전트 파일 모두 성격 섹션 있음
- jihyun-marketing-lead.md 신규 생성
- 역할명이 구체적 업무명으로 변경

### T4: 메모리 헬퍼 + 테스트 [Phase B, T1 완료 후]
파일: src/db/memory.ts (신규), src/__tests__/memory.test.ts (신규)
작업:
1. TDD: 먼저 테스트 작성
   - loadAgentContext(): 7개 하위 쿼리 각각 반환값 검증
   - saveMemory(): INSERT 후 SELECT로 확인
   - logEpisode(): INSERT 후 SELECT로 확인
   - formatMemoryForPrompt(): 출력 문자열 3000토큰 이하 검증
   - 랭킹 공식: recency(0.4)+importance(0.4)+scope(0.2) 정확성
   - 각 하위 쿼리 실패 시 빈 배열 fallback 검증
2. 구현: loadAgentContext(), saveMemory(), logEpisode(), formatMemoryForPrompt()
3. agent-messages.ts 확장: sendMessage에 roomId? 파라미터 추가, getMessagesByRoomId() 신규
4. strategy-logger.ts 래퍼 전환: logDecision/updatePlaybook 내부를 DB 호출로 교체
검증: npm test -- --filter memory
수용 기준:
- 테스트 전부 통과
- loadAgentContext가 async이고 7개 섹션 반환
- formatMemoryForPrompt 출력이 3000토큰 이하

### T5: 파일→DB 마이그레이션 [Phase B, T1 완료 후]
파일: scripts/migrate-memory-to-db.ts (신규)
작업:
1. agents/memory/strategy-log.md 파싱 → agent_episodes (type: 'decision')
2. agents/memory/experiment-log.md 파싱 → experiments 보강
3. agents/memory/category-playbook/*.md 파싱 → agent_memories
4. agents/memory/weekly-insights.md 파싱 → agent_memories
5. 마이그레이션 실행 후 agents/memory/ → agents/memory-archive/ 리네임
검증: 마이그레이션 전후 데이터 카운트 비교
수용 기준:
- 기존 파일 데이터가 전부 DB에 존재
- agents/memory-archive/ 폴더로 이동 완료

### T6: agent-spawner.ts 확장 [Phase C, T2+T4 완료 후]
파일: src/orchestrator/agent-spawner.ts (수정)
작업:
1. buildAgentPrompt를 async로 전환: async function buildAgentPrompt(...): Promise<string>
2. 함수 앞부분에 추가:
   - COMPANY.md readFileSync → 프롬프트 맨 앞
   - await loadAgentContext(agentId, department) → 기억 로드
   - formatMemoryForPrompt(ctx) → 기억 섹션 주입
3. 기존 로직(TOOL_REGISTRY, 에이전트 정의 Read 지시 등) 그대로 보존
4. 호출부(daily-pipeline.ts)에 await 추가
5. AGENT_REGISTRY를 agents DB에서 읽도록 변경 (getAgentRegistry())
   - 하드코딩은 fallback으로 유지
주의:
- 기존 buildAgentPrompt의 lines[] 로직 절대 삭제 금지
- 반환 타입만 string → Promise<string> 변경
- daily-pipeline.ts에서 buildAgentPrompt 호출부 전부 await 추가
TDD:
- 테스트: buildAgentPrompt가 COMPANY.md 내용을 포함하는지
- 테스트: loadAgentContext 결과가 프롬프트에 주입되는지
- 테스트: 기존 TOOL_REGISTRY, 에이전트 정의가 여전히 포함되는지
검증: npx tsc --noEmit + npm test
수용 기준:
- 기존 기능 100% 보존 + 기억/COMPANY.md 주입 추가

### T7: agent-output-parser.ts + 테스트 [Phase C, 병렬]
파일: src/orchestrator/agent-output-parser.ts (신규), src/__tests__/output-parser.test.ts
작업:
1. TDD: 먼저 테스트
   - processAgentOutput(): [SAVE_MEMORY] 태그 정규식 파싱
   - processAgentOutput(): [LOG_EPISODE] 태그 파싱
   - processAgentOutput(): [CREATE_STRATEGY_VERSION] 파싱
   - processAgentOutput(): 태그 없으면 status='missing_tags'
   - processAgentOutput(): 형식 오류 태그 (닫는 태그 없음) 처리
   - enforceTagGate(): 2회 재시도 후 quarantine
2. 구현: processAgentOutput(), enforceTagGate(), parseTag(), parseMeta()
검증: npm test -- --filter output-parser
수용 기준:
- 정규식 파싱이 다양한 형식의 태그를 안정적으로 추출
- quarantine 시 DB 저장 안 하고 출력만 반환

### T8: 회의 오케스트레이터 + 테스트 [Phase D, T6+T7 완료 후]
파일: src/orchestrator/meeting.ts (신규), src/__tests__/meeting.test.ts
작업:
1. MeetingConfig 인터페이스 (PLAN 기준 — maxTurns 없음, tokenBudget 사용)
2. runMeeting() 구현:
   - meetings 테이블에 회의 생성
   - 자유토론 루프 (selectNextSpeaker 규칙 기반)
   - 합의 체크 (매 5턴)
   - Devil's Advocate (매 10턴, 주간 전략회의만)
   - CEO 최종 결정 (합의 3회 미달 시)
   - tokenBudget 안전장치
3. selectNextSpeaker() 구현:
   - @멘션된 에이전트 우선
   - 미발언 에이전트 우선
   - 연속 3회 금지
4. 회의 transcript sliding window (최근 15턴 + 이전 요약)
5. 회의방 권한 체계 (시훈/CEO/팀장/일반)
TDD:
- selectNextSpeaker: 멘션 우선, 미발언 우선, 연속 금지 각각 테스트
- 합의 체크: 합의/미합의 시나리오
- tokenBudget 초과 시 CEO 정리 동작
검증: npm test -- --filter meeting
수용 기준:
- 자유토론이 실제로 작동 (라운드 로빈 아님)
- 합의 기반 종료 (턴 수 제한 아님)

### T9: 전략 아카이브 + 롤백 + 테스트 [Phase D, 병렬]
파일: src/db/strategy-archive.ts (신규), scripts/rollback-strategy.ts (신규)
작업:
1. createStrategyVersion(), getActiveStrategy(), revertStrategy()
2. 롤백 트리거: agent_episodes에서 pipeline_run gate_failures 체크
3. 롤백 절차: 이전 active 승격 → 현재 deprecated → pending_approvals 기록
4. pending_approvals CRUD
5. tone-validator.ts (src/safety/): 성분명/의학용어 패턴 감지
TDD:
- 전략 버전 생성/조회/롤백 사이클
- 롤백 트리거 조건 감지
검증: npm test -- --filter strategy
수용 기준:
- 전략 v1→v2→v3 생성 후 v3 실패 → v2로 롤백 성공

### T10: daily-pipeline Phase 3 전환 [Phase D, T8 완료 후]
파일: src/orchestrator/daily-pipeline.ts (수정)
작업:
1. Phase 3에서 runCEOStandup() 대신 runMeeting({type:'standup'}) 호출
2. meetingToDirective() 구현: 기존 ROI 계산 로직 재사용 + 회의 합의 오버라이드
3. pipeline 끝에 logEpisode(event_type='pipeline_run') 추가
4. Phase Gate 호환: 회의 메시지 channel='standup'으로 저장
주의:
- Phase 1,2,4,5,6 코드 수정 금지
- gatePhase1/2/3 함수 수정 금지
- DailyDirective 타입 변경 금지
TDD:
- meetingToDirective 반환값이 DailyDirective 타입과 일치
- gatePhase3() 통과 확인
검증: npx tsc --noEmit + npm test
수용 기준:
- Phase 3이 회의 기반으로 전환
- Phase 4가 기존과 동일하게 DailyDirective 소비

### T11: E2E 백엔드 검증 [Phase E, 모두 완료 후]
작업:
1. 기억 재현: 에이전트 2회 스폰, 1회차 저장한 기억이 2회차에 주입되는지
2. 회의 1회: 스탠드업 소집 → 자유토론 → 합의 → 결정 저장
3. 전략 롤백: 전략 v1 생성 → v2 변경 → 롤백 → v1 복원
4. daily-pipeline: Phase 1~6 전체 실행 (dryRun 가능)
5. 톤 검증: tone-validator.ts 실행
6. npx tsc --noEmit + npm test (전체)
수용 기준:
- 위 6개 전부 통과

## 검증 명령어
- 타입 체크: npx tsc --noEmit
- 테스트: npm test
- 특정 테스트: npm test -- --filter <name>
- 기존 코드 변경 없음 확인: git diff src/orchestrator/daily-pipeline.ts (Phase 1,2,4,5,6 부분)

## 검증→수정 루프 (에러 0이 될 때까지)

모든 태스크 완료 후 아래 검증을 실행하고, 에러가 있으면 수정 후 재검증을 반복한다.
에러 0이 될 때까지 루프를 멈추지 않는다.

### 루프 절차

```
LOOP:
  1. npx tsc --noEmit          → TypeScript 에러 0개?
  2. npm test                  → 테스트 전부 통과?
  3. npm run db:generate       → Drizzle migration 생성 정상?
  4. 기존 코드 변경 확인:
     - git diff src/orchestrator/daily-pipeline.ts 에서
       Phase 1,2,4,5,6 부분이 변경되지 않았는지
     - git diff src/safety/gates.ts 가 비어있는지

  IF 전부 통과:
    → DONE. PR 생성 가능.

  IF 에러 발생:
    → 에러 메시지 분석
    → 원인 파일 수정
    → LOOP 처음으로 돌아감

  MAX 시도: 10회 (10회 초과 시 남은 에러 목록 보고 후 중단)
```

### 자주 발생하는 에러 패턴과 수정법

| 에러 | 원인 | 수정 |
|------|------|------|
| `Cannot find module './db/memory'` | memory.ts 미생성 또는 export 누락 | 파일 존재 확인 + export 확인 |
| `Property 'room_id' does not exist` | schema.ts에 room_id 미추가 | agentMessages 테이블에 room_id 컬럼 추가 |
| `Type 'string' is not assignable to 'Promise<string>'` | buildAgentPrompt async 전환 후 호출부 await 누락 | 호출부에 await 추가 |
| `relation "agent_memories" does not exist` | Drizzle migration 미실행 | npm run db:generate → npm run db:migrate |
| 기존 테스트 실패 | 기존 코드를 건드림 | git diff로 변경 확인 → 원복 |

### 검증 완료 후

```
1. git add -A
2. git commit -m "feat(company-v2): BiniLab AI Company v2 구현

   - 기억 시스템 (agent_memories, agent_episodes, loadAgentContext)
   - 회의 시스템 (자유토론, 합의 기반 종료, 캐스케이드)
   - 전략 아카이브 (버전 관리, 롤백, CEO 메타인지)
   - 에이전트 캐릭터 (11명 성격, 팀장 구조)
   - COMPANY.md (프로젝트 인덱스, 시스템 가이드)
   - agent-output-parser (태그 파싱, Phase Gate)
   - agent-spawner async 전환 + 기억 주입"
3. gh pr create --base dev --title "feat: BiniLab AI Company v2"
```

## 금지 사항
- 기존 22개 DB 테이블 수정 금지 (agent_messages room_id만 예외)
- daily-pipeline.ts의 Phase 1,2,4,5,6 코드 수정 금지
- Safety Gate(gates.ts) 수정 금지
- Anthropic API 직접 호출 금지
- 새 npm 의존성 추가 금지 (기존 Drizzle/vitest/tsx만 사용)
```
