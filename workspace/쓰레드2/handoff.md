# BiniLab Handoff — 세션 25 완료 (2026-03-27)

## 현재 상태: P1 에이전트 자발적 행동 + 권한 체계 완성

### 세션 25 성과

| 항목 | 내용 |
|------|------|
| P1 회의 소집 | `_create-meeting.ts` CLI + `[CREATE_MEETING]` 태그 |
| P1 에이전트 간 대화 | `_dispatch.ts` CLI + `[SEND_MESSAGE]` 태그 |
| P1 자발적 보고 | `[REPORT_TO_CEO]` 태그 |
| Supabase Realtime | 5초 polling → WebSocket 실시간 (30초 fallback) |
| 대시보드 연동 | 회의/DM/보고 시 chat_rooms 자동 생성 |
| 권한 체계 | rank 기반 (owner/executive/lead/member) |
| 파일 수정 제한 | 코드는 엔지니어만, 나머지는 페르소나 .md만 |
| directive 감지 | 지시형 메시지 → 행동 실행 프롬프트 자동 전환 |

### 빌드/테스트
- tsc: 0 errors
- npm test: 388 passed, 0 failed
- 커밋: `ee395daa` (P1 전체) + `4050457e` (파일 권한)

---

## 아키텍처 (P1 완료 후)

```
에이전트 자발적 행동 흐름:

1. 대시보드 채팅 (P0 — 정상 동작):
   사용자 → dispatch API → PENDING_RESPONSE → watcher → tmux agent
   → _respond.ts → DB → Supabase Realtime → 대시보드 즉시 표시

2. 회의 소집 (P1):
   CEO → _create-meeting.ts → meetings + chat_rooms + PENDING_RESPONSE
   → watcher → 참여자에게 회의 프롬프트 전달

3. 에이전트 간 DM (P1):
   에이전트A → _dispatch.ts 또는 [SEND_MESSAGE] 태그
   → PENDING_RESPONSE + chat_rooms → watcher → 에이전트B

4. CEO 보고 (P1):
   에이전트 출력에 [REPORT_TO_CEO] → reportToCeo()
   → PENDING_RESPONSE + chat_rooms → watcher → CEO

5. directive 감지:
   "회의 소집해" 등 지시형 메시지 → processOneResponse()가
   행동 실행 프롬프트 생성 (채팅 응답 대신 Bash 실행 지시)
```

### 권한 체계

| rank | 에이전트 | 채팅방 생성 | 파일 수정 |
|------|---------|-----------|----------|
| owner | 시훈 | 모든 타입 | 모든 파일 |
| executive | 민준(CEO) | DM + 회의 | 페르소나 .md + ops .md |
| lead | 서연, 지현 | DM + 회의 | 페르소나 .md + ops .md |
| member | 빈이 외 7명 | DM만 | 자기 페르소나 .md만 |

---

## 다음 세션 할 일

### 🔴 P1.5 E2E 검증 (최우선)
- CEO에게 "회의 소집해" 지시 → CEO가 실제로 `_create-meeting.ts` 실행하는지 확인
- 서연/지현이 회의에 참여하여 대화하는지 확인
- 대시보드에서 에이전트 간 대화가 실시간으로 보이는지 확인
- **지금 안 되는 것**: CEO가 directive를 받아도 채팅 응답만 하고 행동을 안 할 수 있음
  - 원인: 프롬프트에 도구 + directive 규칙은 추가했지만, CEO 에이전트의 기존 컨텍스트가 방해할 수 있음
  - 해결책: CEO tmux 세션을 새로 시작하면 새 프롬프트가 적용됨

### 🟡 P2: 회의 결론 → 실행
- 회의 대화에서 `[ACTION_ITEM]` 태그 파싱 → `agent_tasks` 생성
- 태스크를 해당 에이전트에 배정 → 실제 작업 실행

### 🟢 P3: CEO 자율 루프
- 매일 아침 상태 확인 → 회의 소집 → 전략 조정 → 실행 지시

---

## 변경 파일 목록 (세션 25)

| 파일 | 변경 |
|------|------|
| `src/orchestrator/agent-actions.ts` (신규) | dispatchToAgent, createAgentMeeting, reportToCeo + ensureChatRoom + 권한 검증 |
| `_dispatch.ts` (신규) | 에이전트 간 메시지 CLI |
| `_create-meeting.ts` (신규) | CEO 회의 소집 CLI |
| `src/orchestrator/agent-output-parser.ts` | [CREATE_MEETING], [SEND_MESSAGE], [REPORT_TO_CEO] 태그 |
| `src/orchestrator/response-processor.ts` | P1 도구 안내 + directive 감지 + 파일 권한 규칙 |
| `src/orchestrator/agent-spawner.ts` | rank 필드 + canCreateRoom() + getAgentRank() |
| `scripts/watch-pending.ts` | roomId 정규식 확장 |
| `agent-town/components/hud/BinilabChatPanel.tsx` | Supabase Realtime 구독 |
| `agent-town/app/api/chat/rooms/route.ts` | 권한 검증 (403) |
| `src/__tests__/agent-output-parser.test.ts` | P1 태그 파싱 테스트 6개 |
| `src/__tests__/schema-v2.test.ts` | PGlite text[] 호환성 수정 |

---

## 기술적 발견사항

### response-processor가 프롬프트의 핵심
- `buildAgentPrompt()` (daily-run용)과 `processOneResponse()` (watcher 채팅용)는 별개
- P1 도구를 `buildAgentPrompt()`에만 넣으면 채팅 모드에서 에이전트가 행동을 못 함
- 두 곳 모두 도구 안내를 포함해야 에이전트가 일관되게 동작

### directive 감지 방식
- 정규식으로 "회의 소집해", "~해줘" 등 지시형 메시지 패턴 매칭
- 매칭 시 "행동 규칙" 섹션을 프롬프트에 추가 (Bash 실행 지시)
- 미매칭 시 기존 채팅 응답 규칙 유지

### PGlite text[] 비호환
- 실제 Supabase DB에서는 `text[]` INSERT 정상 동작
- PGlite 테스트 환경에서는 `text[]`를 jsonb로 해석하려 해서 에러
- 테스트에서 participants 삽입을 제거하여 우회

### Supabase Realtime 적용
- `supabase.channel().on('postgres_changes', ...)` 구독
- room별 필터: `filter: 'room_id=eq.{roomId}'`
- chat_rooms 변경도 구독하여 새 방 자동 표시

---

## 에이전트 분류

| 상주 에이전트 (10명) | rank |
|---------------------|------|
| minjun-ceo | executive |
| seoyeon-analyst | lead |
| jihyun-marketing-lead | lead |
| bini-beauty-editor | member |
| hana-health-editor | member |
| sora-lifestyle-editor | member |
| jiu-diet-editor | member |
| junho-researcher | member |
| doyun-qa | member |
| taeho-engineer | member |
