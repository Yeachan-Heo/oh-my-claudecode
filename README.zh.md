[English](README.md) | [한국어](README.ko.md) | 中文 | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)

**Claude Code 的多智能体编排系统。零学习曲线。**

*无需学习 Claude Code，直接使用 OMC。*

[快速开始](#快速开始) • [文档](https://yeachan-heo.github.io/oh-my-claudecode-website) • [迁移指南](docs/MIGRATION.md)

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

> **注意：包命名** — 项目品牌名为 **oh-my-claudecode**（仓库、插件、命令），但 npm 包以 [`oh-my-claudecode`](https://www.npmjs.com/package/oh-my-claude-sisyphus) 发布。通过 npm/bun 安装 CLI 工具时，请使用 `npm install -g oh-my-claude-sisyphus`。

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

| 模式 | 速度 | 适用场景 |
|------|-------|---------|
| **Autopilot** | 快速 | 全自动工作流 |
| **Ultrawork** | 并行 | 任何任务的最大并行化 |
| **Ralph** | 持久 | 必须完整完成的任务 |
| **Ultrapilot** | 3-5倍速 | 多组件系统 |
| **Swarm** | 协同 | 并行独立任务 |
| **Pipeline** | 顺序 | 多阶段处理 |

### 智能编排

- **32 个专业智能体** 涵盖架构、研究、设计、测试、数据科学
- **智能模型路由** - 简单任务用 Haiku，复杂推理用 Opus
- **自动委派** - 每次都选择最合适的智能体

### 开发者体验

- **魔法关键词** - `ralph`、`ulw`、`plan` 提供显式控制
- **HUD 状态栏** - 状态栏实时显示编排指标
- **技能学习** - 从会话中提取可复用模式
- **分析与成本追踪** - 了解所有会话的 token 使用情况

[完整功能列表 →](docs/REFERENCE.md)

---

## 魔法关键词

为高级用户提供的可选快捷方式。不用它们，自然语言也能很好地工作。

| 关键词 | 效果 | 示例 |
|---------|--------|---------|
| `autopilot` | 全自动执行 | `autopilot: build a todo app` |
| `ralph` | 持久模式 | `ralph: refactor auth` |
| `ulw` | 最大并行化 | `ulw fix all errors` |
| `plan` | 规划访谈 | `plan the API` |
| `ralplan` | 迭代规划共识 | `ralplan this feature` |

**ralph 包含 ultrawork：** 激活 ralph 模式时，会自动包含 ultrawork 的并行执行。无需组合关键词。

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

---

## 通知 (Notifications)

你可以为会话生命周期事件接收实时通知。

支持的事件：
- `session-start`
- `session-stop`（当 persistent 模式进入等待/阻塞状态时）
- `session-end`
- `ask-user-question`

### 配置
在 Shell 配置文件（例如 `~/.zshrc`, `~/.bashrc`）中添加以下环境变量：

```bash
# Discord Bot
export OMC_DISCORD_NOTIFIER_BOT_TOKEN="your_bot_token"
export OMC_DISCORD_NOTIFIER_CHANNEL="your_channel_id"

# Telegram
export OMC_TELEGRAM_BOT_TOKEN="your_bot_token"
export OMC_TELEGRAM_CHAT_ID="your_chat_id"

# Slack
export OMC_SLACK_WEBHOOK_URL="your_webhook_url"
export OMC_SLACK_MENTION="<@U1234567890>"  # optional

# 可选 webhook
export OMC_DISCORD_WEBHOOK_URL="your_webhook_url"
```

> 注意：请确保在运行 `claude` 的同一个 Shell 中已加载这些环境变量。

---

## 文档

- **[完整参考](docs/REFERENCE.md)** - 完整功能文档
- **[性能监控](docs/PERFORMANCE-MONITORING.md)** - 智能体追踪、调试和优化
- **[网站](https://yeachan-heo.github.io/oh-my-claudecode-website)** - 交互式指南和示例
- **[迁移指南](docs/MIGRATION.md)** - 从 v2.x 升级
- **[架构](docs/ARCHITECTURE.md)** - 底层工作原理

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

**灵感来源：** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/NexTechFusion/Superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code)

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
