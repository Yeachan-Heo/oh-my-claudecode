# 레퍼런스 문서

oh-my-claudecode의 전체 레퍼런스입니다. 빠른 시작은 메인 [README.md](../../README.md)를 참조하세요.

---

## 목차

- [설치](#설치)
- [설정](#설정)
- [에이전트 (28개)](#에이전트-28개)
- [스킬 (37개)](#스킬-37개)
- [슬래시 명령어](#슬래시-명령어)
- [훅 시스템](#훅-시스템)
- [매직 키워드](#매직-키워드)
- [MCP 경로 경계 규칙](#mcp-경로-경계-규칙)
- [플랫폼 지원](#플랫폼-지원)
- [성능 모니터링](#성능-모니터링)
- [문제 해결](#문제-해결)
- [변경 로그](#변경-로그)

---

## 설치

**Claude Code 플러그인 방식만 지원됩니다.** 다른 설치 방법 (npm, bun, curl)은 폐기되었으며 올바르게 작동하지 않을 수 있습니다.

### Claude Code 플러그인 (필수)

```bash
# 1단계: 마켓플레이스 추가
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode

# 2단계: 플러그인 설치
/plugin install oh-my-claudecode
```

이 방법은 Claude Code의 플러그인 시스템과 직접 통합되며 Node.js 훅을 사용합니다.

> **참고**: npm/bun 글로벌 직접 설치는 **지원되지 않습니다**. 플러그인 시스템이 모든 설치 및 훅 설정을 자동으로 처리합니다.

### 요구 사항

- [Claude Code](https://docs.anthropic.com/claude-code) 설치됨
- 다음 중 하나:
  - **Claude Max/Pro 구독** (개인 사용자에게 권장)
  - **Anthropic API 키** (`ANTHROPIC_API_KEY` 환경 변수)

---

## 설정

### 프로젝트 범위 설정 (권장)

현재 프로젝트에만 omc를 설정합니다:

```
/oh-my-claudecode:omc-setup
```

- 현재 프로젝트에 `./.claude/CLAUDE.md`를 생성합니다
- 설정은 이 프로젝트에만 적용됩니다
- 다른 프로젝트나 글로벌 설정에는 영향을 주지 않습니다
- **안전**: 글로벌 CLAUDE.md를 보존합니다

### 글로벌 설정

모든 Claude Code 세션에 omc를 설정합니다:

```
/oh-my-claudecode:omc-setup
```

- 글로벌로 `~/.claude/CLAUDE.md`를 생성합니다
- 설정은 모든 프로젝트에 적용됩니다
- **주의**: 기존 `~/.claude/CLAUDE.md`를 완전히 덮어씁니다

### 설정으로 활성화되는 기능

| 기능            | 미설정 시   | omc 설정 시                |
| --------------- | ----------- | -------------------------- |
| 에이전트 위임   | 수동만 가능 | 작업에 따라 자동           |
| 키워드 감지     | 비활성화    | ultrawork, search, analyze |
| 할 일 연속 실행 | 기본        | 완료 강제                  |
| 모델 라우팅     | 기본값      | 스마트 티어 선택           |
| 스킬 조합       | 없음        | 자동 스킬 결합             |

### 설정 우선순위

두 설정이 모두 존재하는 경우, **프로젝트 범위가 글로벌보다 우선**합니다:

```
./.claude/CLAUDE.md  (프로젝트)   →  덮어씀  →  ~/.claude/CLAUDE.md  (글로벌)
```

### 설정 재실행이 필요한 경우

- **최초**: 설치 후 실행 (프로젝트 또는 글로벌 선택)
- **업데이트 후**: 최신 설정을 받기 위해 재실행
- **다른 머신**: Claude Code를 사용하는 각 머신에서 실행
- **새 프로젝트**: omc가 필요한 각 프로젝트에서 `/oh-my-claudecode:omc-setup --local` 실행

> **참고**: 플러그인 업데이트 후 (`npm update`, `git pull` 또는 Claude Code의 플러그인 업데이트를 통해), 최신 CLAUDE.md 변경사항을 적용하려면 반드시 `/oh-my-claudecode:omc-setup`을 재실행**해야 합니다**.

### 에이전트 커스터마이징

`~/.claude/agents/`의 에이전트 파일을 편집하여 동작을 커스터마이징할 수 있습니다:

```yaml
---
name: architect
description: Your custom description
tools: Read, Grep, Glob, Bash, Edit
model: opus # or sonnet, haiku
---
Your custom system prompt here...
```

### 프로젝트 수준 설정

프로젝트별 지침을 위해 프로젝트에 `.claude/CLAUDE.md`를 생성하세요:

```markdown
# Project Context

This is a TypeScript monorepo using:

- Bun runtime
- React for frontend
- PostgreSQL database

## Conventions

- Use functional components
- All API routes in /src/api
- Tests alongside source files
```

### Stop Callback 알림 태그

`omc config-stop-callback`으로 Telegram/Discord stop callback 태그를 설정합니다.

```bash
# 태그 설정/변경
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"

# 증분 업데이트
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags

# 현재 callback 설정 확인
omc config-stop-callback telegram --show
omc config-stop-callback discord --show
```

태그 동작:

- Telegram: `alice`는 `@alice`로 정규화됩니다
- Discord: `@here`, `@everyone`, 숫자 사용자 ID (`<@id>`), 역할 태그 (`role:<id>` -> `<@&id>`)를 지원합니다
- `file` callback은 태그 옵션을 무시합니다

---

## 에이전트 (28개)

Task 도구를 통해 호출할 때는 항상 `oh-my-claudecode:` 접두사를 사용하세요.

### 도메인 및 티어별

| 도메인              | LOW (Haiku)             | MEDIUM (Sonnet)       | HIGH (Opus)         |
| ------------------- | ----------------------- | --------------------- | ------------------- |
| **분석**            | `architect-low`         | `architect-medium`    | `architect`         |
| **실행**            | `executor-low`          | `executor`            | `executor-high`     |
| **검색**            | `explore`               | -                     | `explore-high`      |
| **리서치**          | -                       | `document-specialist` | -                   |
| **프론트엔드**      | `designer-low`          | `designer`            | `designer-high`     |
| **문서**            | `writer`                | -                     | -                   |
| **비주얼**          | -                       | `vision`              | -                   |
| **플래닝**          | -                       | -                     | `planner`           |
| **비평**            | -                       | -                     | `critic`            |
| **사전 플래닝**     | -                       | -                     | `analyst`           |
| **테스트**          | -                       | `qa-tester`           | -                   |
| **보안**            | `security-reviewer-low` | -                     | `security-reviewer` |
| **빌드**            | -                       | `build-fixer`         | -                   |
| **TDD**             | `tdd-guide-low`         | `tdd-guide`           | -                   |
| **코드 리뷰**       | -                       | -                     | `code-reviewer`     |
| **데이터 사이언스** | -                       | `scientist`           | `scientist-high`    |

### 에이전트 선택 가이드

| 작업 유형              | 최적 에이전트                 | 모델   |
| ---------------------- | ----------------------------- | ------ |
| 빠른 코드 조회         | `explore`                     | haiku  |
| 파일/패턴 찾기         | `explore`                     | haiku  |
| 복잡한 아키텍처 검색   | `explore-high`                | opus   |
| 간단한 코드 변경       | `executor-low`                | haiku  |
| 기능 구현              | `executor`                    | sonnet |
| 복잡한 리팩토링        | `executor-high`               | opus   |
| 간단한 이슈 디버깅     | `architect-low`               | haiku  |
| 복잡한 이슈 디버깅     | `architect`                   | opus   |
| UI 컴포넌트            | `designer`                    | sonnet |
| 복잡한 UI 시스템       | `designer-high`               | opus   |
| 문서/주석 작성         | `writer`                      | haiku  |
| 문서/API 리서치        | `document-specialist`         | sonnet |
| 이미지/다이어그램 분석 | `vision`                      | sonnet |
| 전략적 플래닝          | `planner`                     | opus   |
| 플랜 리뷰/비평         | `critic`                      | opus   |
| 사전 플래닝 분석       | `analyst`                     | opus   |
| CLI 대화형 테스트      | `qa-tester`                   | sonnet |
| 보안 리뷰              | `security-reviewer`           | opus   |
| 빠른 보안 스캔         | `security-reviewer-low`       | haiku  |
| 빌드 오류 수정         | `build-fixer`                 | sonnet |
| 간단한 빌드 수정       | `build-fixer` (model=haiku)   | haiku  |
| TDD 워크플로우         | `tdd-guide`                   | sonnet |
| 빠른 테스트 제안       | `tdd-guide-low`               | haiku  |
| 코드 리뷰              | `code-reviewer`               | opus   |
| 빠른 코드 검사         | `code-reviewer` (model=haiku) | haiku  |
| 데이터 분석/통계       | `scientist`                   | sonnet |
| 빠른 데이터 검사       | `scientist` (model=haiku)     | haiku  |
| 복잡한 ML/가설 검증    | `scientist-high`              | opus   |

---

## 스킬 (37개)

### 코어 스킬

| 스킬          | 설명                                          | 수동 명령어                    |
| ------------- | --------------------------------------------- | ------------------------------ |
| `orchestrate` | 멀티 에이전트 오케스트레이션 모드             | -                              |
| `autopilot`   | 아이디어에서 작동하는 코드까지 완전 자율 실행 | `/oh-my-claudecode:autopilot`  |
| `ultrawork`   | 병렬 에이전트를 통한 최대 성능                | `/oh-my-claudecode:ultrawork`  |
| `ultrapilot`  | 3-5배 빠른 병렬 autopilot                     | `/oh-my-claudecode:ultrapilot` |
| `swarm`       | 작업 클레이밍을 가진 N개의 조정된 에이전트    | `/oh-my-claudecode:swarm`      |
| `pipeline`    | 순차적 에이전트 체이닝                        | `/oh-my-claudecode:pipeline`   |
| ``            | 토큰 효율적 병렬 실행                         | `/oh-my-claudecode:`           |
| `ralph`       | 완료될 때까지 자기 참조적 개발                | `/oh-my-claudecode:ralph`      |
| `ralph-init`  | 구조화된 작업 추적을 위한 PRD 초기화          | `/oh-my-claudecode:ralph-init` |
| `ultraqa`     | 자율 QA 사이클링 워크플로우                   | `/oh-my-claudecode:ultraqa`    |
| `plan`        | 플래닝 세션 시작                              | `/oh-my-claudecode:plan`       |
| `ralplan`     | 반복적 플래닝 (planner+architect+critic)      | `/oh-my-claudecode:ralplan`    |
| `review`      | critic을 통한 작업 플랜 리뷰                  | `/oh-my-claudecode:review`     |

### 향상 스킬

| 스킬              | 설명                                      | 수동 명령어                         |
| ----------------- | ----------------------------------------- | ----------------------------------- |
| `deepinit`        | 계층적 AGENTS.md 코드베이스 문서화        | `/oh-my-claudecode:deepinit`        |
| `deepsearch`      | 다중 전략 코드베이스 검색                 | `/oh-my-claudecode:deepsearch`      |
| `analyze`         | 심층 분석 및 조사                         | `/oh-my-claudecode:analyze`         |
| `sciomc`          | 병렬 scientist 오케스트레이션             | `/oh-my-claudecode:sciomc`          |
| `frontend-ui-ux`  | 디자이너 출신 개발자의 UI/UX 전문성       | (자동 활성화)                       |
| `git-master`      | 원자적 커밋 및 히스토리를 위한 Git 전문가 | (자동 활성화)                       |
| `tdd`             | TDD 강제: 테스트 우선 개발                | `/oh-my-claudecode:tdd`             |
| `learner`         | 세션에서 재사용 가능한 스킬 추출          | `/oh-my-claudecode:learner`         |
| `build-fix`       | 빌드 및 TypeScript 오류 수정              | `/oh-my-claudecode:build-fix`       |
| `code-review`     | 종합 코드 리뷰                            | `/oh-my-claudecode:code-review`     |
| `security-review` | 보안 취약점 탐지                          | `/oh-my-claudecode:security-review` |

### 유틸리티 스킬

| 스킬                      | 설명                                          | 수동 명령어                                 |
| ------------------------- | --------------------------------------------- | ------------------------------------------- |
| `note`                    | 컨텍스트 압축에 강한 노트패드에 메모 저장     | `/oh-my-claudecode:note`                    |
| `cancel`                  | 모든 모드에 대한 통합 취소                    | `/oh-my-claudecode:cancel`                  |
| `omc-setup`               | 최초 설정 마법사                              | `/oh-my-claudecode:omc-setup`               |
| `omc-doctor`              | 설치 문제 진단 및 수정                        | `/oh-my-claudecode:omc-doctor`              |
| `omc-help`                | OMC 사용 가이드 표시                          | `/oh-my-claudecode:omc-help`                |
| `hud`                     | HUD 상태 표시줄 설정                          | `/oh-my-claudecode:hud`                     |
| `release`                 | 자동 릴리스 워크플로우                        | `/oh-my-claudecode:release`                 |
| `mcp-setup`               | MCP 서버 설정                                 | `/oh-my-claudecode:mcp-setup`               |
| `writer-memory`           | 작성자를 위한 에이전틱 메모리 시스템          | `/oh-my-claudecode:writer-memory`           |
| `project-session-manager` | 격리된 개발 환경 관리 (git worktrees + tmux)  | `/oh-my-claudecode:project-session-manager` |
| `skill`                   | 로컬 스킬 관리 (목록, 추가, 제거, 검색, 편집) | `/oh-my-claudecode:skill`                   |

---

## 슬래시 명령어

모든 스킬은 `/oh-my-claudecode:` 접두사가 붙은 슬래시 명령어로 사용할 수 있습니다.

| 명령어                                       | 설명                                      |
| -------------------------------------------- | ----------------------------------------- |
| `/oh-my-claudecode:orchestrate <task>`       | 멀티 에이전트 오케스트레이션 모드 활성화  |
| `/oh-my-claudecode:autopilot <task>`         | 완전 자율 실행                            |
| `/oh-my-claudecode:ultrawork <task>`         | 병렬 에이전트를 통한 최대 성능 모드       |
| `/oh-my-claudecode:ultrapilot <task>`        | 병렬 autopilot (3-5배 빠름)               |
| `/oh-my-claudecode:swarm <N>:<agent> <task>` | 조정된 에이전트 swarm                     |
| `/oh-my-claudecode:pipeline <stages>`        | 순차적 에이전트 체이닝                    |
| `/oh-my-claudecode: <task>`                  | 토큰 효율적 병렬 실행                     |
| `/oh-my-claudecode:ralph-init <task>`        | 구조화된 작업 추적을 위한 PRD 초기화      |
| `/oh-my-claudecode:ralph <task>`             | 작업 완료까지 자기 참조 루프              |
| `/oh-my-claudecode:ultraqa <goal>`           | 자율 QA 사이클링 워크플로우               |
| `/oh-my-claudecode:plan <description>`       | 플래닝 세션 시작                          |
| `/oh-my-claudecode:ralplan <description>`    | 합의를 통한 반복적 플래닝                 |
| `/oh-my-claudecode:review [plan-path]`       | critic을 통한 플랜 리뷰                   |
| `/oh-my-claudecode:deepsearch <query>`       | 다중 전략 코드베이스 검색                 |
| `/oh-my-claudecode:deepinit [path]`          | 계층적 AGENTS.md 파일로 코드베이스 인덱싱 |
| `/oh-my-claudecode:analyze <target>`         | 심층 분석 및 조사                         |
| `/oh-my-claudecode:sciomc <topic>`           | 병렬 리서치 오케스트레이션                |
| `/oh-my-claudecode:tdd <feature>`            | TDD 워크플로우 강제                       |
| `/oh-my-claudecode:learner`                  | 세션에서 재사용 가능한 스킬 추출          |
| `/oh-my-claudecode:note <content>`           | notepad.md에 메모 저장                    |
| `/oh-my-claudecode:cancel`                   | 통합 취소                                 |
| `/oh-my-claudecode:omc-setup`                | 최초 설정 마법사                          |
| `/oh-my-claudecode:omc-doctor`               | 설치 문제 진단 및 수정                    |
| `/oh-my-claudecode:omc-help`                 | OMC 사용 가이드 표시                      |
| `/oh-my-claudecode:hud`                      | HUD 상태 표시줄 설정                      |
| `/oh-my-claudecode:release`                  | 자동 릴리스 워크플로우                    |
| `/oh-my-claudecode:mcp-setup`                | MCP 서버 설정                             |

---

## 훅 시스템

oh-my-claudecode에는 Claude Code의 동작을 향상시키는 31개의 라이프사이클 훅이 포함되어 있습니다.

### 실행 모드 훅

| 훅                | 설명                                             |
| ----------------- | ------------------------------------------------ |
| `autopilot`       | 아이디어에서 작동하는 코드까지 완전 자율 실행    |
| `ultrawork`       | 최대 병렬 에이전트 실행                          |
| `ralph`           | 검증 완료까지 지속                               |
| `ultrapilot`      | 파일 소유권이 있는 병렬 autopilot                |
| `ultraqa`         | 목표 달성까지 QA 사이클링                        |
| `swarm`           | SQLite 작업 클레이밍을 가진 조정된 멀티 에이전트 |
| `mode-registry`   | 활성 실행 모드 추적 (ecomode 포함)               |
| `persistent-mode` | 세션 간 모드 상태 유지                           |

### 코어 훅

| 훅                   | 설명                                       |
| -------------------- | ------------------------------------------ |
| `rules-injector`     | YAML 프론트매터 파싱을 통한 동적 규칙 주입 |
| `omc-orchestrator`   | 오케스트레이터 동작 및 위임 강제           |
| `auto-slash-command` | 슬래시 명령어 자동 감지 및 실행            |
| `keyword-detector`   | 매직 키워드 감지 (ultrawork, ralph 등)     |
| `todo-continuation`  | 할 일 목록 완료 보장                       |
| `notepad`            | 컨텍스트 압축에 강한 메모리 시스템         |
| `learner`            | 대화에서 스킬 추출                         |

### 컨텍스트 및 복구

| 훅                          | 설명                                      |
| --------------------------- | ----------------------------------------- |
| `recovery`                  | 편집 오류, 세션 및 컨텍스트 윈도우 복구   |
| `preemptive-compaction`     | 제한 방지를 위한 컨텍스트 사용량 모니터링 |
| `pre-compact`               | 압축 전 처리                              |
| `directory-readme-injector` | README 컨텍스트 주입                      |

### 품질 및 유효성 검사

| 훅                         | 설명                      |
| -------------------------- | ------------------------- |
| `comment-checker`          | BDD 감지 및 지시문 필터링 |
| `thinking-block-validator` | 확장된 사고 유효성 검사   |
| `empty-message-sanitizer`  | 빈 메시지 처리            |
| `permission-handler`       | 권한 요청 및 유효성 검사  |
| `think-mode`               | 확장된 사고 감지          |

### 조정 및 환경

| 훅                        | 설명                        |
| ------------------------- | --------------------------- |
| `subagent-tracker`        | 생성된 서브 에이전트 추적   |
| `session-end`             | 세션 종료 처리              |
| `non-interactive-env`     | CI/비대화형 환경 처리       |
| `agent-usage-reminder`    | 전문 에이전트 사용 리마인더 |
| `background-notification` | 백그라운드 작업 완료 알림   |
| `plugin-patterns`         | 플러그인 패턴 감지          |
| `setup`                   | 초기 설정 및 구성           |

---

## 매직 키워드

프롬프트 어디에든 이 단어를 포함하면 향상된 모드가 활성화됩니다:

| 키워드                                          | 효과                                |
| ----------------------------------------------- | ----------------------------------- |
| `ultrawork`, `ulw`, `uw`                        | 병렬 에이전트 오케스트레이션 활성화 |
| ``, `eco`, `efficient`, `save-tokens`, `budget` | 토큰 효율적 병렬 실행               |
| `autopilot`, `build me`, `I want a`             | 완전 자율 실행                      |
| `ultrapilot`, `parallel build`, `swarm build`   | 병렬 autopilot (3-5배 빠름)         |
| `ralph`, `don't stop`, `must complete`          | 검증 완료까지 지속                  |
| `plan this`, `plan the`                         | 플래닝 인터뷰 워크플로우            |
| `ralplan`                                       | 반복적 플래닝 합의                  |
| `search`, `find`, `locate`                      | 향상된 검색 모드                    |
| `analyze`, `investigate`, `debug`               | 심층 분석 모드                      |
| `sciomc`                                        | 병렬 리서치 오케스트레이션          |
| `tdd`, `test first`, `red green`                | TDD 워크플로우 강제                 |
| `swarm N agents`                                | 조정된 에이전트 swarm               |
| `pipeline`, `chain agents`                      | 순차적 에이전트 체이닝              |
| `stop`, `cancel`, `abort`                       | 통합 취소                           |

### 예시

```bash
# Claude Code에서:

# 최대 병렬 처리
ultrawork implement user authentication with OAuth

# 토큰 효율적 병렬 처리
eco fix all TypeScript errors

# 향상된 검색
find all files that import the utils module

# 심층 분석
analyze why the tests are failing

# 자율 실행
autopilot: build a todo app with React

# 병렬 autopilot
ultrapilot: build a fullstack todo app

# 지속성 모드
ralph: refactor the authentication module

# 플래닝 세션
plan this feature

# TDD 워크플로우
tdd: implement password validation

# 조정된 swarm
swarm 5 agents: fix all lint errors

# 에이전트 체이닝
pipeline: analyze → fix → test this bug
```

---

## MCP 경로 경계 규칙

MCP 도구 (`ask_codex`, `ask_gemini`)는 보안을 위해 엄격한 경로 경계를 적용합니다. `prompt_file`과 `output_file` 모두 `working_directory`를 기준으로 해석됩니다.

### 기본 동작 (엄격 모드)

기본적으로 두 파일 모두 `working_directory` 내에 있어야 합니다:

| 매개변수            | 요구 사항                                                |
| ------------------- | -------------------------------------------------------- |
| `prompt_file`       | `working_directory` 내에 있어야 함 (심볼릭 링크 해석 후) |
| `output_file`       | `working_directory` 내에 있어야 함 (심볼릭 링크 해석 후) |
| `working_directory` | 프로젝트 worktree 내에 있어야 함 (우회하지 않는 한)      |

### 환경 변수 오버라이드

| 변수                             | 값                                   | 설명                                                |
| -------------------------------- | ------------------------------------ | --------------------------------------------------- |
| `OMC_MCP_OUTPUT_PATH_POLICY`     | `strict` (기본값), `redirect_output` | 출력 파일 경로 적용 제어                            |
| `OMC_MCP_OUTPUT_REDIRECT_DIR`    | 경로 (기본값: `.omc/outputs`)        | 정책이 `redirect_output`일 때 리다이렉트할 디렉토리 |
| `OMC_MCP_ALLOW_EXTERNAL_PROMPT`  | `0` (기본값), `1`                    | working directory 외부의 프롬프트 파일 허용         |
| `OMC_ALLOW_EXTERNAL_WORKDIR`     | 미설정 (기본값), `1`                 | 프로젝트 worktree 외부의 working_directory 허용     |
| `OMC_DISCORD_WEBHOOK_URL`        | URL                                  | 알림용 Discord 웹훅 URL                             |
| `OMC_DISCORD_NOTIFIER_BOT_TOKEN` | 토큰                                 | Bot API 알림용 Discord 봇 토큰                      |
| `OMC_DISCORD_NOTIFIER_CHANNEL`   | 채널 ID                              | Bot API 알림용 Discord 채널 ID                      |
| `OMC_DISCORD_MENTION`            | `<@uid>` 또는 `<@&role_id>`          | Discord 메시지에 추가할 멘션                        |
| `OMC_TELEGRAM_BOT_TOKEN`         | 토큰                                 | 알림용 Telegram 봇 토큰                             |
| `OMC_TELEGRAM_CHAT_ID`           | 채팅 ID                              | 알림용 Telegram 채팅 ID                             |
| `OMC_SLACK_WEBHOOK_URL`          | URL                                  | 알림용 Slack 수신 웹훅 URL                          |

### 정책 설명

**`OMC_MCP_OUTPUT_PATH_POLICY=strict` (기본값)**

- 출력 파일은 `working_directory` 내에 있어야 합니다
- 경계 외부에 쓰려는 시도는 `E_PATH_OUTSIDE_WORKDIR_OUTPUT`으로 실패합니다
- 가장 안전한 옵션 - 프로덕션에 권장

**`OMC_MCP_OUTPUT_PATH_POLICY=redirect_output`**

- 출력 파일이 자동으로 `OMC_MCP_OUTPUT_REDIRECT_DIR`로 리다이렉트됩니다
- 파일명만 보존되며 디렉토리 구조는 평탄화됩니다
- 모든 출력을 한 곳에 모으고 싶을 때 유용합니다
- `[MCP Config]` 수준에서 리다이렉트를 로깅합니다

**`OMC_MCP_ALLOW_EXTERNAL_PROMPT=1`**

- `working_directory` 외부의 프롬프트 파일 읽기를 허용합니다
- **보안 경고**: 파일시스템의 임의 파일 읽기를 가능하게 합니다
- 신뢰할 수 있는 환경에서만 사용하세요

**`OMC_ALLOW_EXTERNAL_WORKDIR=1`**

- `working_directory`가 프로젝트 worktree 외부에 있는 것을 허용합니다
- worktree 경계 검사를 우회합니다
- 외부 프로젝트에 대해 MCP 도구를 실행할 때 사용합니다

### 오류 토큰

| 토큰                            | 의미                                          |
| ------------------------------- | --------------------------------------------- |
| `E_PATH_OUTSIDE_WORKDIR_PROMPT` | prompt_file이 working_directory 외부에 있음   |
| `E_PATH_OUTSIDE_WORKDIR_OUTPUT` | output_file이 working_directory 외부에 있음   |
| `E_PATH_RESOLUTION_FAILED`      | 심볼릭 링크 또는 디렉토리 해석 실패           |
| `E_WRITE_FAILED`                | 출력 파일 쓰기 실패 (I/O 오류)                |
| `E_WORKDIR_INVALID`             | working_directory가 존재하지 않거나 접근 불가 |

### 유효/무효 경로 예시

**유효한 경로 (working_directory: `/home/user/project`)**

```
prompt.txt                    -> /home/user/project/prompt.txt
./prompts/task.md             -> /home/user/project/prompts/task.md
../project/output.txt         -> /home/user/project/output.txt (내부로 해석됨)
.omc/outputs/response.md      -> /home/user/project/.omc/outputs/response.md
```

**무효한 경로 (working_directory: `/home/user/project`)**

```
/etc/passwd                   -> working directory 외부 (절대 경로)
../../etc/shadow              -> working directory 외부 (너무 많이 상위로 이동)
/tmp/output.txt               -> working directory 외부 (다른 루트)
```

### 문제 해결 매트릭스

| 증상                                                | 원인                                          | 해결 방법                                                                                       |
| --------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `E_PATH_OUTSIDE_WORKDIR_PROMPT` 오류                | prompt_file이 working_directory 외부에 있음   | 파일을 working directory로 이동하거나 working_directory를 공통 상위 디렉토리로 변경             |
| `E_PATH_OUTSIDE_WORKDIR_OUTPUT` 오류                | output_file이 working_directory 외부에 있음   | working directory 내의 상대 경로를 사용하거나 `OMC_MCP_OUTPUT_PATH_POLICY=redirect_output` 설정 |
| `E_PATH_RESOLUTION_FAILED` 오류                     | 심볼릭 링크 해석 실패 또는 디렉토리 접근 불가 | 대상 디렉토리가 존재하고 접근 가능한지 확인                                                     |
| `E_WRITE_FAILED` 오류                               | I/O 오류 (권한, 디스크 용량)                  | 파일 권한과 디스크 공간 확인                                                                    |
| `working_directory is outside the project worktree` | working_directory가 git worktree 내에 없음    | `OMC_ALLOW_EXTERNAL_WORKDIR=1` 설정 또는 프로젝트 내부의 working directory 사용                 |
| 출력 파일이 예상 위치에 없음                        | `redirect_output` 정책 활성 상태              | `OMC_MCP_OUTPUT_REDIRECT_DIR` 확인 (기본값: `.omc/outputs`)                                     |

---

## 플랫폼 지원

### 운영 체제

| 플랫폼      | 설치 방법        | 훅 유형        |
| ----------- | ---------------- | -------------- |
| **Windows** | `npm install -g` | Node.js (.mjs) |
| **macOS**   | curl 또는 npm    | Bash (.sh)     |
| **Linux**   | curl 또는 npm    | Bash (.sh)     |

> **참고**: Bash 훅은 macOS와 Linux 간에 완전히 호환됩니다 (GNU 전용 의존성 없음).

> **고급**: macOS/Linux에서 Node.js 훅을 사용하려면 `OMC_USE_NODE_HOOKS=1`을 설정하세요.

### 사용 가능한 도구

| 도구          | 상태         | 설명               |
| ------------- | ------------ | ------------------ |
| **Read**      | ✅ 사용 가능 | 파일 읽기          |
| **Write**     | ✅ 사용 가능 | 파일 생성          |
| **Edit**      | ✅ 사용 가능 | 파일 수정          |
| **Bash**      | ✅ 사용 가능 | 셸 명령어 실행     |
| **Glob**      | ✅ 사용 가능 | 패턴으로 파일 찾기 |
| **Grep**      | ✅ 사용 가능 | 파일 내용 검색     |
| **WebSearch** | ✅ 사용 가능 | 웹 검색            |
| **WebFetch**  | ✅ 사용 가능 | 웹 페이지 가져오기 |
| **Task**      | ✅ 사용 가능 | 서브 에이전트 생성 |
| **TodoWrite** | ✅ 사용 가능 | 작업 추적          |

### LSP 도구 (실제 구현)

| 도구                        | 상태      | 설명                                 |
| --------------------------- | --------- | ------------------------------------ |
| `lsp_hover`                 | ✅ 구현됨 | 위치의 타입 정보 및 문서 가져오기    |
| `lsp_goto_definition`       | ✅ 구현됨 | 심볼 정의로 이동                     |
| `lsp_find_references`       | ✅ 구현됨 | 심볼의 모든 사용처 찾기              |
| `lsp_document_symbols`      | ✅ 구현됨 | 파일 개요 가져오기 (함수, 클래스 등) |
| `lsp_workspace_symbols`     | ✅ 구현됨 | 워크스페이스 전체 심볼 검색          |
| `lsp_diagnostics`           | ✅ 구현됨 | 오류, 경고, 힌트 가져오기            |
| `lsp_prepare_rename`        | ✅ 구현됨 | 이름 변경 가능 여부 확인             |
| `lsp_rename`                | ✅ 구현됨 | 프로젝트 전체 심볼 이름 변경         |
| `lsp_code_actions`          | ✅ 구현됨 | 사용 가능한 리팩토링 가져오기        |
| `lsp_code_action_resolve`   | ✅ 구현됨 | 코드 액션 세부 정보 가져오기         |
| `lsp_servers`               | ✅ 구현됨 | 사용 가능한 언어 서버 목록           |
| `lsp_diagnostics_directory` | ✅ 구현됨 | 프로젝트 수준 타입 검사              |

> **참고**: LSP 도구는 언어 서버가 설치되어 있어야 합니다 (typescript-language-server, pylsp, rust-analyzer, gopls 등). `lsp_servers`를 사용하여 설치 상태를 확인하세요.

### AST 도구 (ast-grep 통합)

| 도구               | 상태      | 설명                                  |
| ------------------ | --------- | ------------------------------------- |
| `ast_grep_search`  | ✅ 구현됨 | AST 매칭을 사용한 패턴 기반 코드 검색 |
| `ast_grep_replace` | ✅ 구현됨 | 패턴 기반 코드 변환                   |

> **참고**: AST 도구는 구조적 코드 매칭을 위해 [@ast-grep/napi](https://ast-grep.github.io/)를 사용합니다. `$VAR` (단일 노드) 및 `$$$` (다중 노드) 같은 메타 변수를 지원합니다.

---

## 성능 모니터링

oh-my-claudecode에는 에이전트 성능, 토큰 사용량 및 병렬 워크플로우 디버깅을 위한 종합 모니터링이 포함되어 있습니다.

전체 문서는 **[성능 모니터링 가이드](../PERFORMANCE-MONITORING.md)**를 참조하세요.

### 간략한 개요

| 기능                    | 설명                                    | 접근 방법                         |
| ----------------------- | --------------------------------------- | --------------------------------- |
| **Agent Observatory**   | 실시간 에이전트 상태, 효율성, 병목 현상 | HUD / API                         |
| **Token Analytics**     | 비용 추적, 사용량 보고서, 예산 경고     | HUD(`analytics` 프리셋), `omc cost` |
| **Session Replay**      | 세션 후 분석을 위한 이벤트 타임라인     | `.omc/state/agent-replay-*.jsonl` |
| **Intervention System** | 정체된 에이전트, 비용 초과 자동 감지    | 자동                              |

### CLI 명령어

```bash
omc                # 기본 분석 대시보드
omc cost daily     # 일일 비용 보고서
omc cost weekly    # 주간 비용 보고서
omc backfill       # 과거 트랜스크립트 데이터 가져오기
# 에이전트 분석: HUD observatory / replay 로그 사용
```

### HUD Analytics 프리셋

상태 표시줄에서 상세 비용 추적을 활성화합니다:

```json
{
  "omcHud": {
    "preset": "analytics"
  }
}
```

### 외부 리소스

- **[MarginLab.ai](https://marginlab.ai)** - Claude 모델 성능 저하를 감지하기 위한 통계적 유의성 테스트가 포함된 SWE-Bench-Pro 성능 추적

---

## 문제 해결

### 설치 문제 진단

```bash
/oh-my-claudecode:omc-doctor
```

다음 항목을 확인합니다:

- 누락된 의존성
- 설정 오류
- 훅 설치 상태
- 에이전트 가용성
- 스킬 등록 상태

### HUD 상태 표시줄 설정

```bash
/oh-my-claudecode:hud setup
```

실시간 상태 업데이트를 위한 HUD 상태 표시줄을 설치 또는 복구합니다.

### HUD 설정 (settings.json)

`~/.claude/settings.json`에서 HUD 요소를 설정합니다:

```json
{
  "omcHud": {
    "preset": "focused",
    "elements": {
      "cwd": true,
      "gitRepo": true,
      "gitBranch": true
    }
  }
}
```

| 요소         | 설명                        | 기본값  |
| ------------ | --------------------------- | ------- |
| `cwd`        | 현재 작업 디렉토리 표시     | `false` |
| `gitRepo`    | git 저장소 이름 표시        | `false` |
| `gitBranch`  | 현재 git 브랜치 표시        | `false` |
| `omcLabel`   | [OMC] 라벨 표시             | `true`  |
| `contextBar` | 컨텍스트 윈도우 사용량 표시 | `true`  |
| `agents`     | 활성 에이전트 수 표시       | `true`  |
| `todos`      | 할 일 진행 상황 표시        | `true`  |
| `ralph`      | ralph 루프 상태 표시        | `true`  |
| `autopilot`  | autopilot 상태 표시         | `true`  |

사용 가능한 프리셋: `minimal`, `focused`, `full`, `dense`, `analytics`, `opencode`

### 일반적인 문제

| 문제                     | 해결 방법                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------ |
| 명령어를 찾을 수 없음    | `/oh-my-claudecode:omc-setup` 재실행                                                 |
| 훅이 실행되지 않음       | 훅 권한 확인: `chmod +x ~/.claude/hooks/**/*.sh`                                     |
| 에이전트가 위임하지 않음 | CLAUDE.md가 로드되었는지 확인: `./.claude/CLAUDE.md` 또는 `~/.claude/CLAUDE.md` 확인 |
| LSP 도구가 작동하지 않음 | 언어 서버 설치: `npm install -g typescript-language-server`                          |
| 토큰 제한 오류           | 토큰 효율적 실행을 위해 `/oh-my-claudecode:` 사용                                    |

### 자동 업데이트

oh-my-claudecode에는 백그라운드에서 업데이트를 확인하는 무음 자동 업데이트 시스템이 포함되어 있습니다.

특징:

- **속도 제한**: 24시간에 최대 1회 확인
- **동시 실행 안전**: 잠금 파일로 동시 업데이트 시도 방지
- **크로스 플랫폼**: macOS와 Linux 모두에서 작동

수동으로 업데이트하려면 플러그인 설치 명령어를 재실행하거나 Claude Code의 내장 업데이트 메커니즘을 사용하세요.

### 제거

```bash
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/scripts/uninstall.sh | bash
```

또는 수동으로:

```bash
rm ~/.claude/agents/{architect,document-specialist,explore,designer,writer,vision,critic,analyst,executor,qa-tester}.md
rm ~/.claude/commands/{analyze,autopilot,deepsearch,plan,review,ultrawork}.md
```

---

## 변경 로그

버전 히스토리 및 릴리스 노트는 [CHANGELOG.md](../../CHANGELOG.md)를 참조하세요.

---

## 라이선스

MIT - [LICENSE](../../LICENSE) 참조

## 크레딧

code-yeongyu의 [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)에서 영감을 받았습니다.
