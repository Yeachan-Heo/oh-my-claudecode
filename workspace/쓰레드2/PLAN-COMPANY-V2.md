# BiniLab AI Company v2 — 구현 계획

> Opus × Codex 5라운드 토론 완료 (R4에서 수렴, 9/10점, 이슈 16/16 해결)

## 핵심 문제
v1에서 에이전트 파일(.claude/agents/)을 만들었지만 실제 스폰 시 사용되지 않았음.
시스템을 만들어도 에이전트가 존재를 모르면 사용하지 않는다.

## 해결 원칙: "에이전트가 모를 수 없게 만든다"

```
1. Spawn Injection — 스폰 시 COMPANY.md + 기억 + 전략을 프롬프트에 직접 주입
2. Tag Interface — [SAVE_MEMORY], [LOG_EPISODE], [CREATE_STRATEGY_VERSION] 태그로 시스템 사용
3. Phase Gates — 태그 없으면 재요청(2회), 실패 시 quarantine (DB 미기록)
```

## 제약 조건
- Claude Code Max 플랜만 사용 (외부 API 없음, 토큰 무제한)
- Supabase PostgreSQL (Drizzle ORM, 22개 기존 테이블 보존)
- 에이전트 스폰 시에만 동작 (24시간 서버 없음)
- 코드/시스템 변경은 시훈(오너) 승인 필요
- 기존 daily-pipeline 6 Phase + Safety Gate 8개 보존
- 비전문가 톤 필수 (성분명/의학용어 금지)

---

## 교차 검증 결과 (2026-03-24)

### 충돌 1: 회의 메시지 테이블 이중화 방지
- **문제**: 별도 meeting_messages 테이블을 만들면 agent_messages와 이중화
- **해결**: `agent_messages`에 `room_id` 컬럼만 ALTER TABLE 추가. 별도 테이블 안 만듦

### 충돌 2: 학습 시스템 이중화 방지 (파일 vs DB)
- **문제**: 현재 `agents/memory/*.md` 파일 기반 + 새 DB → 기억 분산
- **해결**: S-1.5에서 파일→DB 마이그레이션. 이후 DB가 SSOT
  - `strategy-log.md` → `agent_episodes` (type: 'decision')
  - `experiment-log.md` → `experiments` 테이블 (이미 있음)
  - `category-playbook/*.md` → `agent_memories` (scope: 'marketing', type: 'pattern')
  - `weekly-insights.md` → `agent_memories` (scope: 'global', type: 'insight')

### 충돌 3: Phase 3 회의 전환 시 DailyDirective 호환
- **해결**: `meetingToDirective()` 변환 함수 추가. Phase 4 에디터는 변경 없음

### 충돌 4: buildAgentPrompt 기존 함수 보존
- **해결**: 기존 함수 덮어쓰지 않고 **확장** (앞에 COMPANY.md + 기억 주입 추가)

### 충돌 5: Phase Gate 호환
- **해결**: 회의 메시지도 `channel='standup'`으로 저장 → 기존 gate 코드 변경 없음

---

## 프로젝트 인덱스 시스템

COMPANY.md 첫 섹션에 포함하여 모든 에이전트가 자동으로 읽음.

### DB 테이블 (22개 기존 + 4개 신규)
| 테이블 | 용도 | 비고 |
|--------|------|------|
| thread_posts | 수집된 포스트 (raw) | post_source 태깅 |
| content_lifecycle | 콘텐츠 전체 생명주기 | maturity 단계 추적 |
| aff_contents | 생성된 제휴 콘텐츠 | status: draft/ready/published |
| agent_messages | 에이전트 간 소통 | room_id 컬럼 추가 (v2) |
| **agent_memories** | 학습된 기억 | **신규** — scope/importance/type |
| **agent_episodes** | 에피소드 기록 | **신규** — 날짜별 이벤트 로그 |
| **strategy_archive** | 전략 버전 관리 | **신규** — 롤백 가능 |
| **meetings** | 회의 메타데이터 | **신규** — 참석자/안건/결정 |
| experiments | A/B 실험 | autonomy_level 0-3 |
| post_snapshots | 성과 스냅샷 | early/mature/final |
| daily_performance_reports | 일일 분석 | content_analysis jsonb |
| brands | 모니터링 브랜드 (40개) | category별 |
| brand_events | 브랜드 이벤트 | 7일 유효, is_stale 체크 |
| revenue_tracking | 수익 추적 | 클릭/구매/커미션 |
| (나머지 8개) | 수집/인프라용 | channels, crawl_sessions 등 |

### 핵심 파일 맵
| 시스템 | 파일 | 용도 |
|--------|------|------|
| 에이전트 정의 | .claude/agents/*.md | 9명 역할/권한/성격 |
| 조직도 | .claude/agents/agency.md | 전체 구조 + RACI |
| 페르소나 | souls/bini-persona.md | 빈이 캐릭터 |
| 운영 가이드 | ops/*.md (13개) | 업무별 SOP |
| 파이프라인 | src/orchestrator/daily-pipeline.ts | 6 Phase 일일 |
| 에이전트 스폰 | src/orchestrator/agent-spawner.ts | 프롬프트 빌더 |
| 회의 시스템 | src/orchestrator/meeting.ts | **신규** |
| 메모리 헬퍼 | src/db/memory.ts | **신규** |
| 전략 아카이브 | src/db/strategy-archive.ts | **신규** |
| Safety Gate | src/safety/gates.ts | 8개 게시 전 검증 |
| 톤 검증 | src/safety/tone-validator.ts | **신규** |
| 롤백 | scripts/rollback-strategy.ts | **신규** |
| 실험 시스템 | src/db/experiments.ts | A/B 실험 CRUD |
| 수익 추적 | src/db/revenue.ts | 클릭/구매/수익 |

### 수집 도구 맵 (새 스크립트 만들지 말 것)
| 대상 | 도구 | 명령어 |
|------|------|--------|
| Threads 채널 | src/scraper/collect.ts | `npm run collect -- <channel> 50` |
| 키워드 검색 | scripts/collect-by-keyword.ts | `npm run collect:keyword -- --keywords "키워드"` |
| X 트렌드 | scripts/run-trend-pipeline.ts | `npm run trend` |
| 브랜드 리서치 | scripts/research-brands.ts | `npm run research:brands` |
| 성과 수집 | scripts/track-performance.ts | `npm run track` |
| YouTube | scripts/collect-youtube-comments.ts | `npm run collect:youtube` |
| 네이버 검색량 | naver-keyword-search/search.py | `python3 search.py "키워드"` |

### 스킬 맵
| 스킬 | 용도 |
|------|------|
| /daily-run | 6 Phase 에이전트 스폰 파이프라인 |
| /수집 | 7개 수집 도구 통합 |
| /threads-plan | 24h 데이터 기반 포스트 기획 |
| /weekly-retro | 주간 전략회의 자동화 |
| /analyze-performance | 일일 성과분석 |
| /threads-pipeline | 포스트 분석 (니즈→매칭→콘텐츠) |

---

## 구현 단계 (토론 반영 최종)

### S-1. DB 스키마 신규 테이블 생성

기존 22개 테이블은 ALTER 없이 보존. `agent_messages`에만 `room_id` 컬럼 추가.

```sql
-- 의미 기억: 에이전트가 학습한 것
CREATE TABLE agent_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL,              -- 'global', 'marketing', 'analytics', 'private'
  memory_type TEXT NOT NULL,        -- 'insight', 'rule', 'pattern', 'failure'
  content TEXT NOT NULL,
  importance FLOAT DEFAULT 0.5,     -- 0~1
  source TEXT,                      -- 'meeting:daily-0324', 'experiment:EXP-001'
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ            -- NULL = 영구
);

-- 에피소드 기억: 언제 뭘 했는지
CREATE TABLE agent_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,         -- 'decision', 'experiment', 'meeting', 'post', 'error'
  summary TEXT NOT NULL,
  details JSONB,
  occurred_at TIMESTAMPTZ DEFAULT now()
);

-- 전략 아카이브: Hyperagent Archive
CREATE TABLE strategy_archive (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL,
  parent_version TEXT,
  strategy JSONB NOT NULL,          -- {category_ratio, time_slots, experiments, ...}
  performance JSONB,                -- {avg_roi, avg_views, avg_engagement}
  status TEXT DEFAULT 'active',     -- 'active', 'archived', 'deprecated'
  created_at TIMESTAMPTZ DEFAULT now(),
  evaluated_at TIMESTAMPTZ
);

-- 회의 메타데이터
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_name TEXT NOT NULL,
  meeting_type TEXT NOT NULL,       -- 'standup', 'planning', 'review', 'emergency', 'weekly'
  agenda TEXT,
  participants TEXT[],
  status TEXT DEFAULT 'active',     -- 'active', 'concluded'
  decisions JSONB,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  concluded_at TIMESTAMPTZ
);

-- 승인 대기 (CEO 자기개선 → 시훈 승인)
CREATE TABLE pending_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by TEXT NOT NULL,       -- 'minjun-ceo'
  approval_type TEXT NOT NULL,      -- 'ops_change', 'new_agent', 'system_change', 'rollback'
  description TEXT NOT NULL,
  details JSONB,
  status TEXT DEFAULT 'pending',    -- 'pending', 'approved', 'rejected'
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- agent_messages에 room_id 추가
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS room_id UUID;

-- 인덱스
CREATE INDEX idx_memories_agent_scope ON agent_memories(agent_id, scope, importance DESC);
CREATE INDEX idx_memories_global ON agent_memories(scope) WHERE scope = 'global';
CREATE INDEX idx_episodes_agent ON agent_episodes(agent_id, occurred_at DESC);
CREATE INDEX idx_archive_status ON strategy_archive(status, created_at DESC);
CREATE INDEX idx_meetings_status ON meetings(status, created_at DESC);
CREATE INDEX idx_approvals_status ON pending_approvals(status, created_at DESC);
CREATE INDEX idx_messages_room ON agent_messages(room_id) WHERE room_id IS NOT NULL;
```

---

### S-1.5. 파일→DB 마이그레이션

`agents/memory/` 파일 데이터를 DB로 일괄 이전. 이 단계 없으면 기억 이중화.

```typescript
// scripts/migrate-memory-to-db.ts
// 1. strategy-log.md 파싱 → agent_episodes (type: 'decision')
// 2. experiment-log.md 파싱 → experiments 테이블 (이미 존재)에 보강
// 3. category-playbook/*.md 파싱 → agent_memories (scope: 'marketing', type: 'pattern')
// 4. weekly-insights.md 파싱 → agent_memories (scope: 'global', type: 'insight')
// 5. 완료 후 agents/memory/ → agents/memory-archive/ 리네임 (읽기전용)
```

---

### S-2. 메모리 헬퍼 구현 (src/db/memory.ts)

**메모리 회수 랭킹 공식** (Codex R1에서 추가):

```
composite_score = recency_weight(0.4) × recency_score
               + importance_weight(0.4) × importance
               + scope_weight(0.2) × scope_match

recency_score = max(0, 1 - (age_days / 30))  -- 30일 이상이면 0
scope_match = 1.0 (정확 매치) | 0.5 (상위 스코프) | 0.0 (무관)
```

**제한**: top-K (기본 K=10, configurable), 최대 30개, 총 3000 토큰 이하

```typescript
export async function loadAgentContext(agentId: string, department: string, options?: { maxMemories?: number, maxTokens?: number }) {
  const K = options?.maxMemories ?? 10;
  const maxTokens = options?.maxTokens ?? 3000;

  return {
    global: await getTopKMemories('global', null, K),      // 전사 기억
    department: await getTopKMemories(department, null, K), // 부서 기억
    private: await getTopKMemories('private', agentId, K),  // 개인 기억
    episodes: await getRecentEpisodes(agentId, 3),          // 최근 3일 에피소드
    strategy: await getActiveStrategy(),                     // 현재 전략 (아카이브)
    pendingDecisions: await getUnreadDecisions(agentId),    // 미읽은 회의 결정
    pendingApprovals: await getPendingApprovals(),           // 시훈 승인 대기 건
  };
}

export async function saveMemory(params: {
  agentId: string; scope: string; type: string;
  content: string; importance: number; source?: string;
}) { ... }

export async function logEpisode(params: {
  agentId: string; eventType: string;
  summary: string; details?: Record<string, unknown>;
}) { ... }
```

---

### S-3. COMPANY.md 작성

모든 에이전트 프롬프트 앞에 자동 주입되는 단일 가이드.

포함 내용:
1. **프로젝트 인덱스** (위 테이블/파일/도구/스킬 맵)
2. **기억 시스템 사용법** — [SAVE_MEMORY] 태그 형식, 저장 규칙
3. **에피소드 기록법** — [LOG_EPISODE] 태그 형식
4. **전략 아카이브** — [CREATE_STRATEGY_VERSION] 태그 (CEO만)
5. **회의 규칙** — 발언 규칙, 반론 방법, 200자 제한
6. **비전문가 톤 강제** — 성분명/의학용어 감지 시 출력 거부 절차
7. **프롬프트 예산 규칙** — 최대 30개 메모리, 3000 토큰 캡

---

### S-4. agent-spawner.ts 확장

기존 `buildAgentPrompt(agentId, mission, context?)` 함수를 **확장** (덮어쓰지 않음).

```typescript
// 기존 흐름 보존:
// agentDef 읽기 → TOOL_REGISTRY → 페르소나 → 플레이북 → 전략로그 → 미션

// 추가 (프롬프트 앞부분에):
// 1. COMPANY.md 읽기 → 프롬프트 맨 앞에 주입
// 2. loadAgentContext() → 기억/에피소드/전략/미읽은 결정 주입
// 3. 기존 로직 그대로 실행
```

---

### S-5+6. Phase Gate + 회의 오케스트레이터 통합 (공동 개발)

두 시스템이 메모리 게이트를 공유하므로 동일 단계에서 개발.

#### Phase Gate ([SAVE_MEMORY] 검증)

```typescript
function validateAgentOutput(output: string): { passed: boolean, missing: string[] } {
  const hasMemory = output.includes('[SAVE_MEMORY]') && output.includes('[/SAVE_MEMORY]');
  const hasEpisode = output.includes('[LOG_EPISODE]');
  return { passed: hasMemory && hasEpisode, missing: [...] };
}

// 재시도 최대 2회
// 2회 실패 시 → quarantine (DB에 메모리 기록 안 함)
// quarantine 시 에이전트 출력은 파이프라인에는 전달되지만
// 잘못된 기억이 recall pool에 유입되는 것을 원천 차단
```

#### 회의 오케스트레이터 (src/orchestrator/meeting.ts)

**핵심 원칙: 라운드 로빈이 아니라 자유토론.**
실제 회사 회의처럼 에이전트가 자연스럽게 대화한다.

```typescript
interface MeetingConfig {
  roomName: string;
  type: 'standup' | 'planning' | 'review' | 'emergency' | 'weekly' | 'free';
  agenda: string;
  participants: string[];
  createdBy: string;              // 'system' | 'ceo' | 'team_lead' | 'user'
  consensusRequired: boolean;     // true: 합의 날 때까지 (기본), false: 정보 공유만
  maxTurns?: number;              // 안전장치 (기본 30). 합의 못하면 CEO 결정
}

async function runMeeting(config: MeetingConfig): Promise<MeetingResult> {
  // 1. meetings 테이블에 회의 생성

  // 2. 자유토론 루프 (Round Robin 아님!)
  //    매 턴마다:
  //    a. 오케스트레이터가 transcript를 읽고 "다음 발언자"를 동적 선택
  //       - 질문받은 에이전트 우선 (@멘션된 사람)
  //       - 반론할 수 있는 전문 에이전트 우선
  //       - 아직 발언 안 한 에이전트 우선
  //       - 같은 에이전트가 연속 3회 이상 발언 금지
  //    b. 선택된 에이전트를 스폰 (전체 transcript + 자기 기억 주입)
  //    c. 에이전트 발언 → agent_messages에 저장 (room_id 포함)
  //    d. 에이전트가 다른 에이전트를 @멘션하면 다음 턴에 해당 에이전트 소환

  // 3. 합의 체크 (매 5턴마다)
  //    - 오케스트레이터가 transcript 분석: "합의에 도달했는가?"
  //    - 합의 도달 → 결정사항 추출 → 종료
  //    - 합의 안 됨 → 계속 토론
  //    - maxTurns 도달 → CEO가 최종 결정 + 소수의견 기록

  // 4. Devil's Advocate (매 10턴마다)
  //    - 랜덤 에이전트 1명에게 "반드시 반론 제기" 임무 부여
  //    - LLM 동조 편향 방지

  // 5. 회의 종료
  //    - meetings 테이블 concluded + decisions 저장
  //    - 에피소드 기록 (agent_episodes)
  //    - 후속조치 자동 생성 (누가 뭘 해야 하는지)
}
```

**자유토론 vs 라운드 로빈 차이:**
```
라운드 로빈 (이전 - 삭제):
  턴1: 서연 → 턴2: 빈이 → 턴3: 도윤 → 턴4: 민준 → (반복)

자유토론 (현재):
  턴1: 서연 "뷰티 비율 올려야 해요"
  턴2: 빈이 "@서연 동의! 근데 건강도요~" (서연을 멘션했으므로)
  턴3: 도윤 "잠깐, 다양성 체크에 걸려요" (반론 감지 → QA 소환)
  턴4: 서연 "@도윤 실험 슬롯으로 커버하면?" (질문받았으므로 서연 재소환)
  턴5: 민준 "좋아, 70:30으로 가자" (CEO가 정리)
  → 합의 감지 → 종료
```

#### 회의 유형별 설정

| 회의 | 빈도 | 참석자 | 합의 필요 | maxTurns |
|------|------|--------|----------|----------|
| 아침 스탠드업 | 매일 | CEO + 팀장들 | O (합의 때까지) | 30 |
| 포스트 기획 | 매일 | 마케팅부 + 분석부 | O | 30 |
| 성과 리뷰 | 매일 | 분석팀장 + CEO | X (정보 공유) | 15 |
| 주간 전략회의 | 주 1회 | 전체 | O | 50 |
| 긴급 회의 | 수시 | 관련자만 | O | 20 |
| 자유 토론 | 수시 | CEO/팀장이 소환 | X | 30 |

#### 회의방 권한 체계

| 권한 | 시훈(오너) | CEO | 팀장 | 일반 에이전트 |
|------|-----------|-----|------|-------------|
| 회의방 생성 | O | O | O | X |
| 에이전트 소환 | O | O | O (자기 부서만) | X |
| 안건 제안 | O | O | O | O |
| 회의 종료 | O | O | X | X |

#### 시훈 ↔ CEO 캐스케이드 회의

```
시훈이 대시보드에서 CEO에게: "뷰티 비율 높여봐"
  ↓
CEO가 안건 수신 → 자동으로 회의 생성:
  회의방: "오너지시-뷰티비율조정"
  참석자: CEO + 마케팅팀장 + 분석팀장
  agenda: "오너가 뷰티 비율 상향을 지시했습니다. 방안을 논의합시다."
  ↓
하위 회의 결과 → CEO가 시훈에게 보고 (텔레그램)
```

---

### S-7. daily-pipeline Phase 3 전환

```typescript
// 기존: runCEOStandup() → DailyDirective JSON 직접 생성
// 변경: runMeeting({type:'standup'}) → CEO 결정 → meetingToDirective() 변환

function meetingToDirective(ceoDecision: string, performanceData: any): DailyDirective {
  // CEO 발언에서 category_allocation, time_slots, experiments 추출
  // 기존 runCEOStandup()의 ROI 계산 로직 유지
  // 입력만 "회의 합의"로 변경
}

// Phase Gate 호환: 회의 메시지도 channel='standup'으로 저장
// → gatePhase3() 코드 변경 없음
```

---

### S-8. 전략 아카이브 + 롤백 + CEO 메타인지

#### 전략 버전 관리

```typescript
export async function createStrategyVersion(params: {
  parentVersion: string;
  strategy: Record<string, unknown>;
  hypothesis: string;
  createdBy: string;
}): Promise<string> // 새 버전 ID 반환

export async function getActiveStrategy(): Promise<StrategyVersion>
```

#### CEO 메타인지 권한

**자율 변경 가능** (시훈 승인 없이):
- 카테고리 비율 조정 (실험 범위: 메인 70%, 실험 30%)
- 시간대 변경, 포맷/훅 타입 변경
- 새 실험 설계 및 실행

**제안만 가능** (pending_approvals에 기록 → 시훈 승인 필요):
- ops/*.md 문서 내용 변경
- 새 에이전트 추가
- Safety Gate 규칙 변경
- 코드 변경

#### 롤백 시스템 (Codex R3에서 구체화)

**트리거 조건**:
1. `pipeline_runs`의 `gate_failures` ≥ 2 (Safety Gate 2개 이상 실패)
2. 시훈(오너)의 명시적 요청

**롤백 단위**: `strategy_archive` 행(row) 단위

**복원 절차** (scripts/rollback-strategy.ts):
1. 이전 성공 버전 row를 `status='active'`로 승격
2. 현재 row를 `status='deprecated'`로 마킹
3. `pending_approvals`에 롤백 이벤트 기록
4. 텔레그램으로 시훈에게 알림

---

### S-11. E2E 검증 — 백엔드 (대시보드 이전에 실행)

대시보드 없이 백엔드 4개 기준 검증:

1. **기억 재현**: 두 번의 분리된 spawn/run 세션으로 cross-session 기억 재현 확인
2. **CEO 회의 토론**: 회의 1회 소집 → 토론 → 반박 → 합의 확인
3. **전략 아카이브 롤백**: rollback 시나리오 1회 실행 검증
4. **daily-pipeline 정상 동작**: Phase 1~6 + Safety Gate 8개 모두 통과

추가: `tone-validator.ts` 실행 → 에이전트 출력에서 성분명/의학용어 위반 건수 0 확인

---

### S-9. 대시보드 — 기본 레이아웃

**S-11 백엔드 검증 완료 후 진행** (Codex R1에서 순서 조정)

기술 스택:
- Next.js App Router (기존 dashboard/ 확장)
- shadcn/ui (AI Group Chat Block 참고)
- Tailwind CSS
- React Flow (조직도)

레이아웃:
```
┌──────────────────────────────────────────────────────┐
│ 사이드바 (240px)          │  메인 영역                │
│                           │                          │
│ [에이전트 목록]            │  회의방: 전략회의 #3      │
│  ● CEO 민준 (온라인)      │  ─────────────────       │
│  ● 마케팅팀장 (실행중)     │  민준(CEO): 오늘 회의는...│
│  ○ 분석팀장 (대기)        │  서연(분석): 데이터 보면...│
│                           │  도윤(QA): 근데 이건...   │
│ [회의방 목록]              │  ─────────────────       │
│  # 아침스탠드업            │  [+ 에이전트 소환]        │
│  # 포스트기획-0324         │                          │
│  + 새 회의방              │                          │
│                           ├──────────────────────────│
│ [조직도 보기]              │  📊 조직도 / 📈 성과     │
└──────────────────────────────────────────────────────┘
```

---

### S-10. 회의방 채팅 UI + Supabase Realtime

- Supabase Realtime Broadcast로 회의 메시지 실시간 표시
- @멘션으로 에이전트 소환 기능
- 시훈 ↔ CEO 대화 기능 (대시보드에서 CEO에게 안건 전달)
- 에이전트 레지스트리 UI (agents 테이블에서 동적 로드, 새 에이전트 자동 반영)

---

### S-12. 최종 수용 검증 — 전체

S-9/S-10 완료 후 실행. 전체 수용 기준 5개 통합 검증:

1. 에이전트가 이전 세션의 결정/성과를 기억하고 언급함
2. CEO가 회의를 소집하고 에이전트들이 실제로 토론함 (반박 포함)
3. 대시보드에서 회의 대화를 실시간으로 볼 수 있음
4. 전략 변경 시 아카이브에 버전이 생성되고 실패 시 롤백 가능
5. 기존 daily-pipeline 정상 동작 (Phase 1~6 + Safety Gate)

추가: rollback 시나리오 1회 검증 + tone-validator.ts 최종 톤 확인

---

## 리스크

| ID | 심각도 | 설명 | 완화 |
|----|--------|------|------|
| R-1 | HIGH | 에이전트가 [SAVE_MEMORY] 태그를 안 씀 | Phase Gate: 2회 재시도 → quarantine (DB 미기록) |
| R-2 | MED | 회의 라운드가 길어지면 토큰 폭발 | maxRounds 제한 + 라운드당 토큰 캡 |
| R-3 | HIGH | 파일 기반 학습과 DB 이중화 | S-1.5 마이그레이션으로 해소 |
| R-4 | MED | 대시보드가 핵심 가치보다 우선될 위험 | S-11 백엔드 검증 → S-9/S-10 순서 |
| R-5 | HIGH | 자기개선이 ops 문서를 잘못 수정 | pending_approvals 게이트 + 시훈 승인 |

---

## 완료 기준

1. 에이전트가 이전 세션의 결정/성과를 기억하고 언급함
2. CEO가 회의를 소집하고 에이전트들이 실제로 토론함 (반박 포함)
3. 대시보드에서 회의 대화를 실시간으로 볼 수 있음
4. 전략 변경 시 아카이브에 버전이 생성되고 실패 시 롤백 가능
5. 기존 daily-pipeline이 정상 동작 (Phase 1~6 + Safety Gate)

---

## "에이전트가 시스템을 모르는 문제" 방지 체크리스트

| 문제 | 방지 장치 | 구현 위치 |
|------|----------|----------|
| 기억 시스템 존재를 모름 | COMPANY.md를 모든 프롬프트 앞에 주입 | agent-spawner.ts (S-4) |
| 기억을 안 읽음 | loadAgentContext() 자동 실행 → 프롬프트에 포함 | agent-spawner.ts (S-4) |
| 기억을 안 저장함 | Phase Gate: 태그 없으면 2회 재시도 → quarantine | daily-pipeline.ts (S-5+6) |
| 잘못된 기억 유입 | quarantine 시 DB 미기록 (recall pool 보호) | daily-pipeline.ts (S-5+6) |
| 회의 규칙을 모름 | 회의 프롬프트에 규칙 직접 포함 | meeting.ts (S-5+6) |
| 전략 아카이브를 안 씀 | CEO 프롬프트에 [CREATE_STRATEGY_VERSION] 필수 명시 | minjun-ceo.md (S-8) |
| ops 수정이 무단 적용 | pending_approvals 테이블 + daily-run 전 확인 | S-8 |
| 비전문가 톤 위반 | tone-validator.ts 게이트 | S-11, S-12 |
| 새 에이전트가 시스템 모름 | COMPANY.md가 SSOT → 새 에이전트도 자동 주입 | agent-spawner.ts (S-4) |
| 폴더 전체 탐색 낭비 | 프로젝트 인덱스 (COMPANY.md 첫 섹션) | S-3 |

---

---

## 보완: 원래 요구사항에서 누락된 항목 (2026-03-24)

### 보완 1: 에이전트 캐릭터/성격 시스템 (Q2-2, Q8-1, Q8-2)

각 에이전트에 **성격**을 부여하고, 성격이 **업무 판단에 영향**을 준다.

#### 성격 설계 원칙
- 역할에 맞는 성격 부여 (마케팅 = 활기찬, 분석 = 냉철한)
- 성격이 토론에서 자연스러운 긴장감 생성
- .claude/agents/*.md의 페르소나 섹션에 추가

#### 에이전트별 성격 (S-3 COMPANY.md + 각 agent.md에 반영)

| 에이전트 | 역할 | 성격 | 말투 | 업무 영향 |
|---------|------|------|------|----------|
| 민준 CEO | 경영 | 결단력 있고 균형 잡힌 | 차분하지만 단호 | 데이터 없이 감으로 결정 안 함. 항상 근거 요구 |
| 서연 분석가 | 분석 | 냉철하고 팩트 중심 | "데이터로 보면..." | 감정적 판단 거부, 숫자 없으면 보류 주장 |
| 준호 리서처 | 수집 | 호기심 많고 탐험적 | "이거 재밌는 거 발견했는데요!" | 새 트렌드에 긍정적, 위험 과소평가 경향 |
| 빈이 에디터 | 뷰티 | 밝고 공감력 높음 | "~거든요!", "ㅋㅋ 진짜" | 독자 감정 우선, 데이터보다 공감 중시 |
| 하나 에디터 | 건강 | 신중하고 책임감 있음 | "근데 이건 확인해봐야..." | 건강 관련 과장 절대 거부 |
| 소라 에디터 | 생활 | 실용적이고 효율적 | "그냥 이렇게 하면 되잖아" | 복잡한 전략보다 심플한 접근 선호 |
| 지우 에디터 | 다이어트 | 동기부여형, 에너지 넘침 | "할 수 있어요!!" | 긍정 편향, 실패 가능성 과소평가 |
| 도윤 QA | 품질 | 꼼꼼하고 보수적 | "잠깐, 이건 안 돼요" | 새 시도에 회의적, 안전 우선 |
| 태호 엔지니어 | 개발 | 논리적이고 효율 추구 | "기술적으로 이건..." | 과도한 기능 반대, 심플한 구현 주장 |

#### 성격이 토론에 미치는 영향 예시
```
안건: "다이어트 카테고리를 30%로 올리자"

지우(다이어트): "좋아요!! 다이어트 시즌이니까 잘 될 거예요!"
도윤(QA): "잠깐, 데이터 근거가 없잖아요. 현재 ROI가 C등급인데..."
서연(분석): "데이터로 보면 다이어트는 계절성이 강해서 3월에만 반짝이에요"
빈이(뷰티): "근데 다이어트 독자들 공감 포인트가 되게 좋거든요~"
민준(CEO): "서연 말이 맞아. 계절성 데이터 보고 4월까지만 실험하자"
```

#### 구현 위치
- S-3: COMPANY.md에 성격 가이드 포함
- S-4: agent-spawner.ts에서 각 에이전트 성격을 프롬프트에 주입
- 기존 .claude/agents/*.md 파일에 `## 성격` 섹션 추가

---

### 보완 2: 팀장 구조 (Q9-2)

부서별 팀장을 두어 CEO 부담을 줄이고, 계정 확장 시 스케일링.

#### 팀장 에이전트 추가 (2명)

| 팀장 | 부서 | 관리 대상 | 역할 |
|------|------|----------|------|
| 마케팅팀장 (신규) | 마케팅부 | 빈이, 하나, 소라, 지우 | 포스트 기획 조율, 에디터 피드백, 카테고리 배분 실행 |
| 분석팀장 (서연 승격) | 분석부 | 준호(리서처) | 데이터 수집 지시, 성과 분석 총괄, CEO에 보고 |

#### 보고 체계
```
시훈(오너)
  └── 민준(CEO)
        ├── 마케팅팀장 → 빈이, 하나, 소라, 지우
        ├── 서연(분석팀장) → 준호
        ├── 도윤(QA) — 독립 (팀장 불필요)
        └── 태호(엔지니어) — 독립
```

#### 구현 위치
- S-1: agents 테이블에 `is_team_lead` 컬럼 추가
- S-3: COMPANY.md에 보고 체계 명시
- .claude/agents/ 에 marketing-lead.md 추가

---

### 보완 3: 계정 확장 메커니즘 (Q2-3, Q11-1)

계정 1개 → 10개로 확장 시 팀이 동적으로 생성되는 구조.

#### 확장 모델
```
계정 1개 (현재):
  마케팅부 (에디터 4명) + 분석부 (서연+준호) + QA + 엔지니어

계정 3개:
  마케팅 1부 (계정A 에디터 4명) + 마케팅 2부 (계정B) + 마케팅 3부 (계정C)
  분석부 (공유 — 전 계정 분석)
  QA (공유)

계정 10개:
  마케팅 1~10부 (각 계정별)
  분석 1부 (계정 1~5) + 분석 2부 (계정 6~10)
  QA 1부 + QA 2부
```

#### DB 스키마 (S-1에 추가)
```sql
-- 에이전트 레지스트리 (대시보드 연동)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,              -- 'bini-beauty-editor'
  name TEXT NOT NULL,               -- '빈이'
  role TEXT NOT NULL,               -- 'editor'
  department TEXT NOT NULL,         -- 'marketing'
  team TEXT,                        -- 'account-A' (계정별 팀)
  is_team_lead BOOLEAN DEFAULT false,
  personality JSONB,                -- {trait, speaking_style, work_bias}
  avatar_color TEXT,                -- 대시보드 표시용
  status TEXT DEFAULT 'idle',       -- 'idle', 'active', 'in_meeting'
  created_at TIMESTAMPTZ DEFAULT now()
);
```

#### 새 에이전트 추가 프로세스 (시훈 승인 필요)
1. CEO가 `pending_approvals`에 "새 에이전트 추가" 요청
2. 시훈 승인
3. agents 테이블에 INSERT + .claude/agents/{id}.md 생성
4. agent-spawner.ts AGENT_REGISTRY에 자동 등록 (DB에서 읽기)
5. 대시보드에 자동 반영

---

### 보완 4: 텔레그램 보고 시스템 (Q4-3, Q12-1, Q12-2)

#### S-13 추가: 텔레그램 보고 시스템

**일일 보고 (매일 daily-run 완료 후 자동)**
```
[BiniLab 일일 보고 📊]

📝 오늘 게시: 10개 (뷰티7, 건강2, 생활1)
📈 어제 성과: 평균 8,200뷰, 참여율 3.1%
  - 최고: "이 선크림 진짜..." (14,200뷰)
  - 최저: "다이어트 꿀팁" (2,100뷰)
💬 오늘 회의 요약:
  - 스탠드업: 뷰티 비율 70% 유지 결정
  - 기획회의: 선크림 시즌 콘텐츠 강화
💰 수익: 클릭 127건, 전환 3건, ₩45,000
📋 내일 계획: 뷰티 7개 + 건강 2개 + 실험 1개
```

**주간 보고 (매주 weekly-retro 완료 후)**
```
[BiniLab 주간 보고 📋]

📊 주간 성과: 포스트 68개, 평균 7,800뷰
📈 성장: 전주 대비 +12%
💰 주간 수익: ₩312,000
🔬 실험 결과: 숫자형 훅 > 질문형 훅 (14% 차이)
🧠 CEO 전략 변경: 뷰티 65%→70%, 다이어트 15%→10%
⚠️ 시훈 승인 대기: 0건
```

**긴급 알림 (즉시)**
- Safety Gate 2개 이상 실패
- CEO가 시훈 승인 요청
- 계정 제한/밴 감지
- 전략 롤백 발생

#### 구현
```typescript
// src/utils/telegram-report.ts
export async function sendDailyReport(pipelineResult: PipelineResult) { ... }
export async function sendWeeklyReport(retroResult: RetroResult) { ... }
export async function sendUrgentAlert(type: string, message: string) { ... }
```

---

### 보완 5: 대시보드 에이전트 소환 UI (원래 요구사항 상세화)

S-10에 아래 내용 보강:

#### 에이전트 소환 방식
```
대시보드 회의방에서:
1. 입력창에 '@' 입력 → 전체 에이전트 목록 드롭다운
2. 에이전트 선택 → 회의방에 참여 알림
3. 또는 CEO가 "마케팅부 전원 소집" → 부서 단위 소환

에이전트 목록은 agents 테이블에서 동적 로드
→ 새 에이전트 추가 시 대시보드에 자동 반영
```

#### 에이전트 레지스트리 UI
```
사이드바에서:
- 부서별 그룹핑 (경영/마케팅/분석/품질/개발)
- 각 에이전트: 아바타 + 이름 + 역할 + 상태(●온라인 ○오프라인)
- 클릭 시 상세: 최근 발언, 기억 목록, 성과
- 팀장 표시 (별표 or 배지)
```

---

### 보완 6: AGENT_REGISTRY 동적화 (Q2-3 지원)

현재 agent-spawner.ts의 AGENT_REGISTRY는 코드에 하드코딩.
계정 확장 시 매번 코드 수정이 필요 → **DB에서 동적 로드**로 변경.

```typescript
// 현재 (하드코딩)
const AGENT_REGISTRY = { 'minjun-ceo': {...}, 'bini-beauty-editor': {...}, ... };

// 변경 (DB 동적 로드)
async function getAgentRegistry(): Promise<Record<string, AgentDef>> {
  const agents = await db.select().from(agentsTable);
  return Object.fromEntries(agents.map(a => [a.id, {
    phase: a.phase,
    role: a.role,
    department: a.department,
    team: a.team,
    personality: a.personality,
    is_team_lead: a.is_team_lead,
  }]));
}
```

이로써 새 에이전트 = DB INSERT만 하면 자동 등록.

---

## 구현 순서 요약

```
S-1   → DB 스키마 (테이블 6개: memories, episodes, archive, meetings, approvals, agents + ALTER 1개)
S-1.5 → 파일→DB 마이그레이션 (agents/memory/ → DB)
S-2   → 메모리 헬퍼 (loadAgentContext + saveMemory + logEpisode + 랭킹 공식)
S-3   → COMPANY.md (인덱스 + 가이드 + 태그 + 톤 + 성격 가이드)
S-3.5 → 에이전트 성격/캐릭터 설정 (.claude/agents/*.md에 성격 섹션 추가)
S-4   → agent-spawner.ts 확장 (COMPANY.md + 기억 + 성격 주입 + DB 동적 레지스트리)
S-5+6 → Phase Gate + 회의 오케스트레이터 (자유토론 + Devil's Advocate + 캐스케이드)
S-7   → daily-pipeline Phase 3 회의 전환 + meetingToDirective()
S-8   → 전략 아카이브 + 롤백 + CEO 메타인지 + pending_approvals
S-8.5 → 팀장 에이전트 추가 (마케팅팀장 + 서연 분석팀장 승격)
S-11  → E2E 백엔드 검증 (대시보드 전)
S-9   → 대시보드 기본 레이아웃 + 에이전트 레지스트리 UI
S-10  → 회의방 채팅 UI + Realtime + @소환 + 권한 체계
S-12  → 최종 수용 검증 (전체)
S-13  → 텔레그램 보고 시스템 (일일/주간/긴급)
```

## 비용 영향
- 추가 API 비용: 없음 (Claude Code Max)
- 추가 DB 비용: Supabase 무료 티어 범위 내 (테이블 5개 추가)
- 추가 서버 비용: 없음 (로컬 실행)
- 토큰 증가: 에이전트당 ~2,000토큰 (기억 주입) → Max 플랜이므로 무시 가능

## 토론 메트릭
- Opus × Codex 4라운드 (5 중 4에서 수렴)
- 이슈 16/16 해결 (100%)
- 최종 평점 9/10
- 수렴: streak=2에서 stop 판정
