# BiniLab Handoff — 세션 17 (2026-03-25)

## 현재 상태: 벤치마크 리밸런싱 완료 + 수집 기준 확립

### 이번 세션(17) 핵심 작업

1. **벤치마크 리밸런싱 (팀 회의 → 계획 → 실행)**
   - 유령 채널 9개 + 저활동 1개 = 10개 퇴출
   - 뷰티 24→8 축소 (댓글 하위 퇴출)
   - 다이어트 7→4 축소
   - 건강 1→5+ 확대 (ez_yaksa, manyjjju_yaksa, alpaca_yaksa, myyaksa 승격)
   - 식품/인테리어 채널 후보 발굴 완료 (CDP 문제로 검증 수집 실패 → 다음 세션)

2. **post_source 데이터 정합성**
   - null 546개 백필 (benchmark 322 + legacy 224)
   - NOT NULL 제약 추가, enum에 'legacy' 추가

3. **evaluate-channels.ts 개선**
   - 스코어링: 댓글 가중치 30% 신설, 조회수 40%→25% 감소
   - --apply 시 카테고리 최소 3개 보호

5. **Harness Design Upgrade (7개 Task 전부 완료)**
   - Task 1: 톤 검증 gate 연결 (`8db970bc`)
   - Task 2: ROI 중복 → buildDirective 추출 (`68b271fb`)
   - Task 3: Phase Gate 내용 검증 강화 (`faabdb03`)
   - Task 4: PostContract (Sprint Contract 패턴) (`217d6902`)
   - Task 5: 4축 QA 채점 hook/originality/authenticity/conversion (`ac6c4a2f`)
   - Task 6: QA 재작성 루프 3회 (`ca3c6dfc`)
   - Task 7: Dead code 정리 (getAgentRegistry)
   - 전체 테스트: 331 passed, 0 failed

6. **운영 전략 전환 (팀 전체 회의 → PDF 보고서)**
   - Content Pillar: 자취생활 50% / 건강식품 30% / 시행착오 20%
   - 훅 4종 로테이션 (공감질문/발견공유/비교대립/실패고백)
   - 뷰티 독립 카테고리 폐지 → "생활 속 뷰티"로 흡수
   - 댓글 유도 전략 + 제휴링크 댓글 삽입 전략 확정
   - operations-guide.md, post-writing-guide.md, content.md 업데이트
   - PDF: 바탕화면 `BiniLab_쓰레드_운영전략_회의보고서.pdf`

7. **collect.ts 개선**
   - 최근 5개 포스트 중 3일 이내 없으면 비활성 채널로 자동 스킵
   - --check-limits 포화도 표시

4. **채널 선정 기준 문서화**
   - DISCOVERY_GUIDE.md에 선정 기준표 + 카테고리 가드레일 추가

### 이전 세션(16) 작업

1. **AI Company v2 전체 구현 (feature/company-v2 → 머지 완료)**
   - 기억 시스템: agent_memories/episodes DB + loadAgentContext/saveMemory/logEpisode
   - 회의 시스템: meeting.ts (자유토론, 합의 종료, selectNextSpeaker)
   - 전략 아카이브: strategy_archive + 롤백 + pending_approvals
   - 에이전트 캐릭터: 11명 성격 + 지현 마케팅팀장 + 팀장 구조
   - Output Parser: agent-output-parser.ts (태그 파싱 + Phase Gate)
   - Spawner: async 전환 + COMPANY.md + 기억 주입
   - Pipeline: Phase 3 회의 기반 + meetingToDirective

2. **/daily-run v5 재작성**
   - COMPANY.md + 기억 + 성격 + 회의 + output-parser 통합
   - Phase 0: 비활성 채널 교체 + 성과 수집
   - TAG_MAP → Claude 직접 분류
   - 모든 에이전트에 [SAVE_MEMORY]/[LOG_EPISODE] 태그 필수

3. **수집 시스템 수정**
   - collect.ts: 스크롤 단계 비활성 채널 조기 감지 (4개 연속 → 스킵)
   - 벤치마크 + 나머지 병렬 수집
   - 비활성 벤치마크 11개 자동 비활성화

4. **Supabase DB v2 테이블 6개 생성**
   - agent_memories, agent_episodes, strategy_archive, meetings, pending_approvals, agents
   - agent_messages에 room_id 추가

5. **v5 dry-run 테스트 성공**
   - 서연 기억 저장 확인 (importance 0.7)
   - CEO 기억 저장 확인 (importance 0.9)
   - 다음 세션에서 자동 로드 예정

6. **포스트 게시 + 댓글**
   - "세안 바꿨더니 진짜 달라짐" 게시 (DWSfzAvgaS1, 506뷰/32분)
   - ssa_eune "제품뭐야" → "마녀공장 오일 + 라곰 마이크로폼" 답변

## 기억 DB 현황 (다음 세션에서 자동 로드)
- 서연: "YouTube+벤치마크 교차 검증 소재가 기회점수 최고"
- 민준: "뷰티(15)+봄패션(11)+건강 다양성보정(10) 배분. 경고 해소 우선"

## 벤치마크 현황 (리밸런싱 후)
| 카테고리 | 수 | 변경 |
|---------|-----|------|
| 뷰티 | 8 | 24→8 (16개 퇴출) |
| 건강 | 5+ | 1→5+ (4개 승격) |
| 생활 | 6 | 유지 |
| 다이어트 | 4 | 7→4 (3개 퇴출) |
| 식품 | 발굴 중 | 0→목표 5 |
| 인테리어 | 발굴 중 | 0→목표 3 |

## 다음 세션 우선순위

### 1순위: 운영
- /daily-run --posts 3 전체 실행 (v5)
- 워밍업: 8/20 완료 (12개 남음)
- 기억 시스템 검증

### 2순위: 수집 시스템
- 식품/인테리어 채널 발굴 완료 (미완료 시)
- evaluate-channels.ts --apply 주간 실행 시작
- 빈이 channel_id 정합성 수정 (thread_posts에서 조회 안 됨)
- 트렌드 파이프라인 폐기 판단 (활용률 0.8%)

### 3순위: 장기
- 대시보드 (S-9~S-13)
- 워밍업 완료 후 제휴링크 시작

## 브랜치
- feat/threads-watch-p0 (company-v2 머지 + 수집 수정 커밋)

## 워밍업 상태
- 8/20 완료, 제휴링크/광고 금지
