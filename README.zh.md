[English](README.md) | [한국어](README.ko.md) | 中文 | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)
[![Discord](https://img.shields.io/discord/1466022107199574193?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/qRJw62Gvh7)

> **Codex 用户：** 查看 [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) — 为 OpenAI Codex CLI 提供同样的编排体验。

**Claude Code 的多智能体编排系统。零学习曲线。**

*无需学习 Claude Code，直接使用 OMC。*

[快速开始](#快速开始) • [文档](https://yeachan-heo.github.io/oh-my-claudecode-website) • [CLI 参考](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#cli-reference) • [工作流](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#workflows) • [迁移指南](docs/MIGRATION.md)

---

## 快速开始

**第一步：安装**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**第二步：配置**
```bash
/omc-setup
```

**第三步：开始构建**
```
autopilot: build a REST API for managing tasks
```

就这么简单。其余都是自动的。

### 不确定从哪里开始？

如果你对需求不明确、有模糊的想法，或者想要精细控制设计：

```
/deep-interview "I want to build a task management app"
```

深度访谈使用苏格拉底式提问在编写任何代码之前帮你理清思路。它揭示隐藏假设并通过加权维度衡量清晰度，确保你在执行前明确知道要构建什么。

## Team 模式（推荐）

从 **v4.1.7** 开始，**Team** 是 OMC 的标准编排方式。**swarm** 和 **ultrapilot** 等旧版入口仍受支持，但现在**在底层路由到 Team**。

```bash
/team 3:executor "fix all TypeScript errors"
```

Team 按阶段化流水线运行：

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

在 `~/.claude/settings.json` 中启用 Claude Code 原生团队：

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> 如果团队被禁用，OMC 会发出警告并在可能的情况下回退到非 Team 执行模式。

### tmux CLI 工作者 — Codex & Gemini (v4.4.0+)

**v4.4.0 移除了 Codex/Gemini MCP 服务器**（`x`、`g` 提供商）。请改用 `/omc-teams` 在 tmux 分屏中启动真实的 CLI 进程：

```bash
/omc-teams 2:codex   "review auth module for security issues"
/omc-teams 2:gemini  "redesign UI components for accessibility"
/omc-teams 1:claude  "implement the payment flow"
```

如需在一个命令中混合使用 Codex + Gemini，请使用 **`/ccg`** 技能：

```bash
/ccg Review this PR — architecture (Codex) and UI components (Gemini)
```

| 技能 | 工作者 | 最适合 |
|-------|---------|----------|
| `/omc-teams N:codex` | N 个 Codex CLI 窗格 | 代码审查、安全分析、架构 |
| `/omc-teams N:gemini` | N 个 Gemini CLI 窗格 | UI/UX 设计、文档、大上下文任务 |
| `/omc-teams N:claude` | N 个 Claude CLI 窗格 | 通过 tmux 中的 Claude CLI 处理通用任务 |
| `/ccg` | 1 个 Codex + 1 个 Gemini | 并行三模型编排 |

工作者按需生成，任务完成后自动退出 — 无空闲资源浪费。需要安装 `codex` / `gemini` CLI 并有活跃的 tmux 会话。

> **注意：包命名** — 项目品牌名为 **oh-my-claudecode**（仓库、插件、命令），但 npm 包以 [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus) 发布。通过 npm/bun 安装 CLI 工具时，请使用 `npm install -g oh-my-claude-sisyphus`。

### 更新

```bash
# 1. 更新 marketplace 克隆
/plugin marketplace update omc

# 2. 重新运行设置以刷新配置
/omc-setup
```

> **注意：** 如果 marketplace 自动更新未启用，您需要在运行设置之前手动执行 `/plugin marketplace update omc` 来同步最新版本。

如果更新后遇到问题，清除旧的插件缓存：

```bash
/omc-doctor
```

<h1 align="center">你的 Claude 已被注入超能力。</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## 为什么选择 oh-my-claudecode？

- **无需配置** - 开箱即用，智能默认设置
- **Team 优先编排** - Team 是标准的多智能体界面（swarm/ultrapilot 是兼容性外观）
- **自然语言交互** - 无需记忆命令，只需描述你的需求
- **自动并行化** - 复杂任务自动分配给专业智能体
- **持久执行** - 不会半途而废，直到任务验证完成
- **成本优化** - 智能模型路由节省 30-50% 的 token
- **从经验中学习** - 自动提取并复用问题解决模式
- **实时可见性** - HUD 状态栏显示底层运行状态

---

## 功能特性

### 执行模式
针对不同场景的多种策略 - 从全自动构建到 token 高效重构。[了解更多 →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#execution-modes)

| 模式 | 特点 | 适用场景 |
|------|---------|---------|
| **Team（推荐）** | 阶段化流水线 | 在共享任务列表上协作的 Claude 智能体 |
| **omc-teams** | tmux CLI 工作者 | Codex/Gemini CLI 任务；按需生成，完成后退出 |
| **ccg** | 三模型并行 | Codex（分析）+ Gemini（设计），Claude 合成 |
| **Autopilot** | 自主执行 | 最小化繁琐配置的端到端功能开发 |
| **Ultrawork** | 最大并行 | 不需要 Team 的并行修复/重构 |
| **Ralph** | 持久模式 | 必须完整完成的任务 |
| **Pipeline** | 顺序处理 | 需要严格顺序的多阶段转换 |
| **Swarm / Ultrapilot（旧版）** | 路由到 Team | 现有工作流和旧文档 |

### 智能编排

- **32 个专业智能体** 涵盖架构、研究、设计、测试、数据科学
- **智能模型路由** - 简单任务用 Haiku，复杂推理用 Opus
- **自动委派** - 每次都选择最合适的智能体

### 开发者体验

- **魔法关键词** - `ralph`、`ulw`、`plan` 提供显式控制
- **HUD 状态栏** - 状态栏实时显示编排指标
- **技能学习** - 从会话中提取可复用模式
- **分析与成本追踪** - 了解所有会话的 token 使用情况

### 自定义技能

一次学习，永久复用。OMC 将调试过程中获得的实战知识提取为可移植的技能文件，并在相关场景中自动注入。

| | 项目作用域 | 用户作用域 |
|---|---|---|
| **路径** | `.omc/skills/` | `~/.omc/skills/` |
| **共享范围** | 团队（受版本控制） | 所有项目通用 |
| **优先级** | 高（覆盖用户作用域） | 低（回退） |

```yaml
# .omc/skills/fix-proxy-crash.md
---
name: Fix Proxy Crash
description: aiohttp proxy crashes on ClientDisconnectedError
triggers: ["proxy", "aiohttp", "disconnected"]
source: extracted
---
在 server.py:42 的处理程序外包裹 try/except ClientDisconnectedError...
```

**技能管理：** `/skill list | add | remove | edit | search`
**自动学习：** `/learner` 以严格的质量标准提取可复用模式
**自动注入：** 匹配的技能自动加载到上下文中 — 无需手动调用

[完整功能列表 →](docs/REFERENCE.md)

---

## 魔法关键词

为高级用户提供的可选快捷方式。不用它们，自然语言也能很好地工作。

| 关键词 | 效果 | 示例 |
|---------|--------|---------|
| `team` | 标准 Team 编排 | `/team 3:executor "fix all TypeScript errors"` |
| `omc-teams` | tmux CLI 工作者 (codex/gemini/claude) | `/omc-teams 2:codex "security review"` |
| `ccg` | 三模型 Codex+Gemini 编排 | `/ccg review this PR` |
| `autopilot` | 全自动执行 | `autopilot: build a todo app` |
| `ralph` | 持久模式 | `ralph: refactor auth` |
| `ulw` | 最大并行化 | `ulw fix all errors` |
| `plan` | 规划访谈 | `plan the API` |
| `ralplan` | 迭代规划共识 | `ralplan this feature` |
| `deep-interview` | 苏格拉底式需求澄清 | `deep-interview "vague idea"` |
| `swarm` | **已弃用** — 请使用 `team` | `swarm 5 agents: fix lint errors` |
| `ultrapilot` | **已弃用** — 请使用 `team` | `ultrapilot: build a fullstack app` |

**注意：**
- **ralph 包含 ultrawork：** 激活 ralph 模式时，会自动包含 ultrawork 的并行执行。无需组合关键词。
- `swarm N agents` 语法仍可被识别用于提取智能体数量，但运行时在 v4.1.7+ 中由 Team 支持。

---

## 实用工具

### 速率限制等待

当速率限制重置时自动恢复 Claude Code 会话。

```bash
omc wait          # 检查状态，获取指导
omc wait --start  # 启用自动恢复守护进程
omc wait --stop   # 禁用守护进程
```

**需要：** tmux（用于会话检测）

### 通知标签配置 (Telegram/Discord/Slack)

你可以配置 stop 回调发送会话摘要时要 @ 谁。

```bash
# 设置/替换标签列表
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"
omc config-stop-callback slack --enable --webhook <url> --tag-list "<!here>,<@U1234567890>"

# 增量更新
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

标签规则：
- Telegram：`alice` 会规范化为 `@alice`
- Discord：支持 `@here`、`@everyone`、纯数字用户 ID、`role:<id>`
- Slack：支持 `<@MEMBER_ID>`、`<!channel>`、`<!here>`、`<!everyone>`、`<!subteam^GROUP_ID>`
- `file` 回调会忽略标签选项

### OpenClaw 集成

将 Claude Code 会话事件转发到 [OpenClaw](https://openclaw.ai/) 网关，通过您的 OpenClaw 代理实现自动化响应和工作流程。

**快速设置（推荐）：**

```bash
/oh-my-claudecode:configure-notifications
# → 提示时输入 "openclaw" → 选择 "OpenClaw Gateway"
```

**手动设置：** 创建 `~/.claude/omc_config.openclaw.json`：

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

**环境变量：**

| 变量 | 说明 |
|------|------|
| `OMC_OPENCLAW=1` | 启用 OpenClaw |
| `OMC_OPENCLAW_DEBUG=1` | 启用调试日志 |
| `OMC_OPENCLAW_CONFIG=/path/to/config.json` | 覆盖配置文件路径 |

**支持的钩子事件（bridge.ts 中 6 个活跃）：**

| 事件 | 触发时机 | 主要模板变量 |
|------|---------|-------------|
| `session-start` | 会话开始时 | `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}` |
| `stop` | Claude 响应完成时 | `{{sessionId}}`, `{{projectName}}` |
| `keyword-detector` | 每次提交提示词时 | `{{prompt}}`, `{{sessionId}}` |
| `ask-user-question` | Claude 请求用户输入时 | `{{question}}`, `{{sessionId}}` |
| `pre-tool-use` | 工具调用前（高频） | `{{toolName}}`, `{{sessionId}}` |
| `post-tool-use` | 工具调用后（高频） | `{{toolName}}`, `{{sessionId}}` |

**回复通道环境变量：**

| 变量 | 说明 |
|------|------|
| `OPENCLAW_REPLY_CHANNEL` | 回复通道（例如 `discord`） |
| `OPENCLAW_REPLY_TARGET` | 频道 ID |
| `OPENCLAW_REPLY_THREAD` | 线程 ID |

参见 `scripts/openclaw-gateway-demo.mjs`，这是一个通过 ClawdBot 将 OpenClaw 有效载荷转发到 Discord 的参考网关。

---

## 文档

- **[完整参考](docs/REFERENCE.md)** - 完整功能文档
- **[CLI 参考](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#cli-reference)** - 所有 `omc` 命令、标志和工具
- **[通知指南](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#notifications)** - Discord、Telegram、Slack 和 webhook 设置
- **[推荐工作流](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#workflows)** - 常见任务的经过实战检验的技能链
- **[发布说明](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#release-notes)** - 每个版本的新内容
- **[网站](https://yeachan-heo.github.io/oh-my-claudecode-website)** - 交互式指南和示例
- **[迁移指南](docs/MIGRATION.md)** - 从 v2.x 升级
- **[架构](docs/ARCHITECTURE.md)** - 底层工作原理
- **[性能监控](docs/PERFORMANCE-MONITORING.md)** - 智能体追踪、调试和优化

---

## 环境要求

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Claude Max/Pro 订阅 或 Anthropic API 密钥

### 可选：多 AI 编排

OMC 可以选择性地调用外部 AI 提供商进行交叉验证和设计一致性检查。**非必需** — 没有它们 OMC 也能完整运行。

| 提供商 | 安装 | 功能 |
|--------|------|------|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | 设计审查、UI 一致性（1M token 上下文）|
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` | 架构验证、代码审查交叉检查 |

**费用：** 3 个 Pro 计划（Claude + Gemini + ChatGPT）每月约 $60 即可覆盖所有功能。

---

## 开源协议

MIT

---

<div align="center">

**灵感来源：** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code) • [Ouroboros](https://github.com/Q00/ouroboros)

**零学习曲线。最强大能。**

</div>

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)

## 💖 支持本项目

如果 Oh-My-ClaudeCode 帮助了你的工作流，请考虑赞助：

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/Yeachan-Heo)

### 为什么赞助？

- 保持项目活跃开发
- 赞助者获得优先支持
- 影响路线图和功能
- 帮助维护自由开源

### 其他帮助方式

- ⭐ 为仓库加星
- 🐛 报告问题
- 💡 提出功能建议
- 📝 贡献代码
