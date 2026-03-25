# BiniLab Handoff — 세션 18 (2026-03-25)

## 현재 상태: 학습 루프 진단 완료 + v3 계획서 작성 + 포스트 게시

### 이번 세션(18) 핵심 작업

1. **BiniLab 회사 구조 분석 + PDF 생성**
   - 11명 에이전트 조직도, 일일 파이프라인, 검증/학습/자율진화 시스템 전체 분석
   - `BiniLab_AI_Company_구조분석.pdf` 바탕화면 저장

2. **Daily Run 실행 (Phase 2~5)**
   - Phase 2: 서연(애널리스트) 분석 → TOP5 기회점수 (모공13/카리나12/봄루틴11)
   - Phase 3: 민준(CEO) 지시서 → 3슬롯 배분
   - Phase 4: 빈이(뷰티 에디터) 2개 + 소라(생활 에디터) 1개 초안 제출
   - Phase 4 QA: 도윤(QA) 3개 CONDITIONAL_PASS (7.7/7.6/6.8)
   - **gate6 버그 수정**: 임계값 10→6 (`src/safety/gates.ts:137`) — QA 4축 스케일 불일치
   - Phase 5: Safety Gate 3개 전원 통과 → content_lifecycle 등록

3. **포스트 게시 1건**
   - 카리나 착장 복각 (생활) → `https://www.threads.com/@duribeon231/post/DWTNxQHkchR`
   - content_lifecycle 업데이트 완료 (218e108e)

4. **성과 수집 + 분석**
   - track-performance.ts 실행 → 25개 포스트 스냅샷 수집
   - TOP: 목이버섯 15K뷰 / 도시락 8.7K뷰 / 클렌징 2.5K뷰

5. **학습 루프 진단 — 구조적 결함 발견**
   - `processAgentOutput()` 프로덕션 호출 0곳 (테스트 파일 1개만)
   - `/daily-run` 스킬에서 output-parser 호출이 주석으로만 존재
   - `/analyze-performance` 스킬에 기억 저장 코드 전무
   - **근본 원인**: 기억 읽기(loadAgentContext)는 자동, 기억 쓰기(processAgentOutput)는 수동

6. **CLAUDE.md 규칙 추가 2건**
   - 에이전트 표기 규칙: 이름(직책) 형식 필수
   - 에이전트 스폰 규칙: "애들 시켜서" = Agent() 스폰 필수, 스킬 직접 호출 금지

7. **BiniLab v3 계획서 작성**
   - claude-peers + Agent Teams + Pixel Agents 조사
   - 3계층 에이전트 구조: 상주6 + 온디맨드5
   - "업데이트 인식 못하는 문제" 3계층 해결 (RELOAD 훅 + 주기적 체크 + 해시 검증)
   - `BiniLab_v3_Final_구현계획서.pdf` 바탕화면 저장

### 미완료 — 다음 세션 필수

#### 1순위: v3 구현 (학습 루프 + 상주 에이전트)

**Phase 0: 기존 버그 정리** (즉시)
- gate6 테스트 수정: `safety-gates.test.ts` gate6_qaPassCheck(9) → expect true (임계값 6 기준)
- 현재 348개 테스트 중 1개 실패

**Phase 1: 학습 루프 B+C+D+E** (1세션)
- B: `/analyze-performance` 스킬에 기억 저장 Step 추가
- C: CLAUDE.md output-parser 규칙 (✅ 이미 추가)
- D: `agent-spawner.ts`에 `saveAgentResponse()` 래퍼 — `processAgentOutput()` 래핑
- E: PostToolUse 훅 — Agent() 응답 자동 파싱

**Phase 2: claude-peers 셋업** (1세션)
- Bun 설치 (현재 미설치)
- claude-peers MCP 등록
- tmux 세션 구조 생성 (binilab:ceo/seoyeon/bini/doyun/junho/taeho)
- 상주 에이전트 6명 시작

**Phase 3: 변경 동기화** (1세션)
- PostToolUse:Edit 훅 → peers RELOAD 메시지
- 에이전트 프롬프트에 "작업 전 CLAUDE.md 재읽기" 규칙
- config 해시 검증 (선택)

#### 2순위: 운영

- 나머지 포스트 2개 게시 (뷰티 모공케어 + 봄세안) — content_lifecycle에 등록 완료
- 워밍업: 19/20 → 1개 더 게시하면 완료 → 제휴링크 시작
- Pixel Agents VS Code 확장 설치 (시각화)

#### 3순위: 기존 태스크

- 게시글 자동 등록 AI 에이전트 추가
- 쿠팡 파트너스 상품 등록 방식 설계 (high priority)
- 포스트용 이미지/영상 소싱 방안 파악

### 벤치마크 현황 (리밸런싱 후, 세션17에서 변경 없음)
| 카테고리 | 수 | 변경 |
|---------|-----|------|
| 뷰티 | 8 | 유지 |
| 건강 | 5+ | 유지 |
| 생활 | 6 | 유지 |
| 다이어트 | 4 | 유지 |
| 식품 | 발굴 중 | 0→목표 5 |
| 인테리어 | 발굴 중 | 0→목표 3 |

### 기억 DB 현황
- 민준(CEO): "뷰티 기회점수15 + 카테고리 경고 해소 원칙" (imp:0.9)
- 서연(애널리스트): "YouTube+벤치마크 교차 검증 소재가 최고점" (imp:0.7)

### 워밍업 상태
- 19/20 완료 (content_lifecycle 기준)
- 제휴링크/광고 금지 (워밍업 완료 전)

### 브랜치
- feat/threads-watch-p0

### 생성된 PDF (바탕화면)
- `BiniLab_AI_Company_구조분석.pdf` — 회사 구조/검증/학습 전체 분석
- `BiniLab_v3_구현계획서.pdf` — 초기 계획서 (v3.0)
- `BiniLab_v3_Final_구현계획서.pdf` — 보완 계획서 (v3.1, 최신)

### 피드백 메모리 추가
- `feedback_agent_spawn_required.md` — "애들 시켜서" = Agent() 스폰 필수
