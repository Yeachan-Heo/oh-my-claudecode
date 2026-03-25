# BiniLab AI Company v2 — 최종 구현 계획

> Opus × Codex 4라운드 토론 (9/10, 이슈 16/16 해결)
> + 3인 검증팀 리뷰 (CRITICAL 2 + MAJOR 7 + MINOR 5 → 전체 반영)
> 최종 확정: 2026-03-24

---

## 비전

기억하고, 토론하고, 스스로 진화하는 AI 마케팅 회사.
Threads 제휴마케팅 전용, 월 수익 2000만원 목표.

## 핵심 문제

v1에서 시스템을 만들어도 에이전트가 존재를 모르고 사용하지 않았음.

## 해결 원칙: "에이전트가 모를 수 없게 만든다"

```
1. Spawn Injection — 스폰 시 COMPANY.md + 기억 + 전략을 프롬프트에 직접 주입
2. Tag Interface — [SAVE_MEMORY], [LOG_EPISODE], [CREATE_STRATEGY_VERSION] 태그
3. Output Parser — 에이전트 출력을 수신하여 태그를 파싱하는 전용 모듈 (C2 해결)
4. Phase Gates — 태그 없으면 재시도(2회), 실패 시 quarantine (DB 미기록)
```

## 제약 조건

- Claude Code Max 플랜만 사용 (외부 API 없음, 토큰 무제한)
- Supabase PostgreSQL (Drizzle ORM, 22개 기존 테이블 보존)
- 에이전트 스폰 시에만 동작 (24시간 서버 없음)
- 코드/시스템/비용 변경은 시훈(오너) 승인 필요
- 기존 daily-pipeline 6 Phase + Safety Gate 8개 보존
- 비전문가 톤 필수 (성분명/의학용어 금지)
- 채널 스코프: Threads 제휴마케팅 전용 (다른 채널 확장 안 함)

## 수익 목표 및 KPI (M1 해결)

| 기간 | 목표 | 핵심 KPI |
|------|------|----------|
| 1개월 | 시스템 안정화 | 일일 10포스트 자동 게시, 워밍업 완료 |
| 3개월 | 월 50만원 | 일일 클릭 200+, 전환율 2%+ |
| 6개월 | 월 200만원 | 계정 3개, 카테고리 6개+ |
| 12개월 | 월 2000만원 | 계정 10개, 자율 전략 진화 |

CEO 스탠드업에서 매일 수익 목표 대비 진척도를 리뷰한다.
strategy_archive의 performance JSONB에 `revenue_target`, `revenue_actual` 필드를 포함한다.

---

## 교차 검증 결과 (기존 코드 호환성)

| 충돌 | 해결 |
|------|------|
| 회의 메시지 이중화 | `agent_messages`에 `room_id` 컬럼만 추가. 별도 테이블 안 만듦 |
| 학습 파일 vs DB 이중화 | S-1.5에서 파일→DB 마이그레이션. DB가 SSOT |
| Phase 3 DailyDirective 호환 | `meetingToDirective()` 변환 함수. Phase 4 변경 없음 |
| buildAgentPrompt 보존 | 기존 동기→**async 전환** (M5). 호출부 await 추가 |
| Phase Gate 호환 | 회의 메시지도 `channel='standup'`으로 저장 → gate 코드 변경 없음 |
| 에이전트 출력 파싱 레이어 부재 | **`agent-output-parser.ts` 신규 모듈** 추가 (C2) |
| 신규 테이블 Drizzle 동기화 | raw SQL + **`schema.ts`에 Drizzle 정의도 추가** (M6) |
| pipeline_runs 테이블 부재 | `agent_episodes`에 `event_type='pipeline_run'`으로 통합 (M7) |

---

## 프로젝트 인덱스 (COMPANY.md 첫 섹션)

### DB 테이블 (22개 기존 + 6개 신규)

| 테이블 | 용도 | 비고 |
|--------|------|------|
| thread_posts | 수집된 포스트 | post_source 태깅 |
| content_lifecycle | 콘텐츠 생명주기 | maturity 단계 |
| aff_contents | 제휴 콘텐츠 | status: draft/ready/published |
| agent_messages | 에이전트 소통 | room_id 추가 (v2) |
| **agent_memories** | 학습된 기억 | **신규** |
| **agent_episodes** | 에피소드 기록 | **신규** (pipeline_run 포함) |
| **strategy_archive** | 전략 버전 관리 | **신규** |
| **meetings** | 회의 메타데이터 | **신규** |
| **pending_approvals** | 승인 대기 | **신규** |
| **agents** | 에이전트 레지스트리 | **신규** (대시보드 연동) |
| experiments | A/B 실험 | autonomy_level 0-3 |
| revenue_tracking | 수익 추적 | 클릭/구매/커미션 |
| (나머지 10개) | 수집/인프라용 | |

### 핵심 파일 맵

| 시스템 | 파일 | 용도 |
|--------|------|------|
| 회사 가이드 | COMPANY.md | **신규** — 모든 에이전트가 읽는 SSOT |
| 에이전트 정의 | .claude/agents/*.md | 11명 역할/권한/성격 |
| 파이프라인 | src/orchestrator/daily-pipeline.ts | 6 Phase |
| 에이전트 스폰 | src/orchestrator/agent-spawner.ts | 프롬프트 빌더 (async) |
| **출력 파서** | src/orchestrator/agent-output-parser.ts | **신규** — 태그 파싱+DB 저장 |
| **회의 시스템** | src/orchestrator/meeting.ts | **신규** — 자유토론 |
| **메모리 헬퍼** | src/db/memory.ts | **신규** — 기억 CRUD |
| **전략 아카이브** | src/db/strategy-archive.ts | **신규** — 버전+롤백 |
| Safety Gate | src/safety/gates.ts | 8개 검증 |
| **톤 검증** | src/safety/tone-validator.ts | **신규** |
| **롤백 스크립트** | scripts/rollback-strategy.ts | **신규** |

### 수집 도구 맵 (새 스크립트 만들지 말 것)

| 대상 | 도구 |
|------|------|
| Threads 채널 | src/scraper/collect.ts |
| 키워드 검색 | scripts/collect-by-keyword.ts |
| X 트렌드 | scripts/run-trend-pipeline.ts |
| 브랜드 리서치 | scripts/research-brands.ts |
| 성과 수집 | scripts/track-performance.ts |
| YouTube | scripts/collect-youtube-comments.ts |

---

## 에이전트 조직도 (M2, M4 해결)

### 조직 구조

```
시훈 (오너/회장)
  └── 민준 (CEO) — 전략총괄
        ├── 지현 (마케팅팀장) — 콘텐츠 조율
        │     ├── 빈이 (뷰티 크리에이터)
        │     ├── 하나 (건강 에디터)
        │     ├── 소라 (생활 큐레이터)
        │     └── 지우 (다이어트 코치)
        ├── 서연 (분석팀장) — 데이터 총괄
        │     └── 준호 (트렌드헌터)
        ├── 도윤 (품질검수관)
        └── 태호 (시스템엔지니어)
```

### 에이전트 캐릭터/성격 (업무에 영향)

| 에이전트 | 역할 (구체적) | 성격 | 말투 | 업무 영향 |
|---------|-------------|------|------|----------|
| 민준 CEO | 전략총괄 | 결단력+균형감 | 차분하지만 단호 | 숫자 근거 없으면 결정 안 함 |
| **지현** 마케팅팀장 | 콘텐츠 조율 | **리더십+포용력** | **"다들 의견 모아볼까요~"** | **에디터 의견 종합, 갈등 조율** |
| 서연 분석팀장 | 성과추적관 | 냉철+팩트중심 | "데이터로 보면..." | 감정적 판단 거부, 숫자 없으면 보류 |
| 준호 트렌드헌터 | 트렌드발굴 | 호기심+탐험적 | "이거 재밌는 거 찾았어요!" | 새 트렌드에 긍정적, 위험 과소평가 |
| 빈이 뷰티크리에이터 | 뷰티 콘텐츠 | 밝고 공감력 | "~거든요! ㅋㅋ" | 독자 감정 우선 |
| 하나 건강에디터 | 건강 콘텐츠 | 신중+책임감 | "근데 이건 확인해봐야..." | 과장 절대 거부 |
| 소라 생활큐레이터 | 생활 콘텐츠 | 실용+효율 | "그냥 이렇게 하면 되잖아" | 심플한 접근 선호 |
| 지우 다이어트코치 | 다이어트 콘텐츠 | 동기부여형 | "할 수 있어요!!" | 긍정 편향 |
| 도윤 품질검수관 | QA+Safety | 꼼꼼+보수적 | "잠깐, 이건 안 돼요" | 새 시도에 회의적, 안전 우선 |
| 태호 시스템엔지니어 | 코드/인프라 | 논리+효율 | "기술적으로 이건..." | 과도한 기능 반대 |

### 성격이 토론에 미치는 영향 (프롬프트에 강제)

에이전트 .md 파일의 `## 성격` 섹션에 아래 형식으로 추가:
```markdown
## 성격 (업무 영향 — 반드시 따를 것)
- 당신의 성격: [특성]
- 업무 판단 규칙: [구체적 행동 규칙]
  예: "숫자 근거가 없는 제안에는 반드시 '데이터가 필요합니다'라고 보류를 주장하라"
- 말투: [구체적 패턴]
- 금지: [이 성격과 반대되는 행동]
```

---

## 구현 단계

### S-1. DB 스키마 (Drizzle + raw SQL 양쪽)

**schema.ts에 Drizzle 정의 추가** (M6) + Supabase migration으로 CREATE TABLE.

```sql
-- 에이전트 레지스트리 (대시보드 연동)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  department TEXT NOT NULL,
  team TEXT,
  is_team_lead BOOLEAN DEFAULT false,
  personality JSONB,
  avatar_color TEXT,
  status TEXT DEFAULT 'idle',
  agent_file TEXT,                   -- '.claude/agents/bini-beauty-editor.md'
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 의미 기억
CREATE TABLE agent_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  importance FLOAT DEFAULT 0.5,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);

-- 에피소드 기억 (pipeline_run도 여기에 통합 — M7)
CREATE TABLE agent_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,          -- 'decision', 'experiment', 'meeting', 'post', 'error', 'pipeline_run'
  summary TEXT NOT NULL,
  details JSONB,                     -- pipeline_run 시: {phases_completed, gate_failures, errors}
  occurred_at TIMESTAMPTZ DEFAULT now()
);

-- 전략 아카이브
CREATE TABLE strategy_archive (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL,
  parent_version TEXT,
  strategy JSONB NOT NULL,           -- {category_ratio, time_slots, experiments, categories[], ...}
  performance JSONB,                 -- {avg_roi, avg_views, revenue_target, revenue_actual}
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  evaluated_at TIMESTAMPTZ
);

-- 회의 메타데이터
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_name TEXT NOT NULL,
  meeting_type TEXT NOT NULL,
  agenda TEXT,
  participants TEXT[],
  status TEXT DEFAULT 'active',
  decisions JSONB,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  concluded_at TIMESTAMPTZ
);

-- 승인 대기
CREATE TABLE pending_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by TEXT NOT NULL,
  approval_type TEXT NOT NULL,       -- 'ops_change', 'new_agent', 'system_change', 'rollback', 'budget', 'new_category'
  description TEXT NOT NULL,
  details JSONB,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- agent_messages에 room_id 추가
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS room_id TEXT;

-- 인덱스
CREATE INDEX idx_memories_agent_scope ON agent_memories(agent_id, scope, importance DESC);
CREATE INDEX idx_memories_global ON agent_memories(scope) WHERE scope = 'global';
CREATE INDEX idx_episodes_agent ON agent_episodes(agent_id, occurred_at DESC);
CREATE INDEX idx_episodes_pipeline ON agent_episodes(event_type) WHERE event_type = 'pipeline_run';
CREATE INDEX idx_archive_status ON strategy_archive(status, created_at DESC);
CREATE INDEX idx_meetings_status ON meetings(status, created_at DESC);
CREATE INDEX idx_approvals_status ON pending_approvals(status, created_at DESC);
CREATE INDEX idx_messages_room ON agent_messages(room_id) WHERE room_id IS NOT NULL;
```

**agents 테이블 초기 시딩**: 11명 에이전트 INSERT (9명 기존 + 지현 마케팅팀장 + 서연 팀장 승격)

**중요 (M6)**: 모든 테이블을 `schema.ts`에 Drizzle 정의로도 추가.
`room_id`는 기존 패턴에 맞춰 `text` 타입 사용 (uuid import 불필요).

---

### S-1.5. 파일→DB 마이그레이션

```typescript
// scripts/migrate-memory-to-db.ts
// 1. strategy-log.md → agent_episodes (type: 'decision')
// 2. experiment-log.md → experiments 테이블 보강
// 3. category-playbook/*.md → agent_memories (scope: 'marketing', type: 'pattern')
// 4. weekly-insights.md → agent_memories (scope: 'global', type: 'insight')
// 5. 완료 후 agents/memory/ → agents/memory-archive/ 리네임

// strategy-logger.ts는 래퍼로 유지 — 내부에서 DB 함수 호출 (M2 호환)
// daily-pipeline.ts의 logDecision()/updatePlaybook() 호출 코드 변경 없이 동작
```

---

### S-2. 메모리 헬퍼 (src/db/memory.ts)

**랭킹 공식**:
```
composite = recency(0.4) × max(0, 1 - age_days/30)
          + importance(0.4) × importance
          + scope(0.2) × scope_match
```

**제한**: top-K (기본 10), 최대 30개, 총 3000 토큰

```typescript
// async 함수 (M5 — buildAgentPrompt가 async 전환되므로)
export async function loadAgentContext(agentId: string, department: string): Promise<AgentContext> {
  // 7개 하위 쿼리 — 각각 try-catch + 빈 배열 fallback
  return {
    global: await getTopKMemories('global', null, 10).catch(() => []),
    department: await getTopKMemories(department, null, 10).catch(() => []),
    private: await getTopKMemories('private', agentId, 10).catch(() => []),
    episodes: await getRecentEpisodes(agentId, 3).catch(() => []),
    strategy: await getActiveStrategy().catch(() => null),
    pendingDecisions: await getUnreadDecisions(agentId).catch(() => []),
    pendingApprovals: await getPendingApprovals().catch(() => []),
  };
}

// 기억→프롬프트 문자열 변환 (코드 감사관 지적 반영)
export function formatMemoryForPrompt(ctx: AgentContext): string {
  // 각 섹션을 마크다운으로 포맷팅
  // 총 토큰 3000 이하로 truncate
}

export async function saveMemory(...) { ... }
export async function logEpisode(...) { ... }
```

**sendMessage 확장** (m1):
```typescript
// agent-messages.ts에 추가
export async function sendMessage(..., roomId?: string) { ... }  // optional 파라미터
export async function getMessagesByRoomId(roomId: string) { ... } // 신규 함수
```

---

### S-3. COMPANY.md 작성

포함 내용:
1. **프로젝트 인덱스** (위 테이블/파일/도구 맵)
2. **채널 스코프**: Threads 제휴마케팅 전용
3. **수익 목표**: 월 2000만원, 분기별 마일스톤
4. **기억 시스템 사용법** — 태그 형식, 저장/비저장 규칙, 최대 30개/3000토큰
5. **에피소드 기록법** — 태그 형식
6. **전략 아카이브** — CEO 전용 태그
7. **회의 규칙** — 자유토론 방식, 반박 방법, 합의 기준
8. **비전문가 톤** — 성분명/의학용어 감지 시 출력 거부
9. **성격 가이드** — "반드시 아래 성격에 따라 판단하라"

---

### S-3.5. 에이전트 캐릭터 설정

각 .claude/agents/*.md 파일에 `## 성격 (업무 영향)` 섹션 추가.
기존 minjun-ceo.md의 성격("냉철, 분석적") → 플랜 테이블 기준으로 통일.
**마케팅팀장 지현** 에이전트 파일 신규 생성: `.claude/agents/jihyun-marketing-lead.md`

---

### S-4. agent-spawner.ts 확장

**M5 해결: async 전환**

```typescript
// 기존: function buildAgentPrompt(agentId, mission, context?): string
// 변경: async function buildAgentPrompt(agentId, mission, context?): Promise<string>

// 추가 흐름 (기존 로직 앞에):
// 1. COMPANY.md readFileSync → 프롬프트 맨 앞
// 2. loadAgentContext(agentId, department) → await
// 3. formatMemoryForPrompt(ctx) → 기억 섹션 주입
// 4. [기존 로직] agentDef → TOOL_REGISTRY → 페르소나 → 플레이북 → 미션

// 호출부(daily-pipeline.ts, /daily-run 스킬) await 추가
```

**AGENT_REGISTRY 동적화** (계정 확장 대비):
```typescript
// 현재: const AGENT_REGISTRY = { ... } (하드코딩)
// 변경: async function getAgentRegistry() — agents DB 테이블에서 읽기
// 초기: 하드코딩 유지 + DB에도 동일 데이터. 불일치 시 DB 우선.
// 확장 시: 하드코딩 제거, DB만 사용.
```

**카테고리 동적화** (M3 해결):
```typescript
// 현재: EDITOR_MAP, DEFAULT_ALLOCATION, TIME_SLOT_TEMPLATE → 4개 카테고리 하드코딩
// 변경: strategy_archive.strategy.categories[] 에서 동적 로드
// CEO가 새 카테고리 추가 → pending_approvals(type:'new_category') → 시훈 승인 → DB 반영
```

---

### S-5+6. Output Parser + Phase Gate + 회의 오케스트레이터 (통합)

#### 신규 모듈: agent-output-parser.ts (C2 해결)

```typescript
// src/orchestrator/agent-output-parser.ts

/** 에이전트 출력에서 태그를 파싱하고 DB에 저장 */
export async function processAgentOutput(agentId: string, output: string): Promise<ProcessResult> {
  // 1. 정규식으로 태그 파싱 (includes() 대신 — m4 해결)
  const memories = parseTag(output, /\[SAVE_MEMORY\]([\s\S]*?)\[\/SAVE_MEMORY\]/g);
  const episodes = parseTag(output, /\[LOG_EPISODE\]([\s\S]*?)\[\/LOG_EPISODE\]/g);
  const strategies = parseTag(output, /\[CREATE_STRATEGY_VERSION\]([\s\S]*?)\[\/CREATE_STRATEGY_VERSION\]/g);

  // 2. 태그 존재 확인
  if (memories.length === 0 && episodes.length === 0) {
    return { status: 'missing_tags', output };
  }

  // 3. 파싱된 데이터 DB 저장
  for (const mem of memories) await saveMemory({ agentId, ...parseMeta(mem) });
  for (const ep of episodes) await logEpisode({ agentId, ...parseMeta(ep) });
  for (const st of strategies) await createStrategyVersion({ ...parseMeta(st) });

  return { status: 'ok', savedCount: memories.length + episodes.length };
}

/** Phase Gate: 태그 없으면 재시도 */
export async function enforceTagGate(agentId: string, output: string, retryFn: () => Promise<string>): Promise<string> {
  let result = await processAgentOutput(agentId, output);

  if (result.status === 'missing_tags') {
    // 재시도 1회 — 구체적 피드백 포함
    const retry1 = await retryFn();
    result = await processAgentOutput(agentId, retry1);

    if (result.status === 'missing_tags') {
      // 재시도 2회
      const retry2 = await retryFn();
      result = await processAgentOutput(agentId, retry2);

      if (result.status === 'missing_tags') {
        // quarantine — DB에 기억 기록 안 함, 출력은 파이프라인에 전달
        await logEpisode({ agentId: 'system', eventType: 'error',
          summary: `${agentId} quarantined: 태그 미작성 3회`, details: {} });
        return retry2; // 출력은 반환하되 기억은 안 저장
      }
    }
    return retry1;
  }
  return output;
}
```

**이 모듈의 위치**: `/daily-run` 스킬에서 각 에이전트 스폰 후 출력을 이 파서에 전달.

#### 회의 오케스트레이터 (src/orchestrator/meeting.ts)

**핵심: 자유토론. 라운드 로빈 아님.**

```typescript
interface MeetingConfig {
  roomName: string;
  type: 'standup' | 'planning' | 'review' | 'emergency' | 'weekly' | 'free';
  agenda: string;
  participants: string[];
  createdBy: string;                  // 'system' | 'ceo' | 'team_lead' | 'user'
  consensusRequired: boolean;         // true: 합의 때까지, false: 정보 공유
  tokenBudget?: number;               // 안전장치 (기본 150K 토큰). 턴 수 제한 아님! (C1)
}
```

**종료 조건 (C1 해결 — maxTurns 삭제)**:

```
합의 필요 회의:
  1차: 합의 체크(매 5턴) → 합의 도달 → 종료
  2차: 합의 3회 연속 미달 → CEO가 최종 정리
  3차: tokenBudget 초과 → CEO 강제 정리 (안전장치)

  ※ "턴 수"가 종료 조건이 아니라 "합의 여부"가 종료 조건

정보 공유 회의:
  모든 참석자 1회+ 발언 → 자동 종료
```

**다음 발언자 선택 (규칙 기반 — 구현 실현성 검증 반영)**:

```typescript
function selectNextSpeaker(transcript: Message[], participants: string[]): string {
  // 1. @멘션된 에이전트 → 최우선
  const mentioned = extractMentions(transcript[transcript.length - 1]);
  if (mentioned.length > 0) return mentioned[0];

  // 2. 아직 발언 안 한 에이전트 → 우선
  const notSpoken = participants.filter(p => !transcript.some(t => t.agentId === p));
  if (notSpoken.length > 0) return notSpoken[0];

  // 3. 가장 오래 발언 안 한 에이전트
  // 4. 같은 에이전트 연속 3회 금지
  return leastRecentSpeaker(transcript, participants);
}
```

**회의 transcript sliding window** (토큰 관리):
- 최근 15턴은 전체 포함
- 15턴 이전은 요약본으로 압축 (매 15턴마다 자동 요약)
- 에이전트 스폰 시: 요약 + 최근 15턴 주입

**Devil's Advocate**: 매 10턴마다 랜덤 에이전트 1명에게 반론 임무. 주간 전략회의에서만 적용.

#### 회의 유형별 설정

| 회의 | 빈도 | 참석자 | 합의 필요 | tokenBudget |
|------|------|--------|----------|-------------|
| 아침 스탠드업 | 매일 | CEO + 팀장들 | O | 100K |
| 포스트 기획 | 매일 | 마케팅팀장 + 에디터 | O | 80K |
| 성과 리뷰 | 매일 | 분석팀장 + CEO | X (공유) | 50K |
| 주간 전략회의 | 주 1회 | 전체 | O | 200K |
| 긴급 회의 | 수시 | 관련자만 | O | 80K |
| 자유 토론 | 수시 | CEO/팀장이 소환 | X | 100K |

#### 회의방 권한

| 권한 | 시훈 | CEO | 팀장 | 일반 |
|------|-----|-----|------|------|
| 회의방 생성 | O | O | O | X |
| 에이전트 소환 | O | O | O(자기 부서) | X |
| 안건 제안 | O | O | O | O |
| 회의 종료 | O | O | X | X |

#### 시훈 ↔ CEO 캐스케이드 회의

```
시훈이 대시보드에서 CEO에게: "뷰티 비율 높여봐"
  → CEO가 안건 수신
  → 자동으로 하위 회의 생성: 참석자=마케팅팀장+분석팀장
  → 하위 회의 결과 → CEO가 시훈에게 텔레그램 보고
```

---

### S-7. daily-pipeline Phase 3 전환

```typescript
// Phase 3: runCEOStandup() → runMeeting({type:'standup'}) + meetingToDirective()

function meetingToDirective(ceoDecision: string, performanceData: any): DailyDirective {
  // 기존 ROI 계산 로직을 BASE로 사용
  // 회의 합의 내용으로 오버라이드 (카테고리 비율, 실험 등)
  // CEO에게 DailyDirective JSON 포맷 출력을 요구
}

// Phase Gate 호환: 회의에서 CEO 발언 시 channel='standup' → gatePhase3() 통과
```

**pipeline_run 기록** (M7):
```typescript
// daily-pipeline.ts 끝에 추가
await logEpisode({
  agentId: 'system',
  eventType: 'pipeline_run',
  summary: `Phase ${completed}/${total} 완료, gate_failures: ${failures}`,
  details: { phases_completed, gate_failures, errors, revenue_today }
});
```

---

### S-8. 전략 아카이브 + 롤백 + CEO 메타인지

**자율 변경 (시훈 승인 없이)**:
- 카테고리 비율 조정 (메인 70%, 실험 30%)
- 시간대 변경, 포맷/훅 변경
- 새 실험 설계

**승인 필요 (pending_approvals)**:
- ops/*.md 문서 변경
- 새 에이전트 추가
- 새 카테고리 추가 (M3)
- Safety Gate 규칙 변경
- 코드 변경
- 비용 발생

**롤백 시스템** (M7 반영):

트리거:
1. `agent_episodes`에서 `event_type='pipeline_run'` 최근 3건 중 `gate_failures >= 2`가 2건 이상
2. 시훈(오너)의 명시적 요청

절차 (scripts/rollback-strategy.ts):
1. 이전 성공 버전을 `status='active'`로 승격
2. 현재를 `status='deprecated'`
3. pending_approvals에 롤백 이벤트 기록
4. 텔레그램으로 시훈에게 알림

---

### S-8.5. 팀장 에이전트 추가

- **지현 (마케팅팀장)**: `.claude/agents/jihyun-marketing-lead.md` 신규 생성
- **서연 (분석팀장)**: 기존 `seoyeon-analyst.md`에 `is_team_lead: true` + 팀장 권한 추가
- agents DB에 INSERT + AGENT_REGISTRY 업데이트

---

### S-11. E2E 백엔드 검증 (대시보드 전)

검증 항목:
1. **기억 재현**: 2회 분리된 세션에서 cross-session 기억 재현 확인
2. **CEO 회의**: 회의 소집 → 자유토론 → 반박 → 합의 확인
3. **전략 롤백**: rollback 시나리오 1회 실행
4. **daily-pipeline**: Phase 1~6 + Safety Gate 8개 통과
5. **톤 검증**: tone-validator.ts → 위반 0건
6. **성격 일관성**: 에이전트 출력이 성격 설정과 일치하는지 샘플 검증

---

### S-9. 대시보드 기본 레이아웃

**S-11 완료 후 진행.**

```
┌──────────────────────────────────────────────────┐
│ 사이드바              │  메인 영역                │
│                       │                          │
│ [에이전트 레지스트리]  │  회의방 채팅 UI           │
│  ● CEO 민준           │  ─────────────────       │
│  ● 팀장 지현          │  발언 + @소환             │
│  ○ 분석 서연          │                          │
│                       │                          │
│ [회의방 목록]          │                          │
│  # 스탠드업-0324      ├──────────────────────────│
│  + 새 회의방          │  조직도 / 성과 / 수익     │
│                       ├──────────────────────────│
│ [승인 대기]           │  pending_approvals UI     │
│  ⚠ 2건 대기          │  승인/거부 버튼 (m5)     │
└──────────────────────────────────────────────────┘
```

---

### S-10. 회의방 채팅 UI + Realtime

- Supabase Realtime (Postgres Changes) — agent_messages INSERT 감지
- Supabase 프로젝트에서 agent_messages Replication 활성화 필요
- @멘션 드롭다운 (agents DB에서 동적 로드)
- 부서 단위 소환 ("마케팅부 전원 소집")
- 시훈 ↔ CEO 대화 입력창

---

### S-12. 최종 수용 검증

S-9/S-10 완료 후. 5개 기준 통합 검증:
1. 에이전트가 이전 세션의 결정/성과를 기억하고 언급함
2. CEO가 회의를 소집하고 에이전트들이 자유토론 (반박 포함)
3. 대시보드에서 회의 대화를 실시간으로 볼 수 있음
4. 전략 변경 시 아카이브 버전 생성 + 실패 시 롤백 가능
5. 기존 daily-pipeline 정상 동작

---

### S-13. 텔레그램 보고 시스템

**일일 보고** (daily-run 완료 후):
```
[BiniLab 일일 보고]
게시: 10개 (뷰티7, 건강2, 생활1)
어제 성과: 평균 8,200뷰, 참여율 3.1%
  최고: "이 선크림 진짜..." (14,200뷰)
수익: 클릭 127건, 전환 3건, ₩45,000
  목표 대비: 월 ₩312,000 / ₩500,000 (62%)
회의 요약: 뷰티 비율 70% 유지, 선크림 시즌 강화
내일 계획: 뷰티 7 + 건강 2 + 실험 1
```

**주간 보고** (weekly-retro 완료 후):
```
[BiniLab 주간 보고]
성과: 68포스트, 평균 7,800뷰
성장: 전주 대비 +12%
수익: ₩312,000 (목표 ₩500,000의 62%)
실험: 숫자형 훅 > 질문형 (14% 차이)
전략 변경: 뷰티 65→70%, 다이어트 15→10%
승인 대기: 0건
```

**긴급 알림** (즉시):
- Safety Gate 2개+ 실패
- CEO 승인 요청
- 계정 제한/밴
- 전략 롤백

---

## 계정 확장 메커니즘

```
계정 1개 (현재): 기본 조직 11명
계정 3개: 마케팅 1~3부 (에디터 팀 분리), 분석부 공유
계정 10개: 마케팅 1~10부, 분석 1~2부, QA 1~2부
```

**새 에이전트 추가**: CEO → pending_approvals → 시훈 승인 → agents INSERT → .claude/agents/*.md 생성 → 대시보드 자동 반영

---

## 시훈의 하루 (end-to-end 시나리오)

```
08:00  시훈이 Claude Code에서 /daily-run 실행
       ↓
08:01  Phase 1: 준호(트렌드헌터)가 24h 데이터 수집
08:05  Phase 2: 서연(분석팀장)이 성과 분석
08:10  Phase 3: 아침 스탠드업 회의 (자유토론)
         민준(CEO) + 지현(마케팅팀장) + 서연(분석팀장)
         → 오늘 전략 합의 → DailyDirective 생성
08:25  Phase 4: 에디터들이 포스트 작성 (각 카테고리)
08:40  Phase 5: 도윤(QA) + Safety Gate 검증
08:45  Phase 6: 게시 준비 완료 → aff_contents ready
       ↓
08:50  텔레그램으로 일일 보고 수신
       ↓
낮     시훈은 일상 업무. 에이전트들은 기억에 기록 완료.
       ↓
저녁   승인 요청이 있으면 텔레그램으로 알림 → 대시보드에서 승인/거부
       ↓
주 1회  주간 전략회의 → 주간 보고 → 전략 자동 조정
```

---

## 리스크

| ID | 심각도 | 설명 | 완화 |
|----|--------|------|------|
| R-1 | HIGH | 에이전트가 태그 안 씀 | Output Parser + 2회 재시도 + quarantine |
| R-2 | MED | 토론이 무한 반복 | tokenBudget 안전장치 (턴 수 아님) |
| R-3 | HIGH | 파일/DB 학습 이중화 | S-1.5 마이그레이션 |
| R-4 | MED | 대시보드 > 핵심 가치 | S-11 백엔드 검증 선행 |
| R-5 | HIGH | ops 무단 수정 | pending_approvals + 시훈 승인 |
| R-6 | MED | 수익 목표 없이 최적화 방향 상실 | KPI 마일스톤 + CEO 매일 수익 리뷰 |

---

## 구현 순서

```
S-1   → DB 스키마 (테이블 6개 + ALTER 1개 + Drizzle 정의 + 초기 시딩)
S-1.5 → 파일→DB 마이그레이션 (+ strategy-logger.ts 래퍼 전환)
S-2   → 메모리 헬퍼 (loadAgentContext + saveMemory + formatMemoryForPrompt)
S-3   → COMPANY.md (인덱스 + 수익 목표 + 채널 스코프 + 태그 + 톤 + 성격)
S-3.5 → 에이전트 캐릭터 설정 (11명 성격 + 마케팅팀장 신규 + 역할명 변경)
S-4   → agent-spawner.ts (async 전환 + COMPANY.md + 기억 주입 + 카테고리 동적화)
S-5+6 → Output Parser + Phase Gate + 회의 오케스트레이터 (자유토론, 합의 기반 종료)
S-7   → daily-pipeline Phase 3 전환 (+ pipeline_run 에피소드 기록)
S-8   → 전략 아카이브 + 롤백 + CEO 메타인지 + pending_approvals
S-8.5 → 팀장 에이전트 추가 (지현 + 서연 승격)
S-11  → E2E 백엔드 검증 (기억/회의/롤백/파이프라인/톤/성격)
S-9   → 대시보드 기본 레이아웃 + 승인 UI
S-10  → 회의방 채팅 UI + Realtime + @소환
S-12  → 최종 수용 검증
S-13  → 텔레그램 보고 (일일/주간/긴급)
```

## 검증 이력

| 검증 | 결과 | 주요 발견 |
|------|------|----------|
| Opus × Codex 토론 (4R) | 9/10, 16/16 해결 | 랭킹 공식, quarantine, 롤백 절차 추가 |
| 코드 감사관 | S-5+6 비호환 1건 | output parser 모듈 부재 → 추가 |
| 요구사항 검증관 | CRITICAL 1 + MAJOR 4 | maxTurns 변형, 수익 목표 누락, 역할명 일반 |
| 구현 실현성 검증관 | 불가 0건, 조건부 4건 | pipeline_runs 누락 → episodes 통합 |
