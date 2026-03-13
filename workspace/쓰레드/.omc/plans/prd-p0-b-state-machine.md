# PRD: P0 B단계 — 상태머신 + 글로벌 Checkpoint 통합

> Status: Ready for execution
> Created: 2026-03-13
> Scope: GAP #1, #2, #4, #6, #10 from docs/audit.md
> Depends on: A단계 7패치 완료

## Problem Statement

collect-posts.js는 **단일 채널 CLI 도구**로 동작한다. 채널별 독립 checkpoint를 사용하고, 수집 완료 시 삭제한다.
plan2.md P0-1은 **글로벌 상태머신**을 요구한다: 여러 채널을 순차 수집하면서 하나의 checkpoint로 전체 진행 상태를 추적하고, 크래시/재개/예산 소진을 관리해야 한다.

현재 GAP:
- **GAP #1**: 상태머신 엔진 없음 — state enum, 전이 규칙, 글로벌 checkpoint 없음
- **GAP #2**: per-channel frontier 없음 — 재개 시 처음부터 다시 수집
- **GAP #4**: MCP↔CLI 브릿지 state 필드 없음
- **GAP #6**: 헬스 게이트 중간 검증이 12-20포스트 간격 (10포스트로 변경 필요)
- **GAP #10**: budget 카운터가 checkpoint에 없음

## Design Decision

collect-posts.js는 **단일 채널 수집기로 유지**한다. 멀티 채널 오케스트레이션은 Claude(SKILL.md)가 담당.

변경 범위:
1. collect-posts.js가 **글로벌 checkpoint** 읽기/쓰기 지원 (`--global` 플래그)
2. 채널 완료 시 **frontier** 기록 (last_post_id + last_timestamp)
3. **overlap-resume**: frontier가 있는 채널 재개 시 마지막 20개 오버랩
4. **budget 카운터**: browser_ops(page.goto 횟수) 추적, 임계치 초과 시 exit
5. **10포스트 주기 헬스 체크**: longBreak 대신 정확히 10포스트마다
6. **exit code 표준화**: 오케스트레이터가 해석 가능한 코드

## Technical Design

### 1. 글로벌 Checkpoint (GAP #1)

**파일**: `data/threads-watch-checkpoint.json` (docs/checkpoint-schema.json 준수)

**새 CLI 인터페이스**:
```
node collect-posts.js --global --channel <id> [--posts 20] [--resume]
```
- `--global`: 글로벌 checkpoint 모드 (없으면 기존 레거시 모드 유지)
- `--channel <id>`: 수집 대상 채널
- `--posts N`: 채널당 목표 포스트 수 (기본 20)
- `--resume`: 기존 checkpoint에서 이어서

**기존 호환**: `node collect-posts.js <channel_id> [count] [--resume]` 그대로 동작 (레거시 모드)

**글로벌 checkpoint 구조** (간소화, checkpoint-schema.json 기반):
```json
{
  "version": "1.0",
  "run_id": "run_20260313_0900",
  "state": "collect",
  "channels": {
    "completed": [
      {
        "channel_id": "teri.hous",
        "threads_collected": 23,
        "frontier": { "last_post_id": "xxx", "last_timestamp": "..." },
        "status": "completed"
      }
    ],
    "queue": ["channel2", "channel3"],
    "current": null,
    "blocked": [],
    "exhausted": []
  },
  "budget": {
    "browser_ops": 0,
    "browser_ops_limit": 150,
    "channels_completed_count": 0,
    "channels_limit": 3
  },
  "overlap_resume": {
    "enabled": true,
    "overlap_count": 20,
    "current_channel_tail": []
  },
  "session_count": 1,
  "timestamp": "...",
  "status": "active"
}
```

### 2. Per-Channel Frontier (GAP #2)

채널 수집 완료 시:
- `frontier.last_post_id` = 마지막 수집 포스트 ID
- `frontier.last_timestamp` = 마지막 포스트의 timestamp
- `overlap_resume.current_channel_tail` = 마지막 20개 포스트 ID 배열

**overlap-resume 로직**:
- `--resume` + 해당 채널의 frontier 존재 → 피드 스크롤 시 tail에 있는 ID를 만나면 "이미 수집 구간" 도달로 판단
- tail의 ID와 overlap되는 포스트는 dedup으로 스킵
- tail에 없는 새 포스트만 수집

### 3. Budget 카운터 (GAP #10)

**추적 대상**: `page.goto` 호출 횟수 → `budget.browser_ops`
- 피드 스크롤: goto 1회
- 포스트 방문: goto 1회
- 답글 방문: goto 1회
- 채널 정보: goto 1회

**임계치**: `browser_ops >= browser_ops_limit(150)` → checkpoint 저장 + exit code 4

**구현**: `page.goto`를 래핑하는 `trackedGoto(page, url, options)` 함수

### 4. 10포스트 주기 헬스 체크 (GAP #6)

기존: longBreak 후 checkLoginStatus (12-20포스트 간격)
변경: **매 10포스트**마다 checkLoginStatus + CDP 재확인

- `processedCount % 10 === 0` → health recheck
- 실패 → 재연결 시도 2회 → 실패 시 checkpoint 저장 + exit code 5

### 5. Exit Code 표준화 (GAP #4 지원)

| Code | 의미 | checkpoint.status |
|------|------|-------------------|
| 0 | 성공 완료 | completed |
| 1 | 에러/잘못된 인자 | error |
| 2 | validity rate < 0.9 | error |
| 3 | 차단 감지 | paused_blocked |
| 4 | 예산 소진 | budget_exhausted |
| 5 | 세션 만료 | paused_session_expired |

오케스트레이터(Claude)가 exit code를 보고 다음 행동 결정:
- 0 → 다음 채널 or 완료
- 3 → 대기 or 채널 스킵
- 4 → handoff.md 작성
- 5 → 재로그인 시도

### 6. MCP↔CLI 브릿지 State 필드 (GAP #4)

글로벌 checkpoint의 `state` 필드로 현재 단계 표시:
- `health_check` → `discover` → `collect` → `classify` → `next_channel` → `completed`/`handoff`

collect-posts.js는 `collect` 상태만 담당. state 전이는 오케스트레이터가 관리.
- 시작 시: state를 `collect`로 설정, `channels.current`에 채널 기록
- 완료 시: state를 `next_channel`로 설정, 채널을 completed로 이동

## Acceptance Criteria

- [ ] **AC-1**: `--global --channel <id>` 모드에서 `data/threads-watch-checkpoint.json` 읽기/쓰기
- [ ] **AC-2**: 채널 완료 시 frontier(last_post_id + last_timestamp)가 checkpoint에 기록
- [ ] **AC-3**: `--resume` + frontier 존재 시 overlap-resume 동작 (마지막 20개 오버랩)
- [ ] **AC-4**: browser_ops 카운터가 매 page.goto마다 증가, 150 초과 시 exit(4)
- [ ] **AC-5**: 매 10포스트마다 login status 재확인, 실패 시 재연결 2회 → exit(5)
- [ ] **AC-6**: exit code 0/1/2/3/4/5 정의대로 동작
- [ ] **AC-7**: checkpoint.state 필드가 collect 시작/완료 시 적절히 업데이트
- [ ] **AC-8**: 기존 레거시 모드 (`node collect-posts.js <ch> [n]`) 여전히 동작
- [ ] **AC-9**: `node -c collect-posts.js` 문법 검증 통과
