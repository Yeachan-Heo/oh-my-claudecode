# 쓰레드 프로젝트 — 쿠팡파트너스 광고 아이템 분석

## 세션 시작 (hard)

1. **`handoff.md` 확인**: 파일이 존재하면 이전 세션에서 중단된 작업이 있음
   - handoff.md를 읽고, 지시에 따라 `/threads-watch resume` 자동 실행
   - 사용자에게 "이전 수집 작업을 이어합니다" 알림 후 바로 시작
2. **`data/threads-watch-checkpoint.json` 확인**: handoff.md 없이 checkpoint만 있으면 사용자에게 재개 여부 질문

## 프로젝트 개요
Threads 채널에서 쿠팡파트너스/제휴마케팅 광고 아이템을 분석하고, 트렌드 연관성을 검증하는 파이프라인.
상세 플랜: `plan.md` 참조.

## Google Sheets 접근 규칙 (hard)

**gspread OAuth CLI를 사용한다. Playwright로 시트를 조작하지 않는다.**

- **인증**: `~/.config/gspread/authorized_user.json` (OAuth, 이미 설정 완료)
- **OAuth 클라이언트**: `~/credentials.json`
- **Python**: `.venv/bin/python` (프로젝트 venv, gspread 설치됨)
- **스프레드시트 ID**: `1U-m4sJvV_EyELTRk7ECDYXLLlvF8Kqf4YmrjzVnDJgE`

### 시트 구성
| 시트명 | gid | 용도 |
|--------|-----|------|
| 시트1 | 0 | (미사용) |
| 포스트 관리 | 1145922452 | 콘텐츠 캘린더 |
| 레퍼런스 | 1385274274 | 수집 데이터 템플릿 (채널/포스트/링크/제품/메타) |
| 주간 성과 | 1238158971 | 주간 추적 |
| 훅 레퍼런스 | 1074536508 | 훅 타입 참조 |

### 사용 패턴
```python
import gspread
gc = gspread.oauth()
sh = gc.open_by_key('1U-m4sJvV_EyELTRk7ECDYXLLlvF8Kqf4YmrjzVnDJgE')
ws = sh.worksheet('레퍼런스')
# batch update로 데이터 기록
ws.update(data, 'A1')
```

### 금지사항
- Playwright/browser로 Google Sheets 접근 금지
- 서비스계정 JSON 없음 — OAuth 전용
- `pip install --break-system-packages` 금지 — 항상 `.venv/bin/python` 사용

## 브라우저 자동화 (Threads 전용)

Playwright MCP는 **Threads 사이트 접근 전용**으로만 사용한다.

- **MCP**: `threads-playwright` (CDP endpoint `http://127.0.0.1:9223`)
- **Chrome 실행**: `cmd.exe /c start "" "C:\Users\campu\OneDrive\Desktop\Chrome (Claude).lnk"`
- **Chrome 인자**: `--remote-debugging-port=9223 --user-data-dir=C:\Users\campu\ChromeDebug`
- **자격 증명**: `/mnt/c/Users/campu/OneDrive/Desktop/새 텍스트 문서 (2).txt` (Line1: email, Line3: password)

## 데이터 디렉토리

```
data/
  threads-watch-checkpoint.json  # 수집 진행 상태 (자동 이어하기)
  sheets/              # 시트 템플릿 CSV
    reference_template.csv   # 레퍼런스 시트 구조 정의
    posts_management.csv
    weekly_tracker.csv
    hook_reference.csv
  raw_posts/           # Phase 1 raw JSON (run_id/channel/post_id.json)
  product_dict/        # 제품사전 JSON (버전관리)
  keyword_map/         # 키워드 매핑 사전
handoff.md               # 세션 간 자동 이어하기 (완료 시 삭제됨)
```

## 환경
- Python venv: `.venv/` (gspread, playwright 등)
- 환경변수: `.env` (NAVER API keys, Threads tokens)
- WSL2 + Windows Chrome (CDP 9223)
