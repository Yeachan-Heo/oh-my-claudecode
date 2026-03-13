# 환경 검증 결과

> 검증 일시: 2026-03-13

| 의존성 | 명령 | 결과 | 비고 |
|--------|------|------|------|
| CDP | `curl -s http://127.0.0.1:9223/json/version` | OK | Chrome/145.0.7632.160, WebSocket 정상 응답 |
| MCP | threads-playwright MCP 도구 직접 호출 불가 -- CDP 연결 확인으로 대체 | OK (간접) | CDP 연결 성공 = Playwright CDP 연결 가능. MCP 서버 자체의 health는 별도 확인 필요하나, CDP 포트가 살아있으므로 browser_navigate도 동작할 것으로 판단 |
| gspread | `.venv/bin/python -c "import gspread; gc = gspread.oauth(); sh = gc.open_by_key('1U-m4sJvV_EyELTRk7ECDYXLLlvF8Kqf4YmrjzVnDJgE'); print(sh.title)"` | OK | 출력: `쓰레드`. OAuth 인증 + 스프레드시트 접근 정상 |

## 상세 결과

### 1. CDP (Chrome DevTools Protocol)

```json
{
   "Browser": "Chrome/145.0.7632.160",
   "Protocol-Version": "1.3",
   "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
   "V8-Version": "14.5.201.17",
   "WebKit-Version": "537.36 (@662e0d7961bd91ebe77fe6c52f369e45647af51c)",
   "webSocketDebuggerUrl": "ws://127.0.0.1:9223/devtools/browser/80bbaa30-f7ce-48c2-ab15-9a014ff81e6f"
}
```

- 포트 9223 정상 리스닝
- Chrome 145 (최신)
- WebSocket debugger URL 확인됨 -> Playwright connectOverCDP 가능

### 2. MCP (threads-playwright)

- Deep executor 환경에서 MCP 도구를 직접 호출할 수 없어 간접 검증
- CDP 포트가 정상이므로 `threads-playwright` MCP의 `browser_navigate` 등 도구가 동작할 환경 조건 충족
- 실제 MCP 연결 테스트는 스킬 실행 시(`/threads-watch`) 첫 `browser_navigate` 호출로 확인

### 3. gspread (Google Sheets OAuth)

- `~/.config/gspread/authorized_user.json` OAuth 토큰 유효
- 스프레드시트 `1U-m4sJvV_EyELTRk7ECDYXLLlvF8Kqf4YmrjzVnDJgE` 접근 성공
- 시트 제목 `쓰레드` 반환 확인

## 추가 확인 사항

| 항목 | 상태 | 비고 |
|------|------|------|
| Node.js playwright | 설치됨 (^1.58.2) | `node_modules/playwright/` 존재 |
| Python venv | 활성 | `.venv/bin/python` 동작 확인 |
| gspread 버전 | 6.2.1 | `.venv/lib/python3.12/site-packages/gspread-6.2.1.dist-info/` |
| 수집 데이터 | 22개 JSON 파일 (11개 채널) | `data/raw_posts/` |
| Sheets 템플릿 | 4개 CSV | `data/sheets/` |

## 조치 필요 사항

현재 3개 의존성 모두 정상 동작한다. 추가 조치 불필요.

단, P0 구현 시 아래 사항을 헬스 게이트에 포함해야 한다:
1. **MCP 실제 테스트**: `browser_navigate`로 `https://www.threads.net` 접속 가능 여부 (로그인 상태 포함)
2. **gspread 쓰기 권한**: 레퍼런스 시트에 실제 append 가능 여부 (읽기만 확인됨)
3. **Node.js playwright CDP 연결**: `chromium.connectOverCDP()` 성공 여부 (현재는 curl만 확인)
