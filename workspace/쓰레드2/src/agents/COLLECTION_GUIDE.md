# 포스트 수집 가이드 (에이전트용)

## 수집 방법 우선순위

1. **CLI 스크립트 (권장)** — GraphQL 인터셉션으로 정확한 데이터
2. **MCP browser_run_code** — CLI 불가 시 폴백
3. **MCP browser_snapshot 파싱** — 소량 수집/확인용

## CLI 명령어

### 키워드 검색 수집
```bash
cd /home/sihun92/projects/oh-my-claudecode/workspace/쓰레드2
npx tsx scripts/collect-by-keyword.ts --keywords "키워드1,키워드2" --posts-per-keyword 30 --max-age-days 7
```
- GraphQL 인터셉션 자동 적용
- 최신순 탭 자동 전환 시도
- 스크롤 최대 10회
- 포스트당 조회수 수집 (15~30초 대기)
- DB 자동 저장 (onConflictDoNothing)

### 채널별 수집
```bash
npx tsx src/scraper/collect.ts <channel_id> <post_count>
```
- 프로필 피드 스크롤 → 개별 포스트 방문
- 셀프답글 자동 감지
- 체크포인트/resume 지원

### DB 상태 확인
임시 스크립트 패턴: `_` prefix, async main(), process.exit(0), 실행 후 삭제
```bash
npx tsx -e "import {db} from './src/db/index.js'; ..."
```

## 주의사항
- Chrome CDP (port 9223) 필요
- anti-bot: 키워드 간 60~120초, 포스트 간 15~30초
- 조회수는 GraphQL에 없음 → 개별 방문 필요 (어쩔 수 없음)
