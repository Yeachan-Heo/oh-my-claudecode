# 마이그레이션 가이드

이 가이드는 oh-my-claudecode의 모든 마이그레이션 경로를 다룹니다. 아래에서 현재 사용 중인 버전을 찾아주세요.

---

## 목차

- [v3.5.3 → v3.5.5: 테스트 수정 및 정리](#v353--v355-테스트-수정--정리)
- [v3.5.2 → v3.5.3: 스킬 통합](#v352--v353-스킬-통합)
- [v2.x → v3.0: 패키지 리네이밍 및 자동 활성화](#v2x--v30-패키지-리네이밍--자동-활성화)
- [v3.0 → v3.1: Notepad Wisdom 및 향상된 기능](#v30--v31-notepad-wisdom--향상된-기능)
- [v3.x → v4.0: 주요 아키텍처 개편](#v3x--v40-주요-아키텍처-개편)

---

## v3.5.3 → v3.5.5: 테스트 수정 및 정리

### 요약

테스트 스위트 문제를 수정하고 v3.5.3의 스킬 통합을 이어가는 유지보수 릴리스입니다.

### 변경 사항

**테스트 수정:**

- delegation-enforcer 테스트를 스킵 처리 (구현 대기 중)
- 에이전트 어트리뷰션에 대한 분석 기대값 수정
- 나머지 모든 테스트가 정상적으로 통과

**스킬 통합:**

- v3.5.3의 정리 작업 계속 진행
- 폐기된 `cancel-*` 스킬 제거 (대신 `/cancel` 사용)
- 최종 스킬 수: 37개 코어 스킬

### 마이그레이션 단계

1. **호환성 파괴 변경 없음** - 모든 기능이 그대로 유지됩니다
2. **테스트 스위트**가 `npm run test:run`으로 정상 실행됩니다
3. **폐기된 스킬**이 제거되었습니다 (v3.5.3에서 이미 대체 완료)

### 개발자 참고 사항

폐기된 `cancel-*` 스킬에 의존하고 있었다면, 활성 모드를 자동 감지하는 통합 `/cancel` 명령어로 업데이트하세요.

---

## v3.5.2 → v3.5.3: 스킬 통합

### 요약

8개의 폐기된 스킬이 제거되었습니다. 통합된 `/cancel` 및 `/omc-setup` 명령어가 이를 대체합니다.

### 제거된 스킬

다음 스킬들이 v3.5.3에서 **완전히 제거**되었습니다:

| 제거된 스킬          | 대체 명령어                            |
| -------------------- | -------------------------------------- |
| `cancel-autopilot`   | `/oh-my-claudecode:cancel`             |
| `cancel-ralph`       | `/oh-my-claudecode:cancel`             |
| `cancel-ultrawork`   | `/oh-my-claudecode:cancel`             |
| `cancel-ultraqa`     | `/oh-my-claudecode:cancel`             |
| `cancel-`            | `/oh-my-claudecode:cancel`             |
| `omc-default`        | `/oh-my-claudecode:omc-setup --local`  |
| `omc-default-global` | `/oh-my-claudecode:omc-setup --global` |
| `planner`            | `/oh-my-claudecode:plan`               |

### 변경 사항

**v3.5.3 이전:**

```bash
/oh-my-claudecode:cancel-ralph      # ralph만 취소
/oh-my-claudecode:omc-default       # 로컬 프로젝트 설정
/oh-my-claudecode:planner "task"    # 플래닝 시작
```

**v3.5.3 이후:**

```bash
/oh-my-claudecode:cancel            # 활성 모드를 자동 감지하여 취소
/oh-my-claudecode:omc-setup --local # 로컬 프로젝트 설정
/oh-my-claudecode:plan "task"       # 플래닝 시작 (인터뷰 모드 포함)
```

### 새로운 기능

**새 스킬: `/learn-about-omc`**

- OMC 사용 패턴을 분석합니다
- 개인화된 추천을 제공합니다
- 활용도가 낮은 기능을 식별합니다

**plan 스킬이 이제 consensus 모드를 지원합니다:**

```bash
/oh-my-claudecode:plan --consensus "task"  # critic 리뷰가 포함된 반복적 플래닝
/oh-my-claudecode:ralplan "task"           # plan --consensus의 별칭
```

### 마이그레이션 단계

1. **별도 작업 불필요** - 통합 `/cancel` 명령어는 이미 v3.5에서 작동했습니다
2. 제거된 명령어를 참조하는 **스크립트를 업데이트**하세요
3. CLAUDE.md 설정을 업데이트하려면 **`/omc-setup`을 재실행**하세요

### 스킬 수

- v3.5: 42개 스킬
- v3.5.3: 37개 스킬 (8개 제거, 3개 추가)

---

## v2.x → v3.0: 패키지 리네이밍 및 자동 활성화

### 요약

기존 명령어는 그대로 작동합니다! 하지만 이제는 명령어가 필요 없습니다.

**3.0 이전:** `/oh-my-claudecode:ralph "task"`, `/oh-my-claudecode:ultrawork "task"` 등 25개 이상의 명령어를 명시적으로 호출

**3.0 이후:** 자연스럽게 작업하면 Claude가 자동으로 적절한 동작을 활성화합니다. 최초 설정: "setup omc"라고 말하기만 하면 됩니다

### 프로젝트 리브랜딩

프로젝트의 목적을 더 잘 반영하고 검색성을 개선하기 위해 리브랜딩되었습니다.

- **프로젝트/브랜드명**: `oh-my-claudecode` (GitHub 저장소, 플러그인명, 명령어)
- **npm 패키지명**: `oh-my-claude-sisyphus` (변경 없음)

> **왜 이름이 다른가요?** npm 패키지명 `oh-my-claude-sisyphus`는 기존 설치와의 하위 호환성을 위해 유지되었습니다. 프로젝트, GitHub 저장소, 플러그인 및 모든 명령어는 `oh-my-claudecode`를 사용합니다.

#### NPM 설치 명령어 (변경 없음)

```bash
npm install -g oh-my-claude-sisyphus
```

### 변경 사항

#### 이전 (2.x): 명시적 명령어

각 모드에 대해 특정 명령어를 기억하고 명시적으로 호출해야 했습니다:

```bash
# 2.x 워크플로우: 여러 명령어, 기억해야 할 것이 많음
/oh-my-claudecode:ralph "implement user authentication"       # 지속성 모드
/oh-my-claudecode:ultrawork "refactor the API layer"          # 최대 병렬 처리
/oh-my-claudecode:planner "plan the new dashboard"            # 플래닝 인터뷰
/oh-my-claudecode:deepsearch "find database schema files"     # 딥 서치
/oh-my-claudecode:git-master "commit these changes"           # Git 전문가
/oh-my-claudecode:deepinit ./src                              # 코드베이스 인덱싱
/oh-my-claudecode:analyze "why is this test failing?"         # 심층 분석
```

#### 이후 (3.0): 자동 활성화 + 키워드

자연스럽게 작업하세요. Claude가 의도를 감지하여 자동으로 동작을 활성화합니다:

```bash
# 3.0 워크플로우: 자연스럽게 말하거나 선택적으로 키워드 사용
"don't stop until user auth is done"                # ralph-loop 자동 활성화
"fast: refactor the entire API layer"               # ultrawork 자동 활성화
"plan: design the new dashboard"                    # 플래닝 자동 활성화
"ralph ulw: migrate the database"                   # 결합: 지속성 + 병렬 처리
"find all database schema files"                    # 검색 모드 자동 활성화
"commit these changes properly"                     # Git 전문가 자동 활성화
```

### 에이전트 이름 매핑

모든 에이전트 이름이 그리스 신화 참조에서 직관적이고 설명적인 이름으로 업데이트되었습니다:

| 이전 이름 (그리스 신화) | 새 이름 (직관적)      |
| ----------------------- | --------------------- |
| prometheus              | planner               |
| momus                   | critic                |
| oracle                  | architect             |
| metis                   | analyst               |
| mnemosyne               | learner               |
| sisyphus-junior         | executor              |
| orchestrator-sisyphus   | coordinator           |
| librarian               | document-specialist   |
| frontend-engineer       | designer              |
| document-writer         | writer                |
| multimodal-looker       | vision                |
| explore                 | explore (변경 없음)   |
| qa-tester               | qa-tester (변경 없음) |

### 디렉토리 마이그레이션

새 패키지명과의 일관성을 위해 디렉토리 구조가 변경되었습니다:

#### 로컬 프로젝트 디렉토리

- **이전**: `.sisyphus/`
- **이후**: `.omc/`

#### 글로벌 디렉토리

- **이전**: `~/.sisyphus/`
- **이후**: `~/.omc/`

#### 스킬 디렉토리

- **이전**: `~/.claude/skills/sisyphus-learned/`
- **이후**: `~/.claude/skills/omc-learned/`

#### 설정 파일

- **이전**: `~/.claude/sisyphus/mnemosyne.json`
- **이후**: `~/.claude/omc/learner.json`

### 환경 변수

모든 환경 변수가 `SISYPHUS_*`에서 `OMC_*`로 변경되었습니다:

| 이전                          | 이후                     |
| ----------------------------- | ------------------------ |
| SISYPHUS_USE_NODE_HOOKS       | OMC_USE_NODE_HOOKS       |
| SISYPHUS_USE_BASH_HOOKS       | OMC_USE_BASH_HOOKS       |
| SISYPHUS_PARALLEL_EXECUTION   | OMC_PARALLEL_EXECUTION   |
| SISYPHUS_LSP_TOOLS            | OMC_LSP_TOOLS            |
| SISYPHUS_MAX_BACKGROUND_TASKS | OMC_MAX_BACKGROUND_TASKS |
| SISYPHUS_ROUTING_ENABLED      | OMC_ROUTING_ENABLED      |
| SISYPHUS_ROUTING_DEFAULT_TIER | OMC_ROUTING_DEFAULT_TIER |
| SISYPHUS_ESCALATION_ENABLED   | OMC_ESCALATION_ENABLED   |
| SISYPHUS_DEBUG                | OMC_DEBUG                |

### 명령어 매핑

모든 2.x 명령어는 계속 작동합니다. 변경 사항은 다음과 같습니다:

| 2.x 명령어                             | 3.0 동등 표현                                              | 작동 여부           |
| -------------------------------------- | ---------------------------------------------------------- | ------------------- |
| `/oh-my-claudecode:ralph "task"`       | "don't stop until done"이라고 말하거나 `ralph` 키워드 사용 | ✅ 예 (양쪽 모두)   |
| `/oh-my-claudecode:ultrawork "task"`   | "fast" 또는 "parallel"이라고 말하거나 `ulw` 키워드 사용    | ✅ 예 (양쪽 모두)   |
| `/oh-my-claudecode:ultrawork-ralph`    | "ralph ulw:" 접두사 사용                                   | ✅ 예 (키워드 조합) |
| `/oh-my-claudecode:planner "task"`     | "plan this"라고 말하거나 `plan` 키워드 사용                | ✅ 예 (양쪽 모두)   |
| `/oh-my-claudecode:plan "description"` | 자연스럽게 플래닝 시작                                     | ✅ 예               |
| `/oh-my-claudecode:review [path]`      | 기존과 동일하게 호출                                       | ✅ 예 (변경 없음)   |
| `/oh-my-claudecode:deepsearch "query"` | "find" 또는 "search"라고 말하기                            | ✅ 예 (자동 감지)   |
| `/oh-my-claudecode:analyze "target"`   | "analyze"라고 말하기 — debugger/architect 에이전트로 라우팅 | ✅ 예 (키워드 라우트) |
| `/oh-my-claudecode:deepinit [path]`    | 기존과 동일하게 호출                                       | ✅ 예 (변경 없음)   |
| `/oh-my-claudecode:git-master`         | "git", "commit", "atomic commit"이라고 말하기              | ✅ 예 (자동 감지)   |
| `/oh-my-claudecode:frontend-ui-ux`     | "UI", "styling", "component", "design"이라고 말하기        | ✅ 예 (자동 감지)   |
| `/oh-my-claudecode:note "content"`     | "remember this" 또는 "save this"라고 말하기                | ✅ 예 (자동 감지)   |
| `/oh-my-claudecode:cancel-ralph`       | "stop", "cancel" 또는 "abort"라고 말하기                   | ✅ 예 (자동 감지)   |
| `/oh-my-claudecode:omc-doctor`         | 기존과 동일하게 호출                                       | ✅ 예 (변경 없음)   |
| 기타 모든 명령어                       | 이전과 동일하게 작동                                       | ✅ 예               |

### 매직 키워드

메시지 어디에든 이 키워드를 포함하면 명시적으로 동작을 활성화할 수 있습니다. 명시적 제어가 필요할 때 키워드를 사용하세요 (선택 사항):

| 키워드              | 효과                                    | 예시                              |
| ------------------- | --------------------------------------- | --------------------------------- |
| `ralph`             | 지속성 모드 - 완료될 때까지 멈추지 않음 | "ralph: refactor the auth system" |
| `ralplan`           | 합의를 통한 반복적 플래닝               | "ralplan: add OAuth support"      |
| `ulw` / `ultrawork` | 최대 병렬 실행                          | "ulw: fix all type errors"        |
| `plan`              | 플래닝 인터뷰                           | "plan: new API design"            |

**ralph에는 ultrawork가 포함됩니다:**

```
ralph: migrate the entire database
    ↓
지속성 (멈추지 않음) + ultrawork (최대 병렬 처리) 내장
```

**키워드 없이도?** Claude가 자동으로 감지합니다:

```
"don't stop until this works"      # ralph 트리거
"fast, I'm in a hurry"             # ultrawork 트리거
"help me design the dashboard"     # 플래닝 트리거
```

### 자연스러운 취소

다음 중 아무거나 말하면 중단할 수 있습니다:

- "stop"
- "cancel"
- "abort"
- "nevermind"
- "enough"
- "halt"

Claude가 지능적으로 무엇을 중단할지 판단합니다:

```
ralph-loop 중이라면    → 지속성 루프 종료
ultrawork 중이라면     → 일반 모드로 복귀
플래닝 중이라면        → 플래닝 인터뷰 종료
여러 개가 활성 중이면  → 가장 최근 것을 중단
```

더 이상 `/oh-my-claudecode:cancel-ralph`이 필요 없습니다 - 그냥 "cancel"이라고 말하세요!

### 마이그레이션 단계

기존 설정을 마이그레이션하려면 다음 단계를 따르세요:

#### 1. 이전 패키지 제거 (npm으로 설치한 경우)

```bash
npm uninstall -g oh-my-claude-sisyphus
```

#### 2. 플러그인 시스템으로 설치 (필수)

```bash
# Claude Code에서:
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

> **참고**: npm/bun 글로벌 설치는 더 이상 지원되지 않습니다. 플러그인 시스템을 사용하세요.

#### 3. 로컬 프로젝트 디렉토리 이름 변경

이전 디렉토리 구조를 사용하는 기존 프로젝트가 있다면:

```bash
# 각 프로젝트 디렉토리에서
mv .sisyphus .omc
```

#### 4. 글로벌 디렉토리 이름 변경

```bash
# 글로벌 설정 디렉토리
mv ~/.sisyphus ~/.omc

# 스킬 디렉토리
mv ~/.claude/skills/sisyphus-learned ~/.claude/skills/omc-learned

# 설정 디렉토리
mv ~/.claude/sisyphus ~/.claude/omc
```

#### 5. 환경 변수 업데이트

셸 설정 파일 (`.bashrc`, `.zshrc` 등)을 업데이트하세요:

```bash
# 모든 SISYPHUS_* 변수를 OMC_*로 변경
# 예시:
# 이전: export SISYPHUS_ROUTING_ENABLED=true
# 이후: export OMC_ROUTING_ENABLED=true
```

#### 6. 스크립트 및 설정 업데이트

다음 항목에 대한 참조를 검색하여 업데이트하세요:

- 패키지명: `oh-my-claude-sisyphus` → `oh-my-claudecode`
- 에이전트 이름: 위의 매핑 테이블 사용
- 명령어: 새로운 슬래시 명령어 사용
- 디렉토리 경로: `.sisyphus` → `.omc` 업데이트

#### 7. 최초 설정 실행

Claude Code에서 "setup omc", "omc setup" 또는 이에 해당하는 자연어 표현을 사용하세요.

이 작업은 다음을 수행합니다:

- 최신 CLAUDE.md 다운로드
- 32개 에이전트 설정
- 자동 동작 감지 활성화
- 연속 실행 강제 활성화
- 스킬 조합 설정

### 검증

마이그레이션 후 설정을 확인하세요:

1. **설치 확인**:

   ```bash
   npm list -g oh-my-claude-sisyphus
   ```

2. **디렉토리 존재 확인**:

   ```bash
   ls -la .omc/  # 프로젝트 디렉토리에서
   ls -la ~/.omc/  # 글로벌 디렉토리
   ```

3. **간단한 명령어 테스트**:
   Claude Code에서 `/oh-my-claudecode:omc-help`를 실행하여 플러그인이 올바르게 로드되었는지 확인하세요.

### 3.0의 새로운 기능

#### 1. 제로 러닝 커브 운영

**명령어를 외울 필요가 없습니다.** 자연스럽게 작업하세요:

```
이전: "OK, ultrawork를 사용하려면 /oh-my-claudecode:ultrawork를 써야지..."
이후: "빨리 해줘!"
      ↓
      Claude: "ultrawork 모드를 활성화합니다..."
```

#### 2. 항상 위임 (자동)

복잡한 작업은 자동으로 전문 에이전트에게 라우팅됩니다:

```
사용자의 요청               Claude의 행동
────────────────────     ────────────────────
"데이터베이스 리팩토링해줘"  → architect에게 위임
"UI 색상 수정해줘"          → designer에게 위임
"이 API 문서화해줘"         → writer에게 위임
"모든 오류 찾아줘"          → explore에게 위임
"이 크래시 디버깅해줘"      → architect에게 위임
```

위임을 요청할 필요 없습니다 - 자동으로 이루어집니다.

#### 3. 학습된 스킬 (`/oh-my-claudecode:learner`)

문제 해결 과정에서 재사용 가능한 인사이트를 추출합니다:

```bash
# 어려운 버그를 해결한 후:
"이것을 스킬로 추출해줘"
    ↓
Claude가 패턴을 학습하고 저장
    ↓
다음에 키워드가 매칭되면 → 솔루션 자동 주입
```

저장 위치:

- **프로젝트 레벨**: `.omc/skills/` (버전 관리됨)
- **사용자 레벨**: `~/.claude/skills/omc-learned/` (이식 가능)

#### 4. HUD 상태 표시줄 (실시간 오케스트레이션)

상태 바에서 Claude가 무엇을 하고 있는지 확인하세요:

```
[OMC] ralph:3/10 | US-002 | ultrawork skill:planner | ctx:67% | agents:2 | todos:2/5
```

설치하려면 `/oh-my-claudecode:hud setup`을 실행하세요. 프리셋: minimal, focused, full.

#### 5. 3단계 메모리 시스템

중요한 지식이 컨텍스트 압축에서도 살아남습니다:

```
<remember priority>API client at src/api/client.ts</remember>
    ↓
세션 시작 시 영구적으로 로드
    ↓
압축을 통해서도 절대 유실되지 않음
```

또는 `/oh-my-claudecode:note`를 사용하여 발견한 것을 수동으로 저장할 수 있습니다:

```bash
/oh-my-claudecode:note Project uses PostgreSQL with Prisma ORM
```

#### 6. 구조화된 작업 추적 (PRD 지원)

**Ralph Loop이 이제 제품 요구사항 문서를 사용합니다:**

```bash
/oh-my-claudecode:ralph-init "implement OAuth with multiple providers"
    ↓
사용자 스토리가 포함된 PRD 자동 생성
    ↓
각 스토리: 설명 + 수락 기준 + 통과/실패
    ↓
모든 스토리가 통과할 때까지 Ralph가 반복
```

#### 7. 지능형 연속 실행

**Claude가 멈추기 전에 작업이 완료됩니다:**

```
사용자: "사용자 대시보드 구현해줘"
    ↓
Claude: "완료를 보장하기 위해 ralph-loop을 활성화합니다"
    ↓
할 일 목록을 생성하고 각 항목을 처리
    ↓
모든 것이 검증 완료되어야만 중단
```

### 하위 호환성 안내

**참고**: v3.0은 v2.x 네이밍과의 하위 호환성을 유지하지 않습니다. 새 버전이 올바르게 작동하려면 위의 마이그레이션 단계를 완료해야 합니다.

---

## v3.0 → v3.1: Notepad Wisdom 및 향상된 기능

### 개요

버전 3.1은 v3.0과의 완전한 하위 호환성을 유지하면서 강력한 새 기능을 추가하는 마이너 릴리스입니다.

### 새로운 기능

#### 1. Notepad Wisdom 시스템

플랜 범위의 지식 캡처 시스템으로 학습 사항, 결정 사항, 이슈 및 문제를 기록합니다.

**위치:** `.omc/notepads/{plan-name}/`

| 파일           | 용도                     |
| -------------- | ------------------------ |
| `learnings.md` | 기술적 발견 및 패턴      |
| `decisions.md` | 아키텍처 및 설계 결정    |
| `issues.md`    | 알려진 이슈 및 해결 방법 |
| `problems.md`  | 차단 요소 및 과제        |

**API:**

- `initPlanNotepad()` - 플랜용 노트패드 초기화
- `addLearning()` - 기술적 발견 기록
- `addDecision()` - 아키텍처 선택 기록
- `addIssue()` - 알려진 이슈 기록
- `addProblem()` - 차단 요소 기록
- `getWisdomSummary()` - 모든 지식의 요약 조회
- `readPlanWisdom()` - 컨텍스트를 위한 전체 지식 읽기

#### 2. 위임 카테고리

모델 티어, 온도 및 사고 예산에 자동으로 매핑되는 시맨틱 작업 분류 시스템입니다.

| 카테고리             | 티어   | 온도 | 사고 수준 | 용도                               |
| -------------------- | ------ | ---- | --------- | ---------------------------------- |
| `visual-engineering` | HIGH   | 0.7  | high      | UI/UX, 프론트엔드, 디자인 시스템   |
| `ultrabrain`         | HIGH   | 0.3  | max       | 복잡한 추론, 아키텍처, 심층 디버깅 |
| `artistry`           | MEDIUM | 0.9  | medium    | 창의적 솔루션, 브레인스토밍        |
| `quick`              | LOW    | 0.1  | low       | 간단한 조회, 기본 작업             |
| `writing`            | MEDIUM | 0.5  | medium    | 문서화, 기술 문서 작성             |

**자동 감지:** 프롬프트 키워드에서 카테고리가 자동으로 감지됩니다.

#### 3. 디렉토리 진단 도구

`lsp_diagnostics_directory` 도구를 통한 프로젝트 수준 타입 검사입니다.

**전략:**

- `auto` (기본값) - 최적의 전략을 자동 선택, tsconfig.json이 있으면 tsc 우선
- `tsc` - 빠름, TypeScript 컴파일러 사용
- `lsp` - 폴백, Language Server를 통해 파일 반복

**용도:** 커밋 전이나 리팩토링 후 전체 프로젝트의 오류를 확인합니다.

#### 4. 세션 재개

`resume-session` 도구를 통해 백그라운드 에이전트를 전체 컨텍스트와 함께 재개할 수 있습니다.

### 마이그레이션 단계

버전 3.1은 바로 적용 가능한 업그레이드입니다. 마이그레이션이 필요 없습니다!

```bash
npm update -g oh-my-claude-sisyphus
```

기존의 모든 설정, 플랜 및 워크플로우가 변경 없이 계속 작동합니다.

### 새로 사용 가능한 도구

업그레이드 후 에이전트가 자동으로 다음에 접근할 수 있습니다:

- Notepad wisdom API (실행 중 지식 읽기/쓰기)
- 위임 카테고리 (자동 분류)
- 디렉토리 진단 (프로젝트 수준 타입 검사)
- 세션 재개 (백그라운드 에이전트 상태 복구)

---

## v3.3.x → v3.4.0: 병렬 실행 및 고급 워크플로우

### 개요

버전 3.4.0은 v3.3.x와의 완전한 하위 호환성을 유지하면서 강력한 병렬 실행 모드와 고급 워크플로우 오케스트레이션을 도입합니다.

### 새로운 기능

#### 1. ultrapilot: 병렬 autopilot

최대 5개의 동시 워커로 복잡한 작업을 3-5배 빠르게 실행합니다:

```bash
/oh-my-claudecode:ultrapilot "build a fullstack todo app"
```

**주요 기능:**

- 병렬화 가능한 하위 작업으로의 자동 작업 분해
- 충돌을 방지하는 파일 소유권 조정
- 지능적 조정을 통한 병렬 실행
- 상태 파일: `.omc/state/ultrapilot-state.json`, `.omc/state/ultrapilot-ownership.json`

**적합한 경우:** 멀티 컴포넌트 시스템, 풀스택 앱, 대규모 리팩토링

#### 2. swarm: 조정된 에이전트 팀

원자적 작업 클레이밍을 가진 N개의 조정된 에이전트:

```bash
/oh-my-claudecode:swarm 5:executor "fix all TypeScript errors"
```

**주요 기능:**

- 원자적 클레이밍이 있는 공유 작업 풀 (중복 작업 방지)
- 작업당 5분 타임아웃 및 자동 해제
- 2개에서 10개 워커까지 확장 가능
- 모든 작업 완료 시 깔끔한 종료

#### 3. pipeline: 순차적 에이전트 체이닝

스테이지 간 데이터 전달을 가진 에이전트 체이닝:

```bash
/oh-my-claudecode:pipeline explore:haiku -> architect:opus -> executor:sonnet
```

**내장 프리셋:**

- `review` - explore → architect → critic → executor
- `implement` - planner → executor → tdd-guide
- `debug` - explore → architect → debugger
- `research` - parallel(document-specialist, explore) → architect → writer
- `refactor` - explore → architect-medium → executor-high → qa-tester
- `security` - explore → security-reviewer → executor → security-reviewer-low

#### 4. ecomode: 토큰 효율적 실행

30-50%의 토큰 절약과 함께 최대 병렬 처리:

```bash
/oh-my-claudecode: "refactor the authentication system"
```

**스마트 모델 라우팅:**

- 간단한 작업 → Haiku (초저가)
- 일반 작업 → Sonnet (균형)
- 복잡한 추론 → Opus (필요시)

#### 5. 통합 cancel 명령어

활성 모드를 자동 감지하는 스마트 취소:

```bash
/oh-my-claudecode:cancel
# 또는 그냥: "stop", "cancel", "abort"
```

**자동 감지 및 취소:** autopilot, ultrapilot, ralph, ultrawork, ultraqa, swarm, pipeline

**폐기 안내:**
개별 취소 명령어는 폐기되었지만 여전히 작동합니다:

- `/oh-my-claudecode:cancel-ralph` (폐기됨)
- `/oh-my-claudecode:cancel-ultraqa` (폐기됨)
- `/oh-my-claudecode:cancel-ultrawork` (폐기됨)
- `/oh-my-claudecode:cancel-` (폐기됨)
- `/oh-my-claudecode:cancel-autopilot` (폐기됨)

대신 `/oh-my-claudecode:cancel`을 사용하세요.

#### 6. explore-high 에이전트

복잡한 코드베이스 탐색을 위한 Opus 기반 아키텍처 검색:

```typescript
Task(
  (subagent_type = "oh-my-claudecode:explore-high"),
  (model = "opus"),
  (prompt = "Find all authentication-related code patterns..."),
);
```

**적합한 경우:** 아키텍처 분석, 교차 관심사, 복잡한 리팩토링 계획

#### 7. 상태 관리 표준화

상태 파일이 이제 표준화된 경로를 사용합니다:

**표준 경로:**

- 로컬: `.omc/state/{name}.json`
- 글로벌: `~/.omc/state/{name}.json`

레거시 위치는 읽기 시 자동 마이그레이션됩니다.

#### 8. 키워드 충돌 해결

여러 실행 모드 키워드가 있을 때:

**충돌 해결 우선순위:**
| 우선순위 | 조건 | 결과 |
|----------|-----------|--------|
| 1 (최고) | 명시적 키워드가 둘 다 있는 경우 (예: "ulw eco fix errors") | ``가 우선 (토큰 제한이 더 엄격) |
| 2 | 명시적 키워드가 하나인 경우 | 해당 모드가 우선 |
| 3 | "fast"/"parallel"만 있는 경우 | 설정에서 읽기 (`defaultExecutionMode`) |
| 4 (최저) | 설정 파일 없음 | `ultrawork`가 기본값 |

**명시적 모드 키워드:** `ulw`, `ultrawork`, `eco`, ``**일반 키워드:**`fast`, `parallel`

사용자는 `/oh-my-claudecode:omc-setup`을 통해 기본 모드 선호도를 설정할 수 있습니다.

### 마이그레이션 단계

버전 3.4.0은 바로 적용 가능한 업그레이드입니다. 마이그레이션이 필요 없습니다!

```bash
npm update -g oh-my-claude-sisyphus
```

기존의 모든 설정, 플랜 및 워크플로우가 변경 없이 계속 작동합니다.

### 새로운 설정 옵션

#### 기본 실행 모드

`~/.claude/.omc-config.json`에서 선호하는 실행 모드를 설정하세요:

```json
{
  "defaultExecutionMode": "ultrawork" // 또는 ""
}
```

명시적 모드 키워드 없이 "fast"나 "parallel" 같은 일반 키워드를 사용하면 이 설정이 활성화할 모드를 결정합니다.

#### ecomode / 하위 티어 에이전트 비활성화

키워드와 LOW 티어 (`haiku` / `*-low`) 위임을 완전히 비활성화하려면:

```json
{
  "": { "enabled": false }
}
```

동등한 CLI 명령어:

```bash
omc config- --disable
omc config-agent-tiers --disable-low
```

### 호환성 파괴 변경

없음. 모든 v3.3.x 기능과 명령어가 v3.4.0에서 계속 작동합니다.

### 새로 사용 가능한 도구

업그레이드 후 자동으로 다음에 접근할 수 있습니다:

- ultrapilot (병렬 autopilot)
- swarm 조정
- pipeline 워크플로우
- ecomode 실행
- 통합 cancel 명령어
- explore-high 에이전트

### v3.4.0 모범 사례

#### 각 모드를 사용할 시점

| 시나리오             | 추천 모드    | 이유                                    |
| -------------------- | ------------ | --------------------------------------- |
| 멀티 컴포넌트 시스템 | `ultrapilot` | 병렬 워커가 독립적인 컴포넌트를 처리    |
| 많은 소규모 수정     | `swarm`      | 원자적 작업 클레이밍으로 중복 작업 방지 |
| 순차적 의존성        | `pipeline`   | 스테이지 간 데이터 전달                 |
| 예산 고려            | ``           | 스마트 라우팅으로 30-50% 토큰 절약      |
| 단일 복잡한 작업     | `autopilot`  | 완전 자율 실행                          |
| 반드시 완료해야 함   | `ralph`      | 완료 보장                               |

#### 키워드 사용법

**명시적 모드 제어 (v3.4.0):**

```bash
"ulw: fix all errors"           # ultrawork (명시적)
"eco: refactor auth system"     #  (명시적)
"ulw eco: migrate database"     #  우선 (충돌 해결)
"fast: implement feature"       # defaultExecutionMode 설정 읽기
```

**자연어 (여전히 작동):**

```bash
"don't stop until done"         # ralph
"parallel execution"            # defaultExecutionMode 읽기
"build me a todo app"           # autopilot
```

### 검증

업그레이드 후 새 기능을 확인하세요:

1. **설치 확인**:

   ```bash
   npm list -g oh-my-claude-sisyphus
   ```

2. **ultrapilot 테스트**:

   ```bash
   /oh-my-claudecode:ultrapilot "create a simple React component"
   ```

3. **통합 cancel 테스트**:

   ```bash
   /oh-my-claudecode:cancel
   ```

4. **상태 디렉토리 확인**:
   ```bash
   ls -la .omc/state/  # ultrapilot 실행 후 ultrapilot-state.json이 보여야 합니다
   ```

---

## v3.x → v4.0: 주요 아키텍처 개편

### 개요

버전 4.0은 확장성, 유지보수성 및 개발자 경험에 초점을 맞춘 완전한 아키텍처 재설계입니다.

### 예정 사항

⚠️ **이 섹션은 v4.0이 개발 중이므로 활발히 업데이트되고 있습니다.**

#### 계획된 변경 사항

1. **모듈러 아키텍처**
   - 확장성을 위한 플러그인 시스템
   - 코어/확장 분리
   - 향상된 의존성 관리

2. **향상된 에이전트 시스템**
   - 개선된 에이전트 라이프사이클 관리
   - 향상된 오류 복구
   - 성능 최적화

3. **개선된 설정**
   - 통합 설정 스키마
   - 향상된 유효성 검사
   - 마이그레이션 도구

4. **호환성 파괴 변경**
   - 개발 진행 상황에 따라 결정 예정
   - 완전한 마이그레이션 가이드가 제공될 예정

### 마이그레이션 경로 (준비 중)

v4.0이 릴리스 후보 단계에 도달하면 상세한 마이그레이션 안내가 제공될 예정입니다.

예상 일정: 2026년 1분기

### 최신 정보 확인

- 공지를 위해 [GitHub 저장소](https://github.com/Yeachan-Heo/oh-my-claude-sisyphus)를 watch하세요
 상세한 릴리스 노트는 [CHANGELOG.md](../../CHANGELOG.md)를 확인하세요
- GitHub Issues에서 논의에 참여하세요

---

## 버전별 공통 시나리오

### 시나리오 1: 빠른 구현 작업

**2.x 워크플로우:**

```
/oh-my-claudecode:ultrawork "implement the todo list feature"
```

**3.0+ 워크플로우:**

```
"implement the todo list feature quickly"
    ↓
Claude: "최대 병렬 처리를 위해 ultrawork를 활성화합니다"
```

**결과:** 동일한 결과, 더 자연스러운 상호작용.

### 시나리오 2: 복잡한 디버깅

**2.x 워크플로우:**

```
/oh-my-claudecode:ralph "debug the memory leak"
```

**3.0+ 워크플로우:**

```
"there's a memory leak in the worker process - don't stop until we fix it"
    ↓
Claude: "완료를 보장하기 위해 ralph-loop을 활성화합니다"
```

**결과:** 자연어에서 더 많은 컨텍스트를 가진 ralph-loop.

### 시나리오 3: 전략적 플래닝

**2.x 워크플로우:**

```
/oh-my-claudecode:planner "design the new authentication system"
```

**3.0+ 워크플로우:**

```
"plan the new authentication system"
    ↓
Claude: "플래닝 세션을 시작합니다"
    ↓
인터뷰가 자동으로 시작됨
```

**결과:** 자연어로 트리거된 플래닝 인터뷰.

### 시나리오 4: 작업 중단

**2.x 워크플로우:**

```
/oh-my-claudecode:cancel-ralph
```

**3.0+ 워크플로우:**

```
"stop"
```

**결과:** Claude가 지능적으로 활성 작업을 취소합니다.

---

## 설정 옵션

### 프로젝트 범위 설정 (권장)

oh-my-claudecode를 현재 프로젝트에만 적용합니다:

```
/oh-my-claudecode:omc-default
```

생성 파일: `./.claude/CLAUDE.md`

### 글로벌 설정

모든 Claude Code 세션에 적용합니다:

```
/oh-my-claudecode:omc-default-global
```

생성 파일: `~/.claude/CLAUDE.md`

**우선순위:** 둘 다 존재하는 경우 프로젝트 설정이 글로벌 설정을 덮어씁니다.

---

## 자주 묻는 질문

**Q: 키워드를 반드시 사용해야 하나요?**
A: 아니요. 키워드는 선택적 단축키입니다. Claude가 키워드 없이도 의도를 자동으로 감지합니다.

**Q: 기존 명령어가 작동하지 않게 되나요?**
A: 아니요. 모든 명령어는 마이너 버전 간에 계속 작동합니다 (3.0 → 3.1). 메이저 버전 변경 (3.x → 4.0)에서는 마이그레이션 경로가 제공됩니다.

**Q: 명시적 명령어를 선호하면 어떻게 하나요?**
A: 계속 사용하세요! `/oh-my-claudecode:ralph`, `/oh-my-claudecode:ultrawork`, `/oh-my-claudecode:plan`이 작동합니다. 참고: `/oh-my-claudecode:planner`는 이제 `/oh-my-claudecode:plan`으로 리다이렉트됩니다.

**Q: Claude가 무엇을 하고 있는지 어떻게 알 수 있나요?**
A: Claude가 주요 동작을 안내합니다: "ralph-loop을 활성화합니다..." 또는 실시간 상태를 위해 `/oh-my-claudecode:hud`를 설정하세요.

**Q: 전체 명령어 목록은 어디에 있나요?**
A: 전체 명령어 레퍼런스는 [README.md](../../README.md)를 참조하세요. 모든 명령어가 여전히 작동합니다.

**Q: 키워드와 자연어의 차이점은 무엇인가요?**
A: 키워드는 명시적 단축키입니다. 자연어는 자동 감지를 트리거합니다. 둘 다 작동합니다.

---

## 도움이 필요하신가요?

- **이슈 진단**: `/oh-my-claudecode:omc-doctor` 실행
- **모든 명령어 보기**: `/oh-my-claudecode:omc-help` 실행
- **실시간 상태 보기**: `/oh-my-claudecode:hud setup` 실행
 **상세 변경 로그 확인**: [CHANGELOG.md](../../CHANGELOG.md) 참조
- **버그 보고**: [GitHub Issues](https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/issues)

---

## 다음 단계

이제 마이그레이션을 이해하셨으니:

1. **즉시 효과를 위해**: 작업에서 키워드 (`ralph`, `ulw`, `plan`) 사용을 시작하세요
2. **전체 기능 활용을 위해**: [docs/CLAUDE.md](../CLAUDE.md)를 읽고 오케스트레이션을 이해하세요
3. **고급 사용을 위해**: [docs/ARCHITECTURE.md](../ARCHITECTURE.md)에서 심층 분석을 확인하세요
4. **팀 온보딩을 위해**: 이 가이드를 팀원들과 공유하세요

oh-my-claudecode에 오신 것을 환영합니다!
