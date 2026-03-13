# PRD: P0 S-Level Patches — collect-posts.js plan2.md 호환화

> Status: Ready for Ralph execution
> Created: 2026-03-13
> Scope: GAP #3, #5, #9, #12, #15, #20, #22 from docs/audit.md

## Problem Statement

`collect-posts.js` (878줄)는 Threads 포스트를 CDP+Playwright CLI로 수집하는 동작하는 코드이다.
그러나 plan2.md P0이 요구하는 안전성/검증/추적 기능이 빠져 있어, 이대로는 AI 에이전트가 자율 실행할 수 없다.

현재 코드의 핵심 결함:
1. **checkpoint 쓰기가 원자적이지 않음** — 크래시 시 데이터 유실 가능 (`:598-601` `writeFileSync` 직접 사용)
2. **크로스 런 중복 방지 없음** — 같은 포스트를 매번 재수집 (dedup 원장 없음)
3. **채널 소진 시 무한 대기** — `noNewCount>=3`이면 멈추지만 상태 태그/로그가 없음 (`:474`)
4. **헬스 게이트 없음** — CDP만 확인, gspread/MCP 확인 없이 시작 (`:644-656`)
5. **필드 유효성 검증 없음** — `viewCount=-1` 등 잘못된 값이 그대로 저장 (`:254`)
6. **plan2.md 필수 필드 누락** — `tags`, `crawl_meta`, `permalink` 없음 (`:557-583`)
7. **taxonomy 버전 추적 없음** — 출력에 스키마/taxonomy 버전 메타데이터 없음

## Goals

7개 S-level 패치를 `collect-posts.js`에 적용하여:
- AI 에이전트가 안전하게 자율 실행할 수 있는 기반 확보
- plan2.md P0 canonical schema와 출력 호환
- 기존 수집 기능 100% 보존 (하위 호환)

## Non-Goals

- 상태머신 엔진 구현 (B단계 별도 작업)
- 글로벌 checkpoint 통합 (B단계)
- 셀렉터 매니페스트 tier별 통계 (C단계)
- 듀얼 트랙 채널 발굴 (C단계)
- 출력 디렉토리 구조 변경 `{date}/{channel}/{post_id}.json` (C단계)
- upload-sheets.py 수정 (이번 범위 밖 — 기존 호환 유지)

## Technical Context

### 대상 파일
- `scripts/collect-posts.js` (878줄) — 주 수정 대상
- `data/taxonomy.json` — 읽기 전용 (이미 생성 완료, v1.0)
- `docs/canonical-schema.json` — 참조 (필드 검증 규칙)
- `docs/checkpoint-schema.json` — 참조 (목표 구조)

### 코드 구조 (collect-posts.js)
```
:1-16     헤더/Usage
:18-20    의존성 (playwright, fs, path)
:22-35    Config (CDP_URL, TIMING, AFF_TEXT_KEYWORDS)
:44-73    유틸리티 (gaussRandom, randInt, humanDelay, getRunId, log)
:77-114   Human-like behavior (mouseMove, scroll, idle, longBreak)
:136-423  Data extraction (extractHookPageData — 브라우저 내부 evaluate)
:429-462  Reply view count extraction
:466-503  Feed scrolling (collectPostIds) ← noNewCount 로직 여기
:507-584  Thread unit builder (buildThreadUnit) ← 출력 필드 여기
:588-606  Checkpoint (load/save/clear) ← 원자적 쓰기 적용 대상
:610-622  Login check
:626-878  Main function
```

### 기존 checkpoint 구조 (채널별, 수집 완료 시 삭제)
```json
{
  "runId": "run_20260312_2142",
  "channelId": "teri.hous",
  "completedHooks": ["postId1"],
  "postIds": ["postId1", "postId2"],
  "threadUnits": [{ /* thread_unit */ }]
}
```

### 기존 출력 구조 (thread_unit)
```json
{
  "channel_id": "...",
  "hook_post_id": "...",
  "hook_text": "...",
  "hook_date": "...",      // ← timestamp로 매핑
  "hook_post_url": "...",  // ← permalink로 매핑
  "hook_view_count": -1,   // ← -1은 null로 변환 필요
  "hook_like_count": 0,
  "hook_reply_count": 0,
  "hook_repost_count": 0,
  "hook_has_image": false,
  "hook_media_urls": [],
  "reply_post_id": "...",
  "reply_text": "...",
  "reply_view_count": -1,
  "reply_like_count": 0,
  "reply_media_urls": [],
  "thread_type": "쓰레드형|단독형|비광고",
  "link_location": "본문|답글|both|없음",
  "link_url": "...",
  "link_domain": "...",
  "conversion_rate": null,
  "display_name": "...",
  "follower_count": 0,
  "category": ""
}
```

---

## Implementation Phases

### Phase 1: 원자적 쓰기 (GAP #3)

**대상**: `:588-606` `saveCheckpoint()` + `:837` 최종 결과 저장

**변경**:
```javascript
// 기존
function saveCheckpoint(cp) {
  const cpPath = path.join(DATA_DIR, `checkpoint_${cp.channelId}.json`);
  fs.writeFileSync(cpPath, JSON.stringify(cp, null, 2), 'utf-8');
}

// 변경 → atomicWriteJSON 유틸리티 함수 추출
function atomicWriteJSON(filePath, data) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}
```

- `saveCheckpoint`에서 `atomicWriteJSON` 사용
- `:837` 최종 결과 저장에서도 `atomicWriteJSON` 사용
- `clearCheckpoint` (`:603-606`)는 변경 불필요 (unlink은 이미 원자적)

**검증**: `saveCheckpoint` 호출 후 `.tmp` 파일이 남아있지 않고, 원본 파일이 존재하는지 확인

---

### Phase 2: 영속 dedup 원장 (GAP #9)

**신규 함수**: `loadSeenPosts()`, `saveSeenPosts()`, `isPostSeen()`, `markPostSeen()`

**파일**: `data/seen_posts.json`
```json
{
  "version": "1.0",
  "updated_at": "2026-03-13T09:00:00Z",
  "posts": {
    "channelId_postId": true
  }
}
```

**연동 포인트**:
- `:684` 포스트 처리 루프 진입 전: `loadSeenPosts()`
- `:686-691` 스킵 판정에 dedup 체크 추가: 기존 `knownReplyIds.has(pid)` 외에 `isPostSeen(channelId, pid)`
- `:729-731` 수집 완료 후: `markPostSeen(channelId, pid)` + 셀프답글도 마킹
- 루프 종료 후: `saveSeenPosts()` (atomicWriteJSON 사용)

**핵심 규칙**:
- 키 형식: `{channelId}_{postId}` (underscore 구분)
- dedup에 걸리면 log 출력 + skip (에러 아님)
- seen_posts.json이 없으면 빈 상태로 초기화

---

### Phase 3: 채널 소진 태그 (GAP #15)

**대상**: `:466-503` `collectPostIds()` 함수

**변경**:
- 반환값을 `{ postIds: [...], status: 'ok' | 'exhausted' }` 객체로 변경
- `noNewCount >= 3` 시: `status: 'exhausted'` + log `"📋 채널 소진: {collected}개 수집 (목표 {target}개)"`
- 연속 5개 중복 윈도우 감지: 스크롤마다 새 ID가 0인 연속 횟수 tracking (기존 `noNewCount`와 동일하므로, 3회로 이미 커버됨)
- `collected < target`은 exhausted일 때 정상 처리

**main() 연동** (`:662-671`):
- `collectPostIds` 반환값에서 status 확인
- exhausted면 log 남기되, 수집은 계속 진행 (가진 만큼)

---

### Phase 4: 헬스 게이트 - 시작 (GAP #5)

**신규 함수**: `async function healthGate()`

**체크 항목**:
1. **CDP**: `fetch('http://127.0.0.1:9223/json/version')` — Node.js native fetch 또는 http.get
2. **gspread**: `execSync('.venv/bin/python -c "import gspread; gc = gspread.oauth(); gc.open_by_key(\'1U-m4sJvV_EyELTRk7ECDYXLLlvF8Kqf4YmrjzVnDJgE\')"')` — child_process
3. 하나라도 실패 → 진단 메시지 + `process.exit(1)`

**호출 위치**: `main()` 시작 직후, CDP 연결 전 (`:642` 이전)

**주의**:
- `require('child_process').execSync` 추가 필요
- gspread 경로: 프로젝트 루트 기준 `.venv/bin/python`
- timeout: 각 체크 10초
- MCP 직접 확인 불가 → CDP 확인으로 간접 대체 (CDP 연결되면 MCP도 같은 Chrome 사용)

---

### Phase 5: validity rate (GAP #12)

**신규 함수**: `function validateThreadUnit(unit)` → `{ valid: boolean, errors: string[] }`

**검증 규칙** (docs/canonical-schema.json 기준):
| 필드 | 규칙 | 실패 시 |
|------|------|---------|
| `hook_post_id` | 비공 + `/^[A-Za-z0-9_-]+$/` | reject |
| `hook_date` | ISO 8601 (`Date.parse()` 성공) | reject |
| `hook_text` | 비공, 길이 > 0 | reject |
| `channel_id` | 비공 | reject |
| `hook_view_count` | 정수 >= 0 또는 -1 → null 변환 | warn (null로 치환) |

**quarantine 처리**:
- reject된 레코드 → `data/quarantine/{date}_{post_id}.json` 저장
- `quarantine/` 디렉토리 auto-create

**validity rate 계산**:
- 수집 완료 시: `validCount / totalCount`
- `< 0.9` → 경고 로그 + exit code 2

**연동 포인트**: `:728` `buildThreadUnit` 직후, `cp.threadUnits.push` 전에 검증

---

### Phase 6: 출력 필드 확장 (GAP #22)

**대상**: `:507-584` `buildThreadUnit()` 함수

**추가 필드**:
```javascript
// buildThreadUnit 반환 객체에 추가:
tags: { primary: 'general', secondary: [] },  // 빈 태그 — 후속 분류 단계에서 채움
crawl_meta: {
  crawl_at: new Date().toISOString(),
  run_id: runId,               // 인자로 전달 필요
  selector_tier: 'css-nth-child',  // 현재 코드는 실질적으로 CSS 기반
  login_status: true,          // checkLoginStatus 결과 전달
  block_detected: false,
},
permalink: hookData.url,       // hook_post_url과 동일
```

**함수 시그니처 변경**:
```javascript
// 기존
function buildThreadUnit(hookData, channelId)
// 변경
function buildThreadUnit(hookData, channelId, runId, loginStatus)
```

**호출부 수정** (`:728`):
```javascript
const threadUnit = buildThreadUnit(hookData, channelId, runId, loggedIn);
```

**기존 필드 유지**: `hook_post_id`, `hook_text` 등 기존 필드는 그대로 둔다. 하위 호환.

---

### Phase 7: 의존성 게이트 스텁 (GAP #20)

**대상**: `:822-836` 최종 결과 저장 부분의 `output.meta` 객체

**추가**:
```javascript
const output = {
  meta: {
    // ... 기존 필드 유지
    taxonomy_version: taxonomyVersion,  // data/taxonomy.json에서 읽어온 version
    schema_version: '1.0',             // docs/canonical-schema.json version
  },
  thread_units: cp.threadUnits,
};
```

**taxonomy 버전 읽기**: `main()` 시작부에서 한 번 로드
```javascript
let taxonomyVersion = '0.0';
try {
  const tax = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'taxonomy.json'), 'utf-8'));
  taxonomyVersion = tax.version || '0.0';
} catch (e) {
  log('⚠️  taxonomy.json 로드 실패 — 기본값 사용');
}
```

---

## Acceptance Criteria

모든 항목은 코드 레벨에서 검증 가능해야 한다.

### 기능 검증
- [ ] **AC-1**: `saveCheckpoint()` 호출이 tmp+rename 패턴을 사용한다. `atomicWriteJSON` 함수가 존재하고, `writeFileSync(*.tmp)` → `renameSync`를 수행한다.
- [ ] **AC-2**: `data/seen_posts.json`이 수집 시 로드되고, 수집 완료 후 저장된다. 이미 seen인 포스트는 `"⏭️ dedup skip"` 로그와 함께 건너뛴다.
- [ ] **AC-3**: `collectPostIds()`가 `noNewCount >= 3` 시 `status: 'exhausted'`를 반환하고, `"📋 채널 소진"` 로그를 출력한다. `collected < target`이어도 에러 없이 진행한다.
- [ ] **AC-4**: `healthGate()`가 CDP와 gspread를 확인한다. CDP 미연결 시 `"❌ CDP 연결 실패"` 출력 후 `process.exit(1)`. gspread 실패 시 `"❌ gspread 인증 실패"` 출력 후 `process.exit(1)`.
- [ ] **AC-5**: `validateThreadUnit()`이 필수 필드(post_id, timestamp, text, channel_id)를 검증한다. 실패한 레코드는 `data/quarantine/` 에 저장된다. 수집 완료 시 validity_rate를 계산하고, `< 0.9`이면 exit code 2로 종료한다.
- [ ] **AC-6**: `buildThreadUnit()` 반환값에 `tags`, `crawl_meta`, `permalink` 필드가 포함된다. `tags`는 `{ primary: 'general', secondary: [] }` 기본값. `crawl_meta`에 `crawl_at`, `run_id`, `selector_tier`, `login_status`가 포함된다.
- [ ] **AC-7**: 최종 출력 JSON의 `meta` 객체에 `taxonomy_version`과 `schema_version` 필드가 포함된다. `taxonomy_version`은 `data/taxonomy.json`의 `version` 값과 일치한다.

### 하위 호환 검증
- [ ] **AC-8**: 기존 `node scripts/collect-posts.js <channel_id> [count] [--resume]` 명령이 에러 없이 실행된다. 기존 thread_unit 필드(`hook_post_id`, `hook_text`, `hook_view_count` 등)가 모두 유지된다.
- [ ] **AC-9**: `upload-sheets.py`가 새 출력 JSON을 읽을 때 에러가 발생하지 않는다 (추가 필드는 무시됨).

### 코드 품질
- [ ] **AC-10**: 각 패치가 논리적으로 분리되어 있다 (한 패치 revert 시 다른 기능에 영향 없음). 단, `atomicWriteJSON`은 공유 유틸리티로 여러 곳에서 사용 가능.

## Constraints

- `collect-posts.js`만 수정. `upload-sheets.py` 수정 없음.
- 새 파일은 최소한 (`data/seen_posts.json`은 런타임 생성, `data/quarantine/`는 mkdir).
- `data/taxonomy.json` 수정 금지 (읽기 전용).
- Node.js 내장 모듈만 사용 (추가 npm 패키지 설치 금지).
- `view_count: -1` → `null`로 치환 (기존 코드 `:254`에서 -1을 기본값으로 사용).

## Risks

| Risk | Mitigation |
|------|-----------|
| `buildThreadUnit` 시그니처 변경이 기존 호출부 깨뜨림 | 호출부 `:728` 한 곳뿐, 함께 수정 |
| `collectPostIds` 반환값 변경이 main() 깨뜨림 | 반환값을 destructuring으로 받도록 main() 수정 |
| `healthGate`의 gspread 체크가 Python venv 경로 의존 | 경로를 상수로 정의, 실패 시 명확한 에러 메시지 |
| `seen_posts.json`이 커지면 로드 느려짐 | MVP에서는 JSON, 확장 시 NDJSON+compaction (plan2.md P0-3 명시) |

## Definition of Done

위 AC-1 ~ AC-10 모두 통과 + `node scripts/collect-posts.js --help` 실행 시 에러 없음.
