# 아키텍처

> oh-my-claudecode가 멀티 에이전트 워크플로우를 오케스트레이션하는 방법.

## 개요

oh-my-claudecode는 스킬 기반 라우팅 시스템을 통해 Claude Code가 전문 에이전트를 오케스트레이션할 수 있도록 합니다. 네 가지 상호 연결된 시스템으로 구성됩니다: **Hooks**는 라이프사이클 이벤트를 감지하고, **Skills**는 동작을 주입하며, **Agents**는 전문 작업을 실행하고, **State**는 컨텍스트 초기화 이후에도 진행 상황을 추적합니다.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OH-MY-CLAUDECODE                                 │
│                     Intelligent Skill Activation                         │
└─────────────────────────────────────────────────────────────────────────┘

  User Input                      Skill Detection                 Execution
  ──────────                      ───────────────                 ─────────
       │                                │                              │
       ▼                                ▼                              ▼
┌─────────────┐              ┌──────────────────┐           ┌─────────────────┐
│  "ultrawork │              │   CLAUDE.md      │           │ SKILL ACTIVATED │
│   refactor  │─────────────▶│   Auto-Routing   │──────────▶│                 │
│   the API"  │              │                  │           │ ultrawork +     │
└─────────────┘              │ Task Type:       │           │ default +       │
                             │  - Implementation│           │ git-master      │
                             │  - Multi-file    │           │                 │
                             │  - Parallel OK   │           │ ┌─────────────┐ │
                             │                  │           │ │ Parallel    │ │
                             │ Skills:          │           │ │ agents      │ │
                             │  - ultrawork ✓   │           │ │ launched    │ │
                             │  - default ✓     │           │ └─────────────┘ │
                             │  - git-master ✓  │           │                 │
                             └──────────────────┘           │ ┌─────────────┐ │
                                                            │ │ Atomic      │ │
                                                            │ │ commits     │ │
                                                            │ └─────────────┘ │
                                                            └─────────────────┘
```

네 가지 시스템은 다음 순서로 동작합니다:

```
사용자 입력 --> Hooks (이벤트 감지) --> Skills (동작 주입)
           --> Agents (작업 실행) --> State (진행 상황 추적)
```

---

## 에이전트 시스템

### 개요

OMC는 4개의 레인으로 구성된 19개의 전문 에이전트를 제공합니다. 각 에이전트는 `oh-my-claudecode:<에이전트명>` 형태로 호출되며, 적절한 모델 티어에서 실행됩니다.

### 빌드/분석 레인

탐색부터 검증까지 전체 개발 라이프사이클을 담당합니다.

| 에이전트 | 기본 모델 | 역할 |
|---------|-----------|------|
| `explore` | haiku | 코드베이스 탐색, 파일/심볼 매핑 |
| `analyst` | opus | 요구사항 분석, 숨겨진 제약 조건 발견 |
| `planner` | opus | 작업 순서 정렬, 실행 계획 수립 |
| `architect` | opus | 시스템 설계, 인터페이스 정의, 트레이드오프 분석 |
| `debugger` | sonnet | 근본 원인 분석, 빌드 오류 해결 |
| `executor` | sonnet | 코드 구현, 리팩토링 |
| `verifier` | sonnet | 완료 검증, 테스트 충분성 확인 |
| `tracer` | sonnet | 증거 기반 인과 추적, 경쟁 가설 분석 |

### 리뷰 레인

인계 전 품질 게이트. 정확성 및 보안 문제를 파악합니다.

| 에이전트 | 기본 모델 | 역할 |
|---------|-----------|------|
| `security-reviewer` | sonnet | 보안 취약점, 신뢰 경계, 인증/인가 검토 |
| `code-reviewer` | opus | 포괄적인 코드 리뷰, API 계약, 하위 호환성 |

### 도메인 레인

필요 시 호출되는 도메인 전문가입니다.

| 에이전트 | 기본 모델 | 역할 |
|---------|-----------|------|
| `test-engineer` | sonnet | 테스트 전략, 커버리지, 불안정 테스트 강화 |
| `designer` | sonnet | UI/UX 아키텍처, 인터랙션 설계 |
| `writer` | haiku | 문서 작성, 마이그레이션 노트 |
| `qa-tester` | sonnet | tmux를 통한 대화형 CLI/서비스 런타임 검증 |
| `scientist` | sonnet | 데이터 분석, 통계 연구 |
| `git-master` | sonnet | Git 작업, 커밋, 리베이스, 히스토리 관리 |
| `document-specialist` | sonnet | 외부 문서, API/SDK 레퍼런스 조회 |
| `code-simplifier` | opus | 코드 명확성, 단순화, 유지보수성 개선 |

### 조율 레인

다른 에이전트가 만든 계획과 설계에 이의를 제기합니다. 더 이상 개선점을 찾을 수 없을 때 계획이 통과됩니다.

| 에이전트 | 기본 모델 | 역할 |
|---------|-----------|------|
| `critic` | opus | 계획 및 설계의 갭 분석, 다각도 검토 |

### 모델 라우팅

OMC는 세 가지 모델 티어를 사용합니다:

| 티어 | 모델 | 특성 | 비용 |
|------|------|------|------|
| LOW | haiku | 빠르고 저렴함 | 낮음 |
| MEDIUM | sonnet | 균형 잡힌 성능과 비용 | 중간 |
| HIGH | opus | 최고 품질의 추론 | 높음 |

역할별 기본 할당:
- **haiku**: 빠른 조회 및 단순 작업 (`explore`, `writer`)
- **sonnet**: 코드 구현, 디버깅, 테스트 (`executor`, `debugger`, `test-engineer`)
- **opus**: 아키텍처, 전략 분석, 리뷰 (`architect`, `planner`, `critic`, `code-reviewer`)

### 위임

작업은 지능적인 모델 라우팅을 통해 Task 도구로 위임됩니다:

```typescript
Task(
  subagent_type="oh-my-claudecode:executor",
  model="sonnet",
  prompt="기능 구현..."
)
```

**에이전트에 위임할 때:**
- 여러 파일을 변경해야 할 때
- 리팩토링이 필요할 때
- 디버깅 또는 근본 원인 분석이 필요할 때
- 코드 리뷰 또는 보안 리뷰가 필요할 때
- 계획 수립 또는 연구가 필요할 때

**직접 처리할 때:**
- 단순 파일 조회
- 간단한 질문 답변
- 단일 명령 작업

### 에이전트 선택 가이드

| 작업 유형 | 권장 에이전트 | 모델 |
|----------|-------------|------|
| 빠른 코드 조회 | `explore` | haiku |
| 기능 구현 | `executor` | sonnet |
| 복잡한 리팩토링 | `executor` (model=opus) | opus |
| 단순 버그 수정 | `debugger` | sonnet |
| 복잡한 디버깅 | `architect` | opus |
| UI 컴포넌트 | `designer` | sonnet |
| 문서 작성 | `writer` | haiku |
| 테스트 전략 | `test-engineer` | sonnet |
| 보안 리뷰 | `security-reviewer` | sonnet |
| 코드 리뷰 | `code-reviewer` | opus |
| 데이터 분석 | `scientist` | sonnet |

### 일반적인 에이전트 워크플로우

```
explore --> analyst --> planner --> critic --> executor --> verifier
(탐색)     (분석)      (순서정렬)  (검토)     (구현)       (확인)
```

### 에이전트 역할 경계

| 에이전트 | 수행 작업 | 비수행 작업 |
|---------|----------|-----------|
| `architect` | 코드 분석, 디버깅, 검증 | 요구사항 수집, 계획 수립 |
| `analyst` | 요구사항 갭 파악 | 코드 분석, 계획 수립 |
| `planner` | 작업 계획 수립 | 요구사항 분석, 계획 검토 |
| `critic` | 계획 품질 검토 | 요구사항 분석, 코드 분석 |

---

## 스킬 시스템

### 개요

스킬은 오케스트레이터의 동작 방식을 변경하는 **동작 주입(behavior injection)**입니다. 에이전트를 교체하는 대신, 기존 에이전트 위에 기능을 추가합니다. OMC는 총 28개의 스킬을 제공합니다.

### 스킬 레이어

스킬은 세 개의 레이어로 구성됩니다:

```
┌─────────────────────────────────────────────────────────────┐
│  보장 레이어 (선택사항)                                        │
│  ralph: "검증이 완료될 때까지 멈출 수 없음"                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  향상 레이어 (0-N개 스킬)                                      │
│  ultrawork (병렬) | git-master (커밋) | frontend-ui-ux        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  실행 레이어 (주요 스킬)                                        │
│  default (빌드) | orchestrate (조율) | planner (계획)          │
└─────────────────────────────────────────────────────────────┘
```

**공식:** `[실행 스킬] + [0-N개 향상] + [선택적 보장]`

예시:
```
작업: "ultrawork: API를 적절한 커밋으로 리팩토링"
활성 스킬: ultrawork + default + git-master
```

### 스킬 호출 방법

**슬래시 명령어:**
```bash
/oh-my-claudecode:autopilot todo 앱 만들어줘
/oh-my-claudecode:ralph auth 모듈 리팩토링
/oh-my-claudecode:team 3:executor "풀스택 앱 구현"
```

**매직 키워드** — 자연어에 키워드를 포함하면 스킬이 자동으로 활성화됩니다:
```bash
autopilot todo 앱 만들어줘      # autopilot 활성화
ralph: auth 모듈 리팩토링       # ralph 활성화
ultrawork OAuth 구현            # ultrawork 활성화
```

### 핵심 워크플로우 스킬

#### autopilot
아이디어부터 동작하는 코드까지 완전 자율 5단계 파이프라인.
- 트리거: `autopilot`, `build me`, `I want a`
```bash
autopilot build me a REST API with authentication
```

#### ralph
작업이 검증 완료될 때까지 멈추지 않는 반복 루프. `verifier` 에이전트가 루프 종료 전 완료를 확인합니다.
- 트리거: `ralph`, `don't stop`, `must complete`
```bash
ralph: refactor the authentication module
```

#### ultrawork
최대 병렬성 — 여러 에이전트를 동시에 실행합니다.
- 트리거: `ultrawork`, `ulw`
```bash
ultrawork implement user authentication with OAuth
```

#### team
5단계 파이프라인으로 N개의 Claude 에이전트를 조율합니다: `plan → prd → exec → verify → fix`
```bash
/oh-my-claudecode:team 3:executor "implement fullstack todo app"
```

#### ccg (Claude-Codex-Gemini)
Codex와 Gemini에 동시에 팬아웃하고, Claude가 결과를 종합합니다.
- 트리거: `ccg`, `claude-codex-gemini`
```bash
ccg: review this authentication implementation
```

#### ralplan
반복적 계획 수립: Planner, Architect, Critic이 합의에 도달할 때까지 반복합니다.
- 트리거: `ralplan`
```bash
ralplan this feature
```

### 유틸리티 스킬

| 스킬 | 설명 | 명령어 |
|------|------|--------|
| `cancel` | 활성 실행 모드 취소 | `/oh-my-claudecode:cancel` |
| `hud` | 상태 표시줄 설정 | `/oh-my-claudecode:hud` |
| `omc-setup` | 초기 설정 마법사 | `/oh-my-claudecode:omc-setup` |
| `omc-doctor` | 설치 진단 | `/oh-my-claudecode:omc-doctor` |
| `learner` | 세션에서 재사용 가능한 스킬 추출 | `/oh-my-claudecode:learner` |
| `skill` | 로컬 스킬 관리 (목록/추가/제거) | `/oh-my-claudecode:skill` |
| `trace` | 증거 기반 인과 추적 | `/oh-my-claudecode:trace` |
| `release` | 자동화된 릴리즈 워크플로우 | `/oh-my-claudecode:release` |
| `deepinit` | 계층적 AGENTS.md 생성 | `/oh-my-claudecode:deepinit` |
| `deep-interview` | 소크라테스식 심층 인터뷰 | `/oh-my-claudecode:deep-interview` |
| `sciomc` | 병렬 과학자 에이전트 오케스트레이션 | `/oh-my-claudecode:sciomc` |
| `external-context` | 병렬 document-specialist 연구 | `/oh-my-claudecode:external-context` |
| `ai-slop-cleaner` | AI 표현 패턴 정리 | `/oh-my-claudecode:ai-slop-cleaner` |
| `writer-memory` | 작성 프로젝트용 메모리 시스템 | `/oh-my-claudecode:writer-memory` |

### 매직 키워드 레퍼런스

| 키워드 | 효과 |
|--------|------|
| `ultrawork`, `ulw` | 병렬 에이전트 오케스트레이션 |
| `autopilot`, `build me`, `I want a` | 자율 실행 파이프라인 |
| `ralph`, `don't stop`, `must complete` | 검증 완료까지 루프 |
| `ccg`, `claude-codex-gemini` | 3-모델 오케스트레이션 |
| `ralplan` | 합의 기반 계획 수립 |
| `deep interview`, `ouroboros` | 소크라테스식 심층 인터뷰 |
| `deepsearch`, `search the codebase` | 코드베이스 검색 모드 |
| `deepanalyze`, `deep-analyze` | 심층 분석 모드 |
| `ultrathink` | 심층 추론 모드 |
| `tdd`, `test first`, `red green` | TDD 워크플로우 |
| `deslop`, `anti-slop` | AI 표현 정리 |
| `cancelomc`, `stopomc` | 활성 실행 모드 취소 |

### 키워드 감지 소스

키워드는 두 곳에서 처리됩니다:

| 소스 | 역할 | 사용자 정의 가능 |
|------|------|----------------|
| `config.jsonc` `magicKeywords` | 4개 카테고리 (ultrawork, search, analyze, ultrathink) | 가능 |
| `keyword-detector` hook | 11개 이상 트리거 (autopilot, ralph, ccg 등) | 불가 |

`autopilot`, `ralph`, `ccg` 트리거는 hook에 하드코딩되어 있으며 config를 통해 변경할 수 없습니다.

---

## Hooks

### 개요

Hooks는 Claude Code 라이프사이클 이벤트에 반응하는 코드입니다. 사용자가 프롬프트를 제출하거나, 도구를 사용하거나, 세션이 시작/종료될 때 자동으로 실행됩니다. OMC는 이 hook 시스템을 통해 에이전트 위임, 키워드 감지, 상태 지속성을 구현합니다.

### 라이프사이클 이벤트

Claude Code는 11개의 라이프사이클 이벤트를 제공합니다. OMC는 이 이벤트에 hook을 등록합니다:

| 이벤트 | 발생 시점 | OMC 활용 |
|--------|----------|---------|
| `UserPromptSubmit` | 사용자가 프롬프트 제출 | 매직 키워드 감지, 스킬 주입 |
| `SessionStart` | 세션 시작 | 초기 설정, 프로젝트 메모리 로드 |
| `PreToolUse` | 도구 사용 전 | 권한 검증, 병렬 실행 힌트 |
| `PermissionRequest` | 권한 요청 발생 | Bash 명령어 권한 처리 |
| `PostToolUse` | 도구 사용 후 | 결과 검증, 프로젝트 메모리 업데이트 |
| `PostToolUseFailure` | 도구 실패 후 | 오류 복구 처리 |
| `SubagentStart` | 서브에이전트 시작 | 에이전트 추적 |
| `SubagentStop` | 서브에이전트 종료 | 에이전트 추적, 출력 검증 |
| `PreCompact` | 컨텍스트 압축 전 | 중요 정보 보존, 프로젝트 메모리 저장 |
| `Stop` | Claude가 멈추려 할 때 | 지속 모드 강제 적용, 코드 단순화 |
| `SessionEnd` | 세션 종료 | 세션 데이터 정리 |

### system-reminder 주입

Hooks는 `<system-reminder>` 태그를 통해 Claude에 추가 컨텍스트를 주입합니다:

```xml
<system-reminder>
hook success: Success
</system-reminder>
```

주입 패턴의 의미:

| 패턴 | 의미 |
|------|------|
| `hook success: Success` | Hook이 정상 실행됨, 계획대로 진행 |
| `hook additional context: ...` | 추가 컨텍스트 정보, 참고할 것 |
| `[MAGIC KEYWORD: ...]` | 매직 키워드 감지됨, 지정된 스킬 실행 |
| `The boulder never stops` | ralph/ultrawork 모드가 활성화됨 |

### 주요 Hooks

**keyword-detector** — `UserPromptSubmit` 시 실행. 사용자 입력에서 매직 키워드를 감지하고 해당 스킬을 활성화합니다.

**persistent-mode** — `Stop` 시 실행. 지속 모드(ralph, ultrawork)가 활성화된 경우, 작업이 검증 완료될 때까지 Claude가 멈추지 못하도록 합니다.

**pre-compact** — `PreCompact` 시 실행. 컨텍스트 창이 압축되기 전에 중요한 정보를 노트패드에 저장합니다.

**subagent-tracker** — `SubagentStart` 및 `SubagentStop` 시 실행. 현재 실행 중인 에이전트를 추적하고, 종료 시 출력을 검증합니다.

**context-guard-stop** — `Stop` 시 실행. 컨텍스트 사용량을 모니터링하고 한도에 가까워지면 경고합니다.

**code-simplifier** — `Stop` 시 실행. 기본적으로 비활성화. 활성화 시 Claude가 멈출 때 수정된 파일을 자동으로 단순화합니다.

config로 활성화:
```json
{
  "codeSimplifier": {
    "enabled": true,
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"],
    "maxFiles": 10
  }
}
```

### Hook 등록 구조

OMC hook은 `hooks.json`에 선언됩니다. 각 hook은 타임아웃이 있는 Node.js 스크립트입니다:

```json
{
  "UserPromptSubmit": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "node scripts/keyword-detector.mjs",
          "timeout": 5
        }
      ]
    }
  ]
}
```

- `matcher`: hook이 반응하는 패턴 (`*`는 모든 입력에 매칭)
- `timeout`: 초 단위 타임아웃
- `type`: 항상 `"command"` (외부 명령어 실행)

### Hooks 비활성화

모든 hook 비활성화:
```bash
export DISABLE_OMC=1
```

특정 hook만 건너뛰기 (쉼표로 구분):
```bash
export OMC_SKIP_HOOKS="keyword-detector,persistent-mode"
```

---

## 상태 관리

### 개요

OMC는 작업 진행 상황과 프로젝트 지식을 `.omc/` 디렉토리에 저장합니다. 상태 시스템은 컨텍스트 압축으로 컨텍스트 창이 초기화되더라도 중요한 정보를 보존합니다.

### 디렉토리 구조

```
.omc/
├── state/                    # 모드별 상태 파일
│   ├── autopilot-state.json  # autopilot 진행 상황
│   ├── ralph-state.json      # ralph 루프 상태
│   ├── team/                 # team 작업 상태
│   └── sessions/             # 세션별 상태
│       └── {sessionId}/
├── notepad.md                # 압축에 강한 메모 패드
├── project-memory.json       # 프로젝트 지식 저장소
├── plans/                    # 실행 계획
├── notepads/                 # 계획별 지식 캡처
│   └── {plan-name}/
│       ├── learnings.md
│       ├── decisions.md
│       ├── issues.md
│       └── problems.md
├── autopilot/                # autopilot 아티팩트
│   └── spec.md
├── research/                 # 연구 결과
└── logs/                     # 실행 로그
```

**전역 상태:**
- `~/.omc/state/{name}.json` — 사용자 기본 설정 및 전역 config

레거시 위치는 읽기 시 자동으로 마이그레이션됩니다.

### 노트패드

**파일:** `.omc/notepad.md`

노트패드는 컨텍스트 압축에서 살아남습니다. 저장된 내용은 컨텍스트 창이 초기화된 후에도 유지됩니다.

```bash
# 스킬을 통해 메모 저장
`notepad_write_manual` MCP 도구 또는 영구 보존을 위한 `notepad_write_priority` 도구로 메모를 저장할 수 있습니다.
```

**MCP 도구:**

| 도구 | 설명 |
|------|------|
| `notepad_read` | 노트패드 내용 읽기 |
| `notepad_write_priority` | 높은 우선순위 메모 작성 (영구 보존) |
| `notepad_write_working` | 작업 메모 작성 |
| `notepad_write_manual` | 수동 메모 작성 |
| `notepad_prune` | 오래된 메모 정리 |
| `notepad_stats` | 노트패드 통계 보기 |

**동작 방식:**
1. `PreCompact` 이벤트 시, 중요한 정보가 노트패드에 저장됨
2. 압축 후, 노트패드 내용이 컨텍스트에 다시 주입됨
3. 에이전트가 노트패드를 사용해 이전 컨텍스트 복구

### 프로젝트 메모리

**파일:** `.omc/project-memory.json`

프로젝트 메모리는 프로젝트 수준의 지식을 위한 지속적인 저장소입니다. 세션 전반에 걸쳐 유지됩니다.

**MCP 도구:**

| 도구 | 설명 |
|------|------|
| `project_memory_read` | 프로젝트 메모리 읽기 |
| `project_memory_write` | 전체 프로젝트 메모리 덮어쓰기 |
| `project_memory_add_note` | 노트 추가 |
| `project_memory_add_directive` | 지시사항 추가 |

**라이프사이클 통합:**
- `SessionStart`: 프로젝트 메모리 로드 및 컨텍스트에 주입
- `PostToolUse`: 도구 결과에서 프로젝트 지식 추출 및 저장
- `PreCompact`: 컨텍스트 압축 전 프로젝트 메모리 저장

### 세션 범위

**경로:** `.omc/state/sessions/{sessionId}/`

세션별로 격리된 상태를 저장합니다. 같은 프로젝트에서 여러 세션이 동시에 실행되어도 상태 충돌이 발생하지 않습니다.

### 계획 노트패드 (계획별 지식 캡처)

**경로:** `.omc/notepads/{plan-name}/`

각 실행 계획의 학습 내용을 별도로 저장합니다.

| 파일 | 내용 |
|------|------|
| `learnings.md` | 발견된 패턴, 성공적인 접근 방식 |
| `decisions.md` | 아키텍처 결정 및 근거 |
| `issues.md` | 문제점 및 블로커 |
| `problems.md` | 기술 부채 및 주의사항 |

모든 항목은 자동으로 타임스탬프가 기록됩니다.

### 중앙집중식 상태 (선택사항)

기본적으로 상태는 프로젝트의 `.omc/` 디렉토리에 저장되며, worktree가 삭제되면 함께 삭제됩니다.

worktree 삭제 후에도 상태를 보존하려면 `OMC_STATE_DIR` 환경 변수를 설정합니다:

```bash
# ~/.bashrc 또는 ~/.zshrc에 추가
export OMC_STATE_DIR="$HOME/.claude/omc"
```

상태는 `~/.claude/omc/{project-identifier}/`에 저장됩니다. 프로젝트 식별자는 Git 리모트 URL의 해시이므로, 같은 저장소는 서로 다른 worktree에서도 상태를 공유합니다.

### 영구 메모리 태그

중요한 정보에는 `<remember>` 태그를 사용합니다:

```xml
<!-- 7일간 보존 -->
<remember>API 엔드포인트가 /v2로 변경됨</remember>

<!-- 영구 보존 -->
<remember priority>프로덕션 DB에 직접 접근 금지</remember>
```

| 태그 | 보존 기간 |
|------|---------|
| `<remember>` | 7일 |
| `<remember priority>` | 영구 |

---

## 검증 프로토콜

검증 모듈은 증거와 함께 작업 완료를 보장합니다:

**표준 검사 항목:**
- BUILD: 컴파일 통과
- TEST: 모든 테스트 통과
- LINT: 린팅 오류 없음
- FUNCTIONALITY: 기능이 예상대로 동작
- ARCHITECT: Opus 티어 리뷰 승인
- TODO: 모든 작업 완료
- ERROR_FREE: 미해결 오류 없음

증거는 최신 상태(5분 이내)여야 하며 실제 명령어 출력이 포함되어야 합니다.

---

## 자세한 정보

- **전체 레퍼런스**: [REFERENCE.md](./REFERENCE.md) 참조
- **내부 API**: [FEATURES.md](./FEATURES.md) 참조
- **사용자 가이드**: [README.md](../README.md) 참조
- **스킬 레퍼런스**: 프로젝트의 CLAUDE.md 참조
