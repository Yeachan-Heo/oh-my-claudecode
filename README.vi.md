[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | Tiếng Việt | [Português](README.pt.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

> **Dành cho người dùng Codex:** Hãy xem [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) — cùng trải nghiệm điều phối cho OpenAI Codex CLI.

**Điều phối đa tác tử cho Claude Code. Không cần thời gian làm quen.**

*Đừng học Claude Code. Cứ dùng OMC.*

[Bắt đầu nhanh](#bắt-đầu-nhanh) • [Tài liệu](https://yeachan-heo.github.io/oh-my-claudecode-website) • [Tham chiếu CLI](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#cli-reference) • [Quy trình](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#workflows) • [Hướng dẫn di chuyển](docs/MIGRATION.md) • [Discord](https://discord.gg/PUwSMR9XNk)

---

## Bắt đầu nhanh

**Bước 1: Cài đặt**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Bước 2: Thiết lập**
```bash
/omc-setup
```

Nếu bạn chạy OMC qua `omc --plugin-dir <path>` hoặc `claude --plugin-dir <path>`, hãy thêm `--plugin-dir-mode` vào `omc setup` (hoặc xuất `OMC_PLUGIN_ROOT` trước) để tránh trùng lặp các kỹ năng/tác nhân mà plugin đã cung cấp trong thời gian chạy. Để xem ma trận quyết định đầy đủ và tất cả các cờ có sẵn, hãy xem [phần Plugin directory flags trong REFERENCE.md](./docs/REFERENCE.md#plugin-directory-flags).

<!-- TODO(i18n): verify translation -->

**Bước 3: Xây một thứ gì đó**
```
autopilot: build a REST API for managing tasks
```

Vậy là xong. Mọi thứ còn lại đều tự động.

### Chưa biết bắt đầu từ đâu?

Nếu bạn chưa chắc chắn về yêu cầu, có ý tưởng mơ hồ, hoặc muốn kiểm soát chi tiết thiết kế:

```
/deep-interview "I want to build a task management app"
```

Deep interview sử dụng phương pháp hỏi Socratic để làm rõ suy nghĩ của bạn trước khi viết bất kỳ dòng code nào. Nó phát hiện các giả định ẩn và đo lường mức độ rõ ràng theo các chiều có trọng số, đảm bảo bạn biết chính xác cần xây dựng gì trước khi bắt đầu thực thi.

## Team Mode (Khuyến nghị)

Bắt đầu từ **v4.1.7**, **Team** là bề mặt điều phối chuẩn trong OMC. Các điểm vào cũ như **swarm** và **ultrapilot** vẫn được hỗ trợ, nhưng giờ đây chúng **được chuyển sang Team ở tầng bên dưới**.

```bash
/team 3:executor "fix all TypeScript errors"
```

Team chạy theo pipeline theo từng giai đoạn:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Bật Claude Code native teams trong `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> Nếu teams bị tắt, OMC sẽ cảnh báo và chuyển sang chế độ thực thi không dùng team khi có thể.

### Công nhân CLI tmux — Codex & Gemini (v4.4.0+)

**v4.4.0 xóa các máy chủ MCP Codex/Gemini** (nhà cung cấp `x`, `g`). Dùng `/omc-teams` để khởi động tiến trình CLI thực sự trong các pane tmux phân chia:

```bash
/omc-teams 2:codex   "review auth module for security issues"
/omc-teams 2:gemini  "redesign UI components for accessibility"
/omc-teams 1:claude  "implement the payment flow"
```

Để xử lý công việc Codex + Gemini trong một lệnh, dùng skill **`/ccg`**:

```bash
/ccg Review this PR — architecture (Codex) and UI components (Gemini)
```

| Skill | Công nhân | Tốt nhất cho |
|-------|---------|----------|
| `/omc-teams N:codex` | N pane Codex CLI | Xem xét code, phân tích bảo mật, kiến trúc |
| `/omc-teams N:gemini` | N pane Gemini CLI | Thiết kế UI/UX, tài liệu, tác vụ ngữ cảnh lớn |
| `/omc-teams N:claude` | N pane Claude CLI | Tác vụ chung qua Claude CLI trong tmux |
| `/ccg` | 1 Codex + 1 Gemini | Điều phối ba mô hình song song |

Công nhân được tạo theo yêu cầu và tắt khi hoàn thành tác vụ — không lãng phí tài nguyên. Cần cài `codex` / `gemini` CLI và có phiên tmux đang hoạt động.

> **Lưu ý: Tên package** — Dự án được xây dựng thương hiệu là **oh-my-claudecode** (repo, plugin, commands), nhưng package npm được phát hành dưới tên [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus). Nếu bạn cài công cụ CLI qua npm/bun, hãy dùng `npm install -g oh-my-claude-sisyphus`.

### Cập nhật

```bash
# 1. Cập nhật bản sao marketplace
/plugin marketplace update omc

# 2. Chạy lại setup để làm mới cấu hình
/omc-setup
```

> **Lưu ý:** Nếu tự động cập nhật marketplace chưa được bật, bạn cần chạy `/plugin marketplace update omc` thủ công để đồng bộ phiên bản mới nhất trước khi chạy setup.

Nếu gặp sự cố sau khi cập nhật, hãy xóa cache plugin cũ:

```bash
/omc-doctor
```

<h1 align="center">Your Claude Just Have been Steroided.</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## Vì sao chọn oh-my-claudecode?

- **Không cần cấu hình** - Hoạt động ngay với các mặc định thông minh
- **Điều phối ưu tiên Team** - Team là bề mặt đa tác tử chuẩn (swarm/ultrapilot là lớp tương thích)
- **Giao diện ngôn ngữ tự nhiên** - Không cần nhớ lệnh, chỉ cần mô tả điều bạn muốn
- **Song song hóa tự động** - Tác vụ phức tạp được phân bổ cho các tác tử chuyên biệt
- **Thực thi bền bỉ** - Không bỏ cuộc cho đến khi công việc được xác minh hoàn tất
- **Tối ưu chi phí** - Định tuyến model thông minh giúp tiết kiệm 30-50% token
- **Học từ kinh nghiệm** - Tự động trích xuất và tái sử dụng các mẫu giải quyết vấn đề
- **Hiển thị theo thời gian thực** - HUD statusline cho thấy điều gì đang diễn ra phía sau

---

## Tính năng

### Các chế độ điều phối
Nhiều chiến lược cho nhiều tình huống — từ điều phối dựa trên Team đến refactor tiết kiệm token. [Tìm hiểu thêm →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#execution-modes)

| Mode | Nó là gì | Dùng cho |
|------|------------|---------|
| **Team (khuyến nghị)** | Pipeline chuẩn theo giai đoạn (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Các tác tử phối hợp trên một danh sách nhiệm vụ chung |
| **omc-teams** | Công nhân CLI tmux — tiến trình `claude`/`codex`/`gemini` thực trong pane chia | Tác vụ Codex/Gemini CLI; tạo theo yêu cầu, tắt khi xong |
| **ccg** | Tri-model: Codex (phân tích) + Gemini (thiết kế) song song, Claude tổng hợp | Công việc backend+UI cần cả Codex và Gemini |
| **Autopilot** | Thực thi tự động (một tác tử dẫn dắt) | Làm tính năng end-to-end với ít thao tác phụ |
| **Ultrawork** | Song song tối đa (không dùng team) | Sửa lỗi/refactor kiểu burst song song khi không cần Team |
| **Ralph** | Chế độ bền bỉ với vòng lặp verify/fix | Tác vụ bắt buộc hoàn tất đầy đủ (không có hoàn thành một phần âm thầm) |
| **Pipeline** | Xử lý tuần tự theo giai đoạn | Biến đổi nhiều bước cần thứ tự nghiêm ngặt |
| **Swarm / Ultrapilot (cũ)** | Lớp tương thích chuyển sang **Team** | Quy trình hiện có và tài liệu cũ |

### Điều phối thông minh

- **32 tác tử chuyên biệt** cho kiến trúc, nghiên cứu, thiết kế, kiểm thử, khoa học dữ liệu
- **Định tuyến model thông minh** - Haiku cho tác vụ đơn giản, Opus cho suy luận phức tạp
- **Ủy quyền tự động** - Đúng tác tử cho đúng việc, mọi lúc

### Trải nghiệm nhà phát triển

- **Magic keywords** - `ralph`, `ulw`, `plan` để kiểm soát rõ ràng
- **HUD statusline** - Chỉ số điều phối theo thời gian thực trong status bar
  - Nếu bạn khởi chạy Claude Code trực tiếp bằng `claude --plugin-dir <path>` (bỏ qua shim `omc`), hãy xuất `OMC_PLUGIN_ROOT=<path>` trong shell của bạn để gói HUD phân giải thành cùng một checkout như trình tải plugin. Xem [phần Plugin directory flags trong REFERENCE.md](./docs/REFERENCE.md#plugin-directory-flags) để biết chi tiết.

  <!-- TODO(i18n): verify translation -->
- **Học kỹ năng** - Trích xuất các mẫu tái sử dụng từ các phiên làm việc
- **Phân tích & theo dõi chi phí** - Hiểu mức sử dụng token trên mọi phiên

### Đóng góp

Bạn muốn đóng góp cho OMC? Xem [CONTRIBUTING.md](./CONTRIBUTING.md) để biết hướng dẫn nhà phát triển đầy đủ, bao gồm cách fork, thiết lập checkout cục bộ, liên kết nó làm plugin hoạt động, chạy các bài kiểm tra và gửi PR.

<!-- TODO(i18n): verify translation -->

### Kỹ năng Tùy chỉnh

Học một lần, tái sử dụng mãi mãi. OMC trích xuất kiến thức gỡ lỗi thực chiến thành các tệp kỹ năng di động, tự động tiêm vào khi phù hợp.

| | Phạm vi Dự án | Phạm vi Người dùng |
|---|---|---|
| **Đường dẫn** | `.omc/skills/` | `~/.omc/skills/` |
| **Chia sẻ với** | Nhóm (quản lý phiên bản) | Tất cả dự án của bạn |
| **Ưu tiên** | Cao (ghi đè phạm vi người dùng) | Thấp (dự phòng) |

```yaml
# .omc/skills/fix-proxy-crash.md
---
name: Fix Proxy Crash
description: aiohttp proxy crashes on ClientDisconnectedError
triggers: ["proxy", "aiohttp", "disconnected"]
source: extracted
---
Bọc handler tại server.py:42 trong try/except ClientDisconnectedError...
```

**Quản lý kỹ năng:** `/skill list | add | remove | edit | search`
**Tự động học:** `/skillify` trích xuất các mẫu tái sử dụng với tiêu chuẩn chất lượng nghiêm ngặt
**Tự động tiêm:** Các kỹ năng phù hợp được tải vào ngữ cảnh tự động — không cần gọi thủ công

[Danh sách tính năng đầy đủ →](docs/REFERENCE.md)

---

## Magic Keywords

Các phím tắt tùy chọn cho người dùng nâng cao. Không dùng chúng thì ngôn ngữ tự nhiên vẫn hoạt động tốt.

| Keyword | Hiệu ứng | Ví dụ |
|---------|--------|---------|
| `team` | Điều phối Team chuẩn | `/team 3:executor "fix all TypeScript errors"` |
| `omc-teams` | Công nhân CLI tmux (codex/gemini/claude) | `/omc-teams 2:codex "security review"` |
| `ccg` | Điều phối tri-model Codex+Gemini | `/ccg review this PR` |
| `autopilot` | Thực thi tự động toàn phần | `autopilot: build a todo app` |
| `ralph` | Chế độ bền bỉ | `ralph: refactor auth` |
| `ulw` | Song song tối đa | `ulw fix all errors` |
| `plan` | Phỏng vấn lập kế hoạch | `plan the API` |
| `ralplan` | Đồng thuận lập kế hoạch lặp | `ralplan this feature` |
| `deep-interview` | Làm rõ yêu cầu theo phương pháp Socratic | `deep-interview "vague idea"` |
| `swarm` | **Không còn khuyến nghị** — dùng `team` thay thế | `swarm 5 agents: fix lint errors` |
| `ultrapilot` | **Không còn khuyến nghị** — dùng `team` thay thế | `ultrapilot: build a fullstack app` |

**Ghi chú:**
- **ralph bao gồm ultrawork**: khi bạn kích hoạt chế độ ralph, nó tự động bao gồm thực thi song song của ultrawork.
- Cú pháp `swarm N agents` vẫn được nhận diện để trích xuất số lượng tác tử, nhưng runtime ở v4.1.7+ được hỗ trợ bởi Team.

## Tiện ích

### Chờ Rate Limit

Tự động khôi phục phiên Claude Code khi rate limit được reset.

```bash
omc wait          # Check status, get guidance
omc wait --start  # Enable auto-resume daemon
omc wait --stop   # Disable daemon
```

**Yêu cầu:** tmux (để phát hiện phiên)

### Notification Tags (Telegram/Discord/Slack)

Bạn có thể cấu hình ai sẽ được tag khi stop callbacks gửi tóm tắt phiên.

```bash
# Set/replace tag list
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"
omc config-stop-callback slack --enable --webhook <url> --tag-list "<!here>,<@U1234567890>"

# Incremental updates
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

Hành vi tag:
- Telegram: `alice` trở thành `@alice`
- Discord: hỗ trợ `@here`, `@everyone`, user ID dạng số, và `role:<id>`
- Slack: hỗ trợ `<@MEMBER_ID>`, `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^GROUP_ID>`
- callbacks kiểu `file` bỏ qua các tùy chọn tag

### Tích hợp OpenClaw

Chuyển tiếp các sự kiện phiên Claude Code đến gateway [OpenClaw](https://openclaw.ai/) để kích hoạt phản hồi tự động và quy trình làm việc thông qua tác nhân OpenClaw của bạn.

**Thiết lập nhanh (khuyến nghị):**

```bash
/oh-my-claudecode:configure-notifications
# → Nhập "openclaw" khi được hỏi → chọn "OpenClaw Gateway"
```

**Thiết lập thủ công:** tạo `~/.claude/omc_config.openclaw.json`:

```json
{
  "enabled": true,
  "gateways": {
    "my-gateway": {
      "url": "https://your-gateway.example.com/wake",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" },
      "method": "POST",
      "timeout": 10000
    }
  },
  "hooks": {
    "session-start": { "gateway": "my-gateway", "instruction": "Session started for {{projectName}}", "enabled": true },
    "stop":          { "gateway": "my-gateway", "instruction": "Session stopping for {{projectName}}", "enabled": true }
  }
}
```

**Biến môi trường:**

| Biến | Mô tả |
|------|-------|
| `OMC_OPENCLAW=1` | Bật OpenClaw |
| `OMC_OPENCLAW_DEBUG=1` | Bật ghi log gỡ lỗi |
| `OMC_OPENCLAW_CONFIG=/path/to/config.json` | Thay đổi đường dẫn file cấu hình |

**Các sự kiện hook được hỗ trợ (6 hoạt động trong bridge.ts):**

| Sự kiện | Kích hoạt | Biến template chính |
|---------|----------|-------------------|
| `session-start` | Phiên bắt đầu | `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}` |
| `stop` | Phản hồi Claude hoàn tất | `{{sessionId}}`, `{{projectName}}` |
| `keyword-detector` | Mỗi lần gửi prompt | `{{prompt}}`, `{{sessionId}}` |
| `ask-user-question` | Claude yêu cầu nhập liệu từ người dùng | `{{question}}`, `{{sessionId}}` |
| `pre-tool-use` | Trước khi gọi công cụ (tần suất cao) | `{{toolName}}`, `{{sessionId}}` |
| `post-tool-use` | Sau khi gọi công cụ (tần suất cao) | `{{toolName}}`, `{{sessionId}}` |

**Biến môi trường kênh phản hồi:**

| Biến | Mô tả |
|------|-------|
| `OPENCLAW_REPLY_CHANNEL` | Kênh phản hồi (ví dụ: `discord`) |
| `OPENCLAW_REPLY_TARGET` | ID kênh |
| `OPENCLAW_REPLY_THREAD` | ID thread |

Xem `scripts/openclaw-gateway-demo.mjs` để tham khảo gateway chuyển tiếp payload OpenClaw đến Discord qua ClawdBot.

---

## Tài liệu

- **[Tham chiếu đầy đủ](docs/REFERENCE.md)** - Tài liệu đầy đủ về tính năng
- **[Tham chiếu CLI](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#cli-reference)** - Tất cả lệnh, cờ và công cụ `omc`
- **[Hướng dẫn thông báo](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#notifications)** - Thiết lập Discord, Telegram, Slack và webhook
- **[Quy trình khuyến nghị](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#workflows)** - Chuỗi skill đã qua thực chiến cho các tác vụ phổ biến
- **[Ghi chú phát hành](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#release-notes)** - Có gì mới trong mỗi phiên bản
- **[Website](https://yeachan-heo.github.io/oh-my-claudecode-website)** - Hướng dẫn tương tác và ví dụ
- **[Hướng dẫn di chuyển](docs/MIGRATION.md)** - Nâng cấp từ v2.x
- **[Kiến trúc](docs/ARCHITECTURE.md)** - Cách nó hoạt động phía sau
- **[Theo dõi hiệu năng](docs/PERFORMANCE-MONITORING.md)** - Theo dõi tác tử, gỡ lỗi và tối ưu

---

## Yêu cầu

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Gói thuê bao Claude Max/Pro HOẶC Anthropic API key

### Tùy chọn: Điều phối Multi-AI

OMC có thể tùy chọn điều phối các nhà cung cấp AI bên ngoài để đối chiếu chéo và nhất quán thiết kế. Đây **không bắt buộc** — OMC vẫn hoạt động đầy đủ mà không cần chúng.

| Provider | Cài đặt | Nó mở ra điều gì |
|----------|---------|-----------------|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Design review, UI consistency (1M token context) |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` | Architecture validation, code review cross-check |

**Chi phí:** 3 gói Pro (Claude + Gemini + ChatGPT) bao phủ mọi thứ với khoảng $60/tháng.

---

## Giấy phép

MIT

---

<div align="center">

**Lấy cảm hứng từ:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code) • [Ouroboros](https://github.com/Q00/ouroboros)

**Không cần thời gian làm quen. Sức mạnh tối đa.**

</div>

## Lịch sử sao

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)

## 💖 Ủng hộ dự án này

Nếu Oh-My-ClaudeCode giúp ích cho quy trình làm việc của bạn, hãy cân nhắc tài trợ:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/Yeachan-Heo)

### Vì sao nên tài trợ?

- Duy trì phát triển liên tục
- Hỗ trợ ưu tiên cho nhà tài trợ
- Ảnh hưởng đến lộ trình & tính năng
- Góp phần duy trì mã nguồn mở miễn phí

### Những cách khác để hỗ trợ

- ⭐ Star repo
- 🐛 Báo lỗi
- 💡 Đề xuất tính năng
- 📝 Đóng góp code
