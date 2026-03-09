[English](README.md) | 한국어 | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)

> **Codex 사용자분들께:** [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)를 확인해보세요 — OpenAI Codex CLI를 위한 동일한 오케스트레이션 경험을 제공합니다.

**Claude Code를 위한 멀티 에이전트 오케스트레이션. 학습 곡선 제로.**

*Claude Code를 배우지 마세요. 그냥 OMC를 쓰세요.*

[시작하기](#빠른-시작) • [문서](https://yeachan-heo.github.io/oh-my-claudecode-website) • [CLI 레퍼런스](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#cli-reference) • [워크플로우](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#workflows) • [마이그레이션 가이드](docs/MIGRATION.md)

---

## 빠른 시작

**Step 1: 설치**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Step 2: 설정**
```bash
/omc-setup
```

**Step 3: 무언가 만들기**
```
autopilot: build a REST API for managing tasks
```

끝입니다. 나머지는 모두 자동입니다.

### 어디서 시작해야 할지 모르겠다면?

요구사항이 불확실하거나, 막연한 아이디어만 있거나, 설계를 세밀하게 관리하고 싶다면:

```
/deep-interview "I want to build a task management app"
```

딥 인터뷰는 소크라테스식 질문법을 사용하여 코드를 작성하기 전에 사고를 명확하게 합니다. 숨겨진 가정을 드러내고 가중치 기반 차원으로 명확성을 측정하여, 실행 시작 전에 무엇을 만들어야 하는지 정확히 알 수 있게 합니다.

## Team Mode (권장)

**v4.1.7**부터 **Team**이 OMC의 표준 오케스트레이션 방식입니다. 레거시 `swarm` 키워드/스킬은 제거되었으니 `team`을 직접 사용하세요.

```bash
/team 3:executor "fix all TypeScript errors"
```

Team은 단계별 파이프라인으로 실행됩니다:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

`~/.claude/settings.json`에서 Claude Code 네이티브 팀을 활성화하세요:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> 팀이 비활성화된 경우 OMC가 경고를 표시하고 가능한 경우 팀 없이 실행으로 폴백합니다.

### tmux CLI 워커 — Codex & Gemini (v4.4.0+)

**v4.4.0에서 Codex/Gemini MCP 서버**(`x`, `g` 프로바이더)가 **제거됩니다**. CLI 우선 Team 런타임(`omc team ...`)으로 tmux 분할 창에서 실제 CLI 프로세스를 실행하세요:

```bash
omc team 2:codex "review auth module for security issues"
omc team 2:gemini "redesign UI components for accessibility"
omc team 1:claude "implement the payment flow"
omc team status auth-review
omc team shutdown auth-review
```

`/omc-teams`는 레거시 호환 스킬로 유지되며, 현재는 내부적으로 `omc team ...`으로 라우팅됩니다.

하나의 명령으로 Codex + Gemini 작업을 처리하려면 **`/ccg`** 스킬을 사용하세요:

```bash
/ccg Review this PR — architecture (Codex) and UI components (Gemini)
```

| 실행 표면 | 워커 | 최적 용도 |
|-------|---------|----------|
| `omc team N:codex "..."` | N개 Codex CLI 창 | 코드 리뷰, 보안 분석, 아키텍처 |
| `omc team N:gemini "..."` | N개 Gemini CLI 창 | UI/UX 디자인, 문서, 대용량 컨텍스트 |
| `omc team N:claude "..."` | N개 Claude CLI 창 | tmux에서 Claude CLI를 통한 일반 작업 |
| `/ccg` | ask-codex + ask-gemini | Codex+Gemini 조언을 Claude가 통합 |

워커는 요청 시 생성되고 작업 완료 후 종료됩니다 — 유휴 리소스 낭비 없음. `codex` / `gemini` CLI가 설치되어 있고 활성 tmux 세션이 필요합니다.

> **참고: 패키지 이름** — 프로젝트 브랜드명은 **oh-my-claudecode** (저장소, 플러그인, 명령어)이지만, npm 패키지는 [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus)로 배포됩니다. npm/bun으로 CLI 도구를 설치할 때는 `npm install -g oh-my-claude-sisyphus`를 사용하세요.

### 업데이트

```bash
# 1. 마켓플레이스 클론 업데이트
/plugin marketplace update omc

# 2. 셋업을 다시 실행하여 설정 갱신
/omc-setup
```

> **참고:** 마켓플레이스 auto-update가 활성화되어 있지 않은 경우, 셋업 실행 전에 `/plugin marketplace update omc`를 수동으로 실행하여 최신 버전을 동기화해야 합니다.

업데이트 후 문제가 발생하면, 이전 플러그인 캐시를 정리하세요:

```bash
/omc-doctor
```

<h1 align="center">당신의 Claude가 스테로이드를 맞았습니다.</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## 왜 oh-my-claudecode인가?

- **설정 불필요** - 똑똑한 기본값으로 바로 작동합니다
- **Team 우선 오케스트레이션** - Team은 표준 멀티 에이전트 인터페이스입니다 (swarm/ultrapilot은 호환성 파사드)
- **자연어 인터페이스** - 외울 명령어 없이, 원하는 것만 설명하세요
- **자동 병렬화** - 복잡한 작업을 전문 에이전트들에게 분산합니다
- **지속적 실행** - 작업이 완전히 검증될 때까지 포기하지 않습니다
- **비용 최적화** - 똑똑한 모델 라우팅으로 토큰을 30-50% 절약합니다
- **경험으로부터 학습** - 문제 해결 패턴을 자동으로 추출하고 재사용합니다
- **실시간 가시성** - HUD 상태바에서 내부에서 무슨 일이 일어나는지 확인하세요

---

## 기능

### 실행 모드
다양한 사용 사례를 위한 여러 전략 - 완전 자율 빌드부터 토큰 효율적인 리팩토링까지. [자세히 보기 →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#execution-modes)

| 모드 | 특징 | 용도 |
|------|---------|---------|
| **Team (권장)** | 단계별 파이프라인 | 공유 작업 목록에서 협력하는 Claude 에이전트 |
| **omc team (CLI)** | tmux CLI 워커 | Codex/Gemini CLI 작업; 요청 시 실행, 완료 후 종료 |
| **ccg** | 트라이-모델 병렬 | Codex(분석) + Gemini(디자인), Claude가 통합 |
| **Autopilot** | 자율 실행 | 최소한의 설정으로 end-to-end 기능 개발 |
| **Ultrawork** | 최대 병렬 | Team이 필요 없는 병렬 수정/리팩토링 |
| **Ralph** | 지속 모드 | 완전히 완료되어야 하는 작업 |
| **Pipeline** | 순차 처리 | 엄격한 순서가 필요한 다단계 변환 |
| **Swarm / Ultrapilot (레거시)** | Team으로 라우팅 | 기존 워크플로우와 이전 문서 |

### 지능형 오케스트레이션

- **32개의 전문 에이전트** - 아키텍처, 연구, 디자인, 테스팅, 데이터 사이언스
- **똑똑한 모델 라우팅** - 간단한 작업엔 Haiku, 복잡한 추론엔 Opus
- **자동 위임** - 매번 작업에 맞는 올바른 에이전트 선택

### 개발자 경험

- **매직 키워드** - 명시적 제어를 위한 `ralph`, `ulw`, `team`
- **HUD 상태바** - 상태바에서 실시간 오케스트레이션 메트릭 확인
- **스킬 학습** - 세션에서 재사용 가능한 패턴 추출
- **분석 및 비용 추적** - 모든 세션의 토큰 사용량 이해

[전체 기능 목록 →](docs/REFERENCE.md)

---

## 매직 키워드

파워 유저를 위한 선택적 단축키. 자연어도 잘 작동합니다.

| 키워드 | 효과 | 예시 |
|---------|--------|---------|
| `team` | 표준 Team 오케스트레이션 | `/team 3:executor "fix all TypeScript errors"` |
| `omc team` | tmux CLI 워커 (codex/gemini/claude) | `omc team 2:codex "security review"` |
| `ccg` | 트라이-모델 Codex+Gemini 오케스트레이션 | `/ccg review this PR` |
| `autopilot` | 완전 자율 실행 | `autopilot: build a todo app` |
| `ralph` | 지속 모드 | `ralph: refactor auth` |
| `ulw` | 최대 병렬화 | `ulw fix all errors` |
| `plan` | 계획 인터뷰 | `plan the API` |
| `ralplan` | 반복적 계획 합의 | `ralplan this feature` |
| `deep-interview` | 소크라테스식 요구사항 명확화 | `deep-interview "vague idea"` |
| `swarm` | **지원 종료** — `team`을 사용하세요 | `swarm 5 agents: fix lint errors` |
| `ultrapilot` | **지원 종료** — `team`을 사용하세요 | `ultrapilot: build a fullstack app` |

**참고:**
- **ralph는 ultrawork를 포함합니다:** ralph 모드를 활성화하면 자동으로 ultrawork의 병렬 실행이 포함됩니다. 키워드를 결합할 필요가 없습니다.
- `/omc-teams`는 레거시 호환 경로로 남아 있으며 내부적으로 `omc team ...`으로 라우팅됩니다.
- `swarm N agents` 구문은 에이전트 수 추출을 위해 여전히 인식되지만, v4.1.7+에서 런타임은 Team 기반입니다.

---

## 유틸리티

### Rate Limit Wait

속도 제한이 리셋될 때 Claude Code 세션을 자동 재개합니다.

```bash
omc wait          # 상태 확인, 가이드 받기
omc wait --start  # 자동 재개 데몬 활성화
omc wait --stop   # 데몬 비활성화
```

**요구사항:** tmux (세션 감지용)

### 알림 태그 설정 (Telegram/Discord/Slack)

stop 콜백이 세션 요약을 보낼 때 태그할 대상을 설정할 수 있습니다.

```bash
# 태그 목록 설정/교체
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"
omc config-stop-callback slack --enable --webhook <url> --tag-list "<!here>,<@U1234567890>"

# 점진적 수정
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

태그 동작:
- Telegram: `alice`는 `@alice`로 정규화됩니다
- Discord: `@here`, `@everyone`, 숫자 사용자 ID, `role:<id>` 지원
- Slack: `<@MEMBER_ID>`, `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^GROUP_ID>` 지원
- `file` 콜백은 태그 옵션을 무시합니다

### OpenClaw 연동

Claude Code 세션 이벤트를 [OpenClaw](https://openclaw.ai/) 게이트웨이로 전달하여 OpenClaw 에이전트를 통한 자동화된 응답 및 워크플로우를 구성할 수 있습니다.

**빠른 설정 (권장):**

```bash
/oh-my-claudecode:configure-notifications
# → 프롬프트에서 "openclaw" 입력 → "OpenClaw Gateway" 선택
```

**수동 설정:** `~/.claude/omc_config.openclaw.json` 파일을 생성합니다:

```json
{
  "enabled": true,
  "gateways": {
    "my-gateway": {
      "url": "https://your-gateway.example.com/wake",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" },
      "method": "POST",
      "timeout": 10000
    }
  },
  "hooks": {
    "session-start": { "gateway": "my-gateway", "instruction": "Session started for {{projectName}}", "enabled": true },
    "stop":          { "gateway": "my-gateway", "instruction": "Session stopping for {{projectName}}", "enabled": true }
  }
}
```

**환경 변수:**

| 변수 | 설명 |
|------|------|
| `OMC_OPENCLAW=1` | OpenClaw 활성화 |
| `OMC_OPENCLAW_DEBUG=1` | 디버그 로그 활성화 |
| `OMC_OPENCLAW_CONFIG=/path/to/config.json` | 설정 파일 경로 변경 |

**지원되는 훅 이벤트 (bridge.ts에서 6개 활성):**

| 이벤트 | 트리거 시점 | 주요 템플릿 변수 |
|--------|------------|-----------------|
| `session-start` | 세션 시작 시 | `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}` |
| `stop` | Claude 응답 완료 시 | `{{sessionId}}`, `{{projectName}}` |
| `keyword-detector` | 프롬프트 제출마다 | `{{prompt}}`, `{{sessionId}}` |
| `ask-user-question` | Claude가 사용자 입력 요청 시 | `{{question}}`, `{{sessionId}}` |
| `pre-tool-use` | 툴 호출 전 (빈도 높음) | `{{toolName}}`, `{{sessionId}}` |
| `post-tool-use` | 툴 호출 후 (빈도 높음) | `{{toolName}}`, `{{sessionId}}` |

**Reply Channel 환경 변수:**

| 변수 | 설명 |
|------|------|
| `OPENCLAW_REPLY_CHANNEL` | 응답 채널 (예: `discord`) |
| `OPENCLAW_REPLY_TARGET` | 채널 ID |
| `OPENCLAW_REPLY_THREAD` | 스레드 ID |

OpenClaw 페이로드를 ClawdBot을 통해 Discord에 전달하는 레퍼런스 게이트웨이는 `scripts/openclaw-gateway-demo.mjs`를 참고하세요.

---

## 문서

- **[전체 레퍼런스](docs/REFERENCE.md)** - 완전한 기능 문서
- **[CLI 레퍼런스](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#cli-reference)** - 모든 `omc` 명령어, 플래그 및 도구
- **[알림 가이드](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#notifications)** - Discord, Telegram, Slack 및 webhook 설정
- **[추천 워크플로우](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#workflows)** - 일반 작업을 위한 검증된 스킬 체인
- **[릴리스 노트](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#release-notes)** - 각 버전의 새로운 기능
- **[웹사이트](https://yeachan-heo.github.io/oh-my-claudecode-website)** - 인터랙티브 가이드와 예제
- **[마이그레이션 가이드](docs/MIGRATION.md)** - v2.x에서 업그레이드
- **[아키텍처](docs/ARCHITECTURE.md)** - 내부 작동 원리
- **[성능 모니터링](docs/PERFORMANCE-MONITORING.md)** - 에이전트 추적, 디버깅 및 최적화

---

## 요구사항

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Claude Max/Pro 구독 또는 Anthropic API 키

### 선택사항: 멀티 AI 오케스트레이션

OMC는 교차 검증과 디자인 일관성을 위해 외부 AI 제공자를 선택적으로 활용할 수 있습니다. **필수가 아닙니다** — OMC는 이것들 없이도 완벽하게 작동합니다.

| 제공자 | 설치 | 활용 |
|--------|------|------|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | 디자인 리뷰, UI 일관성 (1M 토큰 컨텍스트) |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` | 아키텍처 검증, 코드 리뷰 교차 확인 |

**비용:** 3개 Pro 플랜 (Claude + Gemini + ChatGPT)으로 월 ~$60에 모든 것을 커버합니다.

---

## 라이선스

MIT

---

<div align="center">

**영감을 받은 프로젝트:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code) • [Ouroboros](https://github.com/Q00/ouroboros)

**학습 곡선 제로. 최대 파워.**

</div>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)

## 💖 이 프로젝트 후원하기

Oh-My-ClaudeCode가 당신의 워크플로우에 도움이 된다면, 후원을 고려해주세요:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/Yeachan-Heo)

### 왜 후원해야 하나요?

- 활발한 개발 유지
- 후원자를 위한 우선 지원
- 로드맵 및 기능에 영향력 행사
- 무료 오픈소스 유지 지원

### 다른 도움 방법

- ⭐ 리포지토리에 Star 주기
- 🐛 버그 리포트
- 💡 기능 제안
- 📝 코드 기여
