# 멀티에이전트 소통 시스템 리서치
*작성일: 2026-03-23 | 작성자: Scientist (S-4 태스크)*

---

## 1. Executive Summary

멀티에이전트 AI 프레임워크는 4개의 주요 패러다임으로 수렴 중이다: CrewAI의 **역할 기반 팀** 모델, AutoGen의 **이벤트 드리븐 액터** 모델, MetaGPT의 **SOP 기반 조립라인** 모델, ChatDev의 **역할 세미나 체인** 모델. BiniLab(Claude Code + Supabase 환경)에 가장 적합한 패턴은 **MetaGPT의 Pub/Sub 환경 패턴** + **AutoGen의 비동기 메시지 패싱**을 `agent_messages` DB 테이블로 구현하는 하이브리드 접근이다. 회의 자동화는 ChatDev의 "기능별 세미나" 개념을 가져와 cron 기반 standup/weekly 루틴으로 구현 가능하다.

---

## 2. 프레임워크 비교표

| 항목 | CrewAI | AutoGen v0.4 | MetaGPT | ChatDev |
|------|--------|-------------|---------|---------|
| **GitHub ★** | ~35k+ | ~40k+ | 65k+ | 31k+ |
| **핵심 모델** | 역할 기반 팀 | 이벤트 드리븐 액터 | SOP 조립라인 | 채팅 체인 세미나 |
| **통신 방식** | 직접 위임/Sequential | 비동기 메시지 패싱 | Pub/Sub (환경) | 턴-테이킹 대화쌍 |
| **메시지 포맷** | 자연어 Task 결과 | 타입드 이벤트 | 구조화된 문서 (SOP) | 자연어 채팅 |
| **역할 라우팅** | 계층적 Manager → Agent | 구독 기반 자동 라우팅 | Watch 리스트 구독 | 세미나 구조 고정 |
| **메모리 공유** | 단기/장기 메모리 레이어 | 분산 에이전트 상태 | 공유 환경(Environment) | 컨텍스트 윈도우 |
| **회의 시스템** | GroupChat (라운드로빈) | SelectorGroupChat | 없음 (선형 워크플로) | Functional Seminar |
| **비동기 지원** | 제한적 (v0.2) / 개선중 | 완전 지원 (v0.4 핵심) | 부분적 | 없음 (동기식) |
| **DB 통합** | 없음 (메모리) | 없음 (메모리) | 없음 (메모리) | 없음 (메모리) |
| **Claude 호환** | O (API 통해) | O (API 통해) | O (API 통해) | O (API 통해) |
| **Claude Code 호환** | X (Python SDK 필요) | X (Python SDK 필요) | X (Python SDK 필요) | X (Python SDK 필요) |
| **운영 환경** | 주로 단일 세션 | 분산 가능 | 단일 세션 | 단일 세션 |
| **학습 난이도** | 쉬움 | 중간~어려움 | 중간 | 쉬움 |
| **프로덕션 성숙도** | 중간 | 높음 | 중간 | 낮음 |

---

## 3. 프레임워크 상세 분석

### 3.1 CrewAI — 역할 기반 팀 오케스트레이션

**아키텍처 패턴**

CrewAI는 "팀을 구성한다"는 직관적 모델을 채택한다. 에이전트는 `role`, `goal`, `backstory`로 정의되고, Task는 에이전트에게 할당된다. 두 가지 실행 모드가 있다:

- **Crews 모드**: 에이전트가 자율적으로 위임/질문/접근방식 결정. 진짜 에이전시.
- **Flows 모드**: 이벤트 드리븐 파이프라인. 프로덕션 워크플로 용.

**통신 방식**

```
Task A (Agent 1) → 결과 → Task B (Agent 2) → 결과 → Task C (Agent 3)
```

- 직접적이고 순차적인 Task 결과 전달
- 계층적 관리자: Manager Agent가 Worker Agent에게 위임
- 메시지는 자연어로 Task 결과 형태
- 에이전트 간 직접 채팅보다 Task 결과 체인이 주요 메커니즘

**메모리/컨텍스트**

- Short-term: 현재 Task 컨텍스트
- Long-term: Embedding 기반 영속적 메모리
- Entity Memory: 특정 엔티티(사람, 조직) 정보 추적
- Contextual: 최근 상호작용 압축

**강점**

- 가장 직관적인 API. 팀을 구성하는 자연스러운 메타포
- 빠른 프로토타이핑 (YAML/Python으로 5분 안에 동작)
- 역할 기반 사고방식 → BiniLab의 "CEO/에디터/QA" 구조와 잘 매핑

**약점**

- 계층적 Manager는 이론적으로 좋지만 실제 프로덕션에서 불안정
- 비동기 지원 제한적 (v0.2 수준)
- DB 네이티브 통합 없음
- Claude Code 직접 실행 불가 (Python SDK 필요)

---

### 3.2 AutoGen v0.4 — 이벤트 드리븐 액터 모델

**아키텍처 패턴**

v0.4에서 완전 재설계. 핵심 설계 원칙: **비동기 이벤트 드리븐 액터 모델**.

3개 레이어 아키텍처:
- **Core**: 저수준 이벤트 파이프라인 및 스케일링
- **AgentChat**: 빠른 멀티에이전트 앱용 고수준 API
- **Extensions**: 모델/도구 통합

**통신 방식**

```
Agent A → [타입드 이벤트 발행] → 메시지 라우터 → [구독 에이전트] → Agent B, C
```

- 에이전트는 타입드 메시지를 발행하고 구독
- ConversableAgent: 모든 에이전트가 메시지 송수신 가능
- GroupChat: 다중 에이전트 그룹 대화 (SelectorGroupChat으로 스마트 라우팅)
- 완전 비동기 (async/await 네이티브)

**메시지 포맷**

```python
# AutoGen v0.4 메시지 구조
{
  "source": "agent_name",
  "content": "메시지 내용",
  "type": "TextMessage" | "ToolCallResultMessage" | ...
}
```

**메모리/컨텍스트**

- 에이전트별 독립 상태 관리
- OpenTelemetry 기반 완전 관찰성 (추적/디버깅)
- 직렬화/역직렬화 지원 (상태 영속성)

**강점**

- 완전 비동기 = 병렬 에이전트 실행 가능
- 가장 강력한 프로덕션 확장성
- Microsoft 지원, 강력한 관찰성
- 크로스 언어 지원 (Python + .NET)

**약점**

- 학습 곡선 높음 (두 레이어 API 이해 필요)
- 순수 대화 기반 → 구조화된 워크플로에는 보일러플레이트 많음
- Claude Code 직접 실행 불가

---

### 3.3 MetaGPT — SOP 기반 조립라인

**아키텍처 패턴**

"인간 소프트웨어 팀의 SOP를 LLM에게 인코딩"이라는 개념. 핵심 논문(ICLR 2024 구두 발표, Top 1.8%)에서 검증됨.

**통신 방식 — Pub/Sub Environment**

```
Agent A (PM) → [publish: PRD 문서] → Environment (공유 환경)
                                          ↓ (watch 목록 체크)
                                      Agent B (Architect) 수신
Agent B (Architect) → [publish: 시스템 설계] → Environment
                                          ↓
                                      Agent C (Engineer) 수신
```

- **Environment**: 공유 메시지 공간. 에이전트가 여기에 메시지 발행
- **Watch 리스트**: 각 에이전트가 관심 있는 메시지 타입을 구독
- 에이전트는 watch 목록에 있는 새 메시지에만 반응 (React-style 동작)
- 메시지 = 구조화된 문서 (PRD, 시스템 설계서, 코드 등)

**SOP 패턴**

```
Product Manager → PRD 작성
Architect → 시스템 설계 (PRD 읽음)
Engineer → 코드 작성 (설계 읽음)
QA → 테스트 (코드 읽음)
```

각 역할이 정해진 순서로 결과물을 생산 → 다음 역할이 소비

**메모리/컨텍스트**

- 공유 Environment가 실질적인 공유 메모리 역할
- 각 에이전트의 메시지가 Environment에 축적
- 에이전트별 롤 프롬프트 + 해당 단계 컨텍스트

**강점**

- Pub/Sub 패턴이 DB 테이블로 직접 구현 가능 (BiniLab 적합)
- 구조화된 문서 출력 → 품질 일관성
- 역할별 전문화로 캐스케이딩 환각 최소화
- 65k+ 스타, 강한 학술 기반

**약점**

- 소프트웨어 개발에 최적화 → 마케팅 워크플로에 직접 적용 어려움
- 유연성 낮음 (선형 워크플로)
- 실시간 협업보다 순차적 처리

---

### 3.4 ChatDev — 역할 세미나 체인

**아키텍처 패턴**

ChatDev는 가상 소프트웨어 회사 시뮬레이션으로 시작. 핵심 혁신 두 가지:
1. **Chat Chain**: 역할 쌍(pair) 간 구조화된 대화 시퀀스
2. **Communicative Dehallucination**: 에이전트가 불분명한 내용에 대해 명시적 확인 요청

**통신 방식 — Chat Chain + Seminar**

```
[설계 세미나]
CEO ↔ CTO (N턴 대화) → 설계 문서 합의

[코딩 세미나]
CTO ↔ Programmer (N턴 대화) → 코드 생성

[테스트 세미나]
Programmer ↔ Tester (N턴 대화) → 버그 수정
```

- 단방향 메시지가 아닌 **역할 쌍 간 대화** (토론 시스템)
- 각 세미나는 특정 목표를 가진 구조화된 대화
- 에이전트가 먼저 자신의 역할 확인 후 상대방 발언에 반응
- ChatDev 2.0: 코드 생성 넘어 범용 멀티에이전트 플랫폼으로 진화

**Communicative Dehallucination**

```
Programmer: "이 API를 어떻게 구현할까요?"
CTO: "REST API로, POST /api/v1/users 엔드포인트, 인증은 JWT"
← 모호함이 있을 때 에이전트가 명시적 질문을 던짐
```

**강점**

- 토론/검토 시스템의 학술적 기반 (BiniLab 토론 시스템과 유사)
- 역할 세미나 개념 → 스탠드업/위클리 회의 자동화에 직접 적용 가능
- 자연어 통신으로 이해하기 쉬움

**약점**

- 완전 동기식 (비동기 없음)
- 고정된 역할/워크플로 구조 (v1.0 기준)
- 소프트웨어 개발 특화 → 범용 적용 어려움 (v2.0에서 개선 중)
- 프로덕션 성숙도 낮음

---

## 4. BiniLab 추천 아키텍처

### 4.1 현황 분석

BiniLab은 이미 다음을 보유:
- `agent_messages` DB 테이블 (비동기 통신 기반)
- `/team` 스킬 (병렬 에이전트 실행)
- 토론 시스템 (`post-debate-system.md`)
- 9개 역할 정의 (CEO, 에디터 4명, QA, 애널리스트, 리서처, 엔지니어)
- Claude Code 기반 실행 (외부 Python SDK 없음)

**핵심 제약**: 모든 프레임워크가 Python SDK 기반 → Claude Code에서 직접 사용 불가.
**핵심 기회**: `agent_messages` DB = 영속적 비동기 메시지 버스 → MetaGPT Pub/Sub + AutoGen 비동기의 핵심을 DB로 구현 가능.

### 4.2 하이브리드 아키텍처 추천

**"BiniLab Communication Protocol v1"**

```
┌─────────────────────────────────────────────────┐
│              agent_messages 테이블               │
│                                                  │
│  id | from_agent | to_agent | type | content     │
│     | CEO        | *        | BRIEF| {...}       │  ← 브로드캐스트
│     | 에디터1    | QA       | REVIEW_REQ | {...} │  ← 직접 메시지
│     | QA         | CEO      | APPROVED | {...}   │  ← 승인 응답
└─────────────────────────────────────────────────┘
         ↑                        ↓
    에이전트 발행              에이전트 구독
  (INSERT 메시지)          (SELECT WHERE to=me)
```

**영감 출처**:
- MetaGPT의 Pub/Sub → `to_agent='*'` 브로드캐스트 + 특정 에이전트 직접 메시지
- AutoGen의 타입드 이벤트 → `type` 컬럼으로 메시지 분류/라우팅
- ChatDev의 세미나 → 스탠드업/위클리를 구조화된 멀티턴 대화로 구현
- CrewAI의 역할 정의 → `agency.md`의 9개 에이전트 역할 체계

### 4.3 메시지 타입 체계

```sql
-- agent_messages 확장 제안
type ENUM:
  'STANDUP_REQUEST'    -- CEO → * (매일 오전)
  'STANDUP_REPORT'     -- 각 에이전트 → CEO (작업 현황)
  'TASK_ASSIGN'        -- CEO/오케스트레이터 → 특정 에이전트
  'TASK_COMPLETE'      -- 에이전트 → CEO (완료 보고)
  'REVIEW_REQUEST'     -- 에디터 → QA
  'REVIEW_RESPONSE'    -- QA → 에디터 (승인/거절)
  'DEBATE_START'       -- 가이드 에이전트 → 빈이 에이전트
  'DEBATE_ROUND'       -- 에이전트 간 토론 턴
  'WEEKLY_RETRO'       -- CEO → * (주간 회고)
  'ALERT'              -- 에이전트 → CEO (이슈 에스컬레이션)
```

### 4.4 회의 자동화 설계

**일일 스탠드업** (ChatDev 세미나 패턴 적용)

```
[트리거] cron: 매일 09:00
[CEO] STANDUP_REQUEST 발행 → agent_messages (to='*')

[각 에이전트] SELECT 미처리 STANDUP_REQUEST 확인
  → 작업 현황 요약 작성
  → STANDUP_REPORT 발행 → agent_messages (to='CEO')

[CEO] 모든 STANDUP_REPORT 집계
  → 우선순위 결정
  → TASK_ASSIGN 메시지 발행
```

**주간 회고** (MetaGPT SOP 패턴 적용)

```
[트리거] cron: 매주 금요일 17:00
[CEO] WEEKLY_RETRO 발행 → 전체 주간 성과 데이터 포함

[애널리스트] 성과 데이터 분석 → 인사이트 발행
[리서처] 트렌드 변화 요약 → 발행
[CEO] 종합 → 다음 주 전략 결정 → agency.md 업데이트
```

### 4.5 /team 스킬 통합

현재 `/team` 스킬이 병렬 실행을 지원하므로:

```
/team 스탠드업 →
  [병렬] 에디터1 현황보고 + 에디터2 현황보고 + QA 현황보고
  [수렴] CEO가 모든 보고서 집계
```

이는 AutoGen의 ConcurrentGroupChat 패턴을 `/team` 스킬로 구현한 것.

---

## 5. Phase 2 구현 로드맵

### 우선순위 1 (즉시): agent_messages 기반 소통 강화

**S-3에서 구현 중인 `agent_messages` 테이블**을 다음으로 확장:

```sql
-- 추가 컬럼 제안
ALTER TABLE agent_messages ADD COLUMN
  message_type VARCHAR(50) DEFAULT 'general',
  parent_message_id UUID REFERENCES agent_messages(id),
  expires_at TIMESTAMP,
  is_processed BOOLEAN DEFAULT FALSE,
  metadata JSONB;
```

- `parent_message_id`: 스레드 형태 대화 추적 (ChatDev 세미나 체인)
- `is_processed`: 에이전트가 읽고 처리했는지 추적 (MetaGPT watch 패턴)
- `expires_at`: 회의 요청 만료 처리

**구현 난이도**: 낮음 | **BiniLab 임팩트**: 높음

---

### 우선순위 2 (1주): 일일 스탠드업 자동화

**파일**: `scripts/run-standup.ts`

```typescript
// 스탠드업 실행 흐름
async function runStandup() {
  // 1. 어제 성과 집계 (DB 쿼리)
  const yesterday = await getYesterdayMetrics();

  // 2. CEO가 STANDUP_REQUEST 발행
  await publishMessage('CEO', '*', 'STANDUP_REQUEST', {
    date: today,
    metrics: yesterday,
    focus: getDailyFocus()
  });

  // 3. /team 스킬로 병렬 현황보고 요청 (Claude Code 직접 실행)
  // 각 에이전트가 ops.md의 standup 절차 따름

  // 4. CEO가 집계 → 오늘 기획 우선순위 결정
}
```

**구현 난이도**: 중간 | **BiniLab 임팩트**: 매우 높음

---

### 우선순위 3 (2주): 에이전트 간 토론 메시지 로깅

현재 토론 시스템이 메모리에서만 동작 → DB에 영속화:

```
post-debate-system →
  토론 시작: DEBATE_START 메시지 발행
  각 라운드: DEBATE_ROUND 메시지 기록
  최종 결과: 토론 결론 + 승인자 기록
```

**Why**: 토론 기록이 DB에 있으면 성과 분석 시 "어떤 토론 결과가 좋은 포스트를 만들었나" 추적 가능

**구현 난이도**: 낮음 | **BiniLab 임팩트**: 중간

---

### 우선순위 4 (3주): 주간 회고 자동화

**파일**: `scripts/run-weekly-retro.ts`

```typescript
async function runWeeklyRetro() {
  // 1. 주간 성과 집계
  const weeklyMetrics = await getWeeklyMetrics();

  // 2. 애널리스트 에이전트 호출 → 인사이트 생성
  // 3. 리서처 에이전트 호출 → 트렌드 변화 요약
  // 4. CEO가 종합 → agency.md / soul.md 업데이트 제안
  // 5. WEEKLY_RETRO 메시지로 결과 발행
}
```

**구현 난이도**: 중간 | **BiniLab 임팩트**: 높음 (자가개선 루프 핵심)

---

### 우선순위 5 (4주): 에이전트 상태 대시보드

`agent_messages` 데이터를 기반으로:
- 각 에이전트의 처리 속도/부하 모니터링
- 병목 에이전트 식별
- 메시지 전달 지연 추적

**구현 난이도**: 중간 | **BiniLab 임팩트**: 낮음 (운영 가시성)

---

## 6. 핵심 결론

### "BiniLab은 이미 핵심을 보유하고 있다"

4개 프레임워크를 분석한 결과, BiniLab의 현재 설계는 이미 올바른 방향에 있다:

| 프레임워크 개념 | BiniLab 현재 구현 | 갭 |
|----------------|------------------|-----|
| MetaGPT Pub/Sub | `agent_messages` 테이블 | 메시지 타입 체계 미완성 |
| AutoGen 비동기 | `/team` 병렬 실행 | DB 폴링 기반 비동기 미구현 |
| ChatDev 세미나 | 토론 시스템 | DB 로깅 없음, 회의 자동화 없음 |
| CrewAI 역할 | 9개 에이전트 정의 | soul.md/ops.md 분리 진행 중 |

### 외부 프레임워크 도입 권장하지 않음

모든 프레임워크가 Python SDK 기반이므로 Claude Code 환경에서 직접 실행 불가. 오히려 **각 프레임워크의 핵심 패턴만 추출**해 Claude Code + Supabase 환경에 맞게 재구현하는 것이 최적:

- MetaGPT의 Pub/Sub → `agent_messages` 테이블
- AutoGen의 타입드 이벤트 → `message_type` 컬럼
- ChatDev의 세미나 → cron 기반 standup/retro 스크립트
- CrewAI의 역할 위임 → CEO ops.md의 태스크 배분 로직

---

*리서치 방법: Exa 웹검색 (8회), GitHub 직접 분석, arXiv 논문 (MetaGPT ICLR 2024, ChatDev ACL 2024)*
*참고 자료: CrewAI DigitalOcean 공식 튜토리얼, AutoGen MS Research 블로그, MetaGPT arXiv 원본, ChatDev GitHub*
