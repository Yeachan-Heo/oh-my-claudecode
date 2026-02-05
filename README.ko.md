[English](README.md) | 한국어 | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)

**Claude Code를 위한 멀티 에이전트 오케스트레이션. 학습 곡선 제로.**

*Claude Code를 배우지 마세요. 그냥 OMC를 쓰세요.*

[시작하기](#빠른-시작) • [문서](https://yeachan-heo.github.io/oh-my-claudecode-website) • [마이그레이션 가이드](docs/MIGRATION.md)

---

## 빠른 시작

**Step 1: 설치**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Step 2: 설정**
```bash
/oh-my-claudecode:omc-setup
```

**Step 3: 무언가 만들기**
```
autopilot: build a REST API for managing tasks
```

끝입니다. 나머지는 모두 자동입니다.

<h1 align="center">당신의 Claude가 스테로이드를 맞았습니다.</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## 왜 oh-my-claudecode인가?

- **설정 불필요** - 똑똑한 기본값으로 바로 작동합니다
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

| 모드 | 속도 | 용도 |
|------|-------|---------|
| **Autopilot** | 빠름 | 완전 자율 워크플로우 |
| **Ultrawork** | 병렬 | 모든 작업에 최대 병렬화 |
| **Ralph** | 지속적 | 반드시 완료해야 하는 작업 |
| **Ultrapilot** | 3-5배 빠름 | 다중 컴포넌트 시스템 |
| **Ecomode** | 빠름 + 30-50% 저렴 | 예산을 고려한 프로젝트 |
| **Swarm** | 협조적 | 병렬 독립 작업 |
| **Pipeline** | 순차적 | 다단계 처리 |

### 지능형 오케스트레이션

- **32개의 전문 에이전트** - 아키텍처, 연구, 디자인, 테스팅, 데이터 사이언스
- **똑똑한 모델 라우팅** - 간단한 작업엔 Haiku, 복잡한 추론엔 Opus
- **자동 위임** - 매번 작업에 맞는 올바른 에이전트 선택

### 개발자 경험

- **매직 키워드** - 명시적 제어를 위한 `ralph`, `ulw`, `eco`, `plan`
- **HUD 상태바** - 상태바에서 실시간 오케스트레이션 메트릭 확인
- **스킬 학습** - 세션에서 재사용 가능한 패턴 추출
- **분석 및 비용 추적** - 모든 세션의 토큰 사용량 이해

[전체 기능 목록 →](docs/REFERENCE.md)

---

## 매직 키워드

파워 유저를 위한 선택적 단축키. 자연어도 잘 작동합니다.

| 키워드 | 효과 | 예시 |
|---------|--------|---------|
| `autopilot` | 완전 자율 실행 | `autopilot: build a todo app` |
| `ralph` | 지속 모드 | `ralph: refactor auth` |
| `ulw` | 최대 병렬화 | `ulw fix all errors` |
| `eco` | 토큰 효율적 실행 | `eco: migrate database` |
| `plan` | 계획 인터뷰 | `plan the API` |
| `ralplan` | 반복적 계획 합의 | `ralplan this feature` |

**ralph는 ultrawork를 포함합니다:** ralph 모드를 활성화하면 자동으로 ultrawork의 병렬 실행이 포함됩니다. 키워드를 결합할 필요가 없습니다.

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

---

## 문서

- **[전체 레퍼런스](docs/REFERENCE.md)** - 완전한 기능 문서
- **[성능 모니터링](docs/PERFORMANCE-MONITORING.md)** - 에이전트 추적, 디버깅 및 최적화
- **[웹사이트](https://yeachan-heo.github.io/oh-my-claudecode-website)** - 인터랙티브 가이드와 예제
- **[마이그레이션 가이드](docs/MIGRATION.md)** - v2.x에서 업그레이드
- **[아키텍처](docs/ARCHITECTURE.md)** - 내부 작동 원리

---

## 요구사항

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Claude Max/Pro 구독 또는 Anthropic API 키

---

## 라이선스

MIT

---

<div align="center">

**영감을 받은 프로젝트:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/NexTechFusion/Superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code)

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
