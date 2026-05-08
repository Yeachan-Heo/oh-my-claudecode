[English](README.md) | [한국어](README.ko.md) | 中文 | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

> **Codex 用户：** 查看 [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) — 为 OpenAI Codex CLI 提供同样的编排体验。

**Claude Code 的多智能体编排系统。零学习曲线。**

*无需学习 Claude Code，直接使用 OMC。*

[快速开始](#快速开始) • [文档](https://yeachan-heo.github.io/oh-my-claudecode-website) • [CLI 参考](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#cli-reference) • [工作流](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#workflows) • [迁移指南](docs/MIGRATION.md) • [Discord](https://discord.gg/PUwSMR9XNk)

---

## 核心维护者

| 角色 | 姓名 | GitHub |
| --- | --- | --- |
| 创建者 & 负责人 | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |

## 大使

| 姓名 | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## 文档专家

| 姓名 | GitHub |
| --- | --- |
| devswha | [@devswha](https://github.com/devswha) |

## 顶级贡献者

| 姓名 | GitHub | 提交数 |
| --- | --- | --- |
| JunghwanNA | [@shaun0927](https://github.com/shaun0927) | 65 |
| riftzen-bit | [@riftzen-bit](https://github.com/riftzen-bit) | 52 |
| Seunggwan Song | [@Nathan-Song](https://github.com/Nathan-Song) | 20 |
| BLUE | [@blue-int](https://github.com/blue-int) | 20 |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) | 15 |

## 快速开始

**第一步：安装**

推荐通过 Marketplace/插件安装（适合大多数 Claude Code 用户）。
以下是 Claude Code 斜杠命令，请**逐条输入**（同时粘贴两行会失败）：

```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
```

然后：

```bash
/plugin install oh-my-claudecode
```

如果你更倾向于通过 npm CLI/运行时安装，而非 Marketplace 流程：

```bash
npm i -g oh-my-claude-sisyphus@latest
```

> **已知 npm 警告：** npm 在安装 CLI 时可能会打印 `deprecated prebuild-install@7.1.3`。
> 这来自上游 `better-sqlite3` 原生插件依赖（`better-sqlite3 -> prebuild-install`）；
> `prebuild-install@7.1.3` 仍是当前最新发布版本，因此暂时没有安全的仓库端依赖升级或覆盖方案来消除该警告。
> 该警告在 [#2913](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/2913) 中持续追踪，
> 它本身不代表 OMC CLI 安装失败。

**第二步：配置**

```bash
# 在 Claude Code / OMC 会话中
/setup
/omc-setup

# 从终端
omc setup
```

如果你通过 `omc --plugin-dir <path>` 或 `claude --plugin-dir <path>` 运行 OMC，请在 `omc setup` 中添加 `--plugin-dir-mode`（或提前导出 `OMC_PLUGIN_ROOT`），以避免复制插件在运行时已经提供的技能/代理。有关完整的决策矩阵和所有可用标志，请参阅 [REFERENCE.md 中的 Plugin directory flags 部分](./docs/REFERENCE.md#plugin-directory-flags)。

**第三步：开始构建**

```bash
# 在 Claude Code / OMC 会话中
/autopilot "build a REST API for managing tasks"

# 会话内自然语言快捷方式
autopilot: build a REST API for managing tasks
```

就这么简单。其余都是自动的。

### CLI 命令 vs 会话内技能

OMC 提供两个不同的使用界面：

- **终端 CLI 命令**：在安装 npm/运行时路径（`npm i -g oh-my-claude-sisyphus@latest`）或本地 checkout 后，从 Shell 运行 `omc ...`。
- **会话内技能**：在安装插件/配置流程后，在 Claude Code 会话内运行 `/...`。

| 功能 | 终端 CLI | 会话内技能 | 备注 |
| --- | --- | --- | --- |
| 配置 | `omc setup` | `/setup` 或 `/omc-setup` | 两者都是真实入口点，`/setup` 是最简单的插件优先路径。 |
| 询问提供商 | `omc ask codex "review this patch"` | `/ask codex "review this patch"` | 两者均路由到相同的 advisor 流程。 |
| Team 编排 | `omc team 2:codex "review auth flow"` | `/team 3:executor "fix all TypeScript errors"` | 两者均存在，但运行时不同：`omc team` 启动 tmux CLI 工作者；`/team` 运行会话内原生 Team 工作流。 |
| Autopilot / Ralph / Ultrawork / Deep Interview | — | `/autopilot ...`、`/ralph ...`、`/ultrawork ...`、`/deep-interview ...` | 这些是会话内技能，本仓库没有对应的 `omc autopilot` / `omc ralph` / `omc ultrawork` CLI 子命令。 |
| Autoresearch | `omc autoresearch`（**硬废弃 shim**） | `/deep-interview --autoresearch ...` + `/oh-my-claudecode:autoresearch` | 配置保留在 deep-interview；执行现在属于有状态技能。 |

### 不确定从哪里开始？

如果你对需求不明确、有模糊的想法，或者想要精细控制设计：

```
/deep-interview "I want to build a task management app"
```

深度访谈使用苏格拉底式提问在编写任何代码之前帮你理清思路。它揭示隐藏假设并通过加权维度衡量清晰度，确保你在执行前明确知道要构建什么。

## Team 模式（推荐）

从 **v4.1.7** 开始，**Team** 是 OMC 的标准编排方式。旧版 `swarm` 关键词/技能已移除，请直接使用 `team`。

```bash
/team 3:executor "fix all TypeScript errors"
```

使用 `/team ...` 运行 Claude Code 会话内原生 Team 工作流；使用 `omc team ...` 从 Shell 启动终端 tmux CLI 工作者（`claude` / `codex` / `gemini` 窗格）。

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

**v4.4.0 移除了 Codex/Gemini MCP 服务器**（`x`、`g` 提供商）。请改用 CLI 优先的 Team 运行时（`omc team ...`）在 tmux 分屏中启动真实的 CLI 进程：

```bash
omc team 2:codex "review auth module for security issues"
omc team 2:gemini "redesign UI components for accessibility"
omc team 1:claude "implement the payment flow"
omc team status auth-review
omc team shutdown auth-review
```

`/omc-teams` 作为遗留兼容技能保留，现在路由到 `omc team ...`。

如需在一个命令中混合使用 Codex + Gemini，请使用 **`/ccg`** 技能（通过 `/ask codex` + `/ask gemini` 路由，Claude 合成结果）：

```bash
/ccg Review this PR — architecture (Codex) and UI components (Gemini)
```

| 界面 | 工作者 | 最适合 |
|------|--------|--------|
| `omc team N:codex "..."` | N 个 Codex CLI 窗格 | 代码审查、安全分析、架构 |
| `omc team N:gemini "..."` | N 个 Gemini CLI 窗格 | UI/UX 设计、文档、大上下文任务 |
| `omc team N:claude "..."` | N 个 Claude CLI 窗格 | 通过 tmux 中的 Claude CLI 处理通用任务 |
| `/ccg` | /ask codex + /ask gemini | 三模型 advisor 合成 |

工作者按需生成，任务完成后自动退出 — 无空闲资源浪费。需要安装 `codex` / `gemini` CLI 并有活跃的 tmux 会话。

原生 Team 工作者 worktree 正在通过可选加入/配置门控方式添加。参见 [Native Team Worktree Mode](docs/TEAM-WORKTREE-MODE.md) 了解工作区协议、规范状态根规则、脏 worktree 保留策略和验证清单。

> **注意：包命名** — 项目品牌名为 **oh-my-claudecode**（仓库、插件、命令），但 npm 包以 [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus) 发布。通过 npm/bun 安装 CLI 工具时，请使用 `npm i -g oh-my-claude-sisyphus@latest`。

### 更新

如果通过 npm 安装 OMC，请使用发布的包名升级：

```bash
npm i -g oh-my-claude-sisyphus@latest
```

> **包命名说明：** 仓库、插件和命令品牌为 **oh-my-claudecode**，但发布的 npm 包名为 `oh-my-claude-sisyphus`。

如果通过 Claude Code marketplace/插件流程安装 OMC，请使用以下方式更新：

```bash
# 1. 更新 marketplace 克隆
/plugin marketplace update omc

# 2. 重新运行设置以刷新配置
/setup
```

如果你从本地 checkout 或 git worktree 开发，请先更新 checkout，再从该 worktree 重新运行 setup，以确保活跃运行时与你正在测试的代码一致。

> **注意：** 如果 marketplace 自动更新未启用，你需要在运行设置之前手动执行 `/plugin marketplace update omc` 来同步最新版本。

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
- **Team 优先编排** - Team 是标准的多智能体界面
- **自然语言交互** - 无需记忆命令，只需描述你的需求
- **自动并行化** - 复杂任务自动分配给专业智能体
- **持久执行** - 不会半途而废，直到任务验证完成
- **成本优化** - 智能模型路由节省 30-50% 的 token
- **从经验中学习** - 自动提取并复用问题解决模式
- **实时可见性** - HUD 状态栏显示底层运行状态

---

## 功能特性

### 执行模式

针对不同场景的多种策略 — 从 Team 支持的编排到 token 高效重构。[了解更多 →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#execution-modes)

| 模式 | 特点 | 适用场景 |
|------|---------|---------|
| **Team（推荐）** | 阶段化流水线（`team-plan → team-prd → team-exec → team-verify → team-fix`） | 在共享任务列表上协作的 Claude 智能体 |
| **omc team（CLI）** | tmux CLI 工作者 — 真实的 `claude`/`codex`/`gemini` 进程在分屏中运行 | Codex/Gemini CLI 任务；按需生成，完成后退出 |
| **ccg** | 通过 `/ask codex` + `/ask gemini` 的三模型 advisor，Claude 合成 | 需要 Codex 和 Gemini 的混合后端+UI 工作 |
| **Autopilot** | 自主执行（单个主导智能体） | 最小化繁琐配置的端到端功能开发 |
| **Ultrawork** | 最大并行度（非 Team） | 不需要 Team 的并行修复/重构 |
| **Ralph** | 带验证/修复循环的持久模式 | 必须完整完成的任务（无静默局部完成） |
| **Pipeline** | 顺序、分阶段处理 | 需要严格顺序的多阶段转换 |
| **Ultrapilot（旧版）** | 已废弃兼容模式（autopilot pipeline 别名） | 现有工作流和旧文档 |

### 智能编排

- **19 个专业智能体**（含分级变体）涵盖架构、研究、设计、测试、数据科学
- **智能模型路由** - 简单任务用 Haiku，复杂推理用 Opus
- **自动委派** - 每次都选择最合适的智能体

### 开发者体验

- **魔法关键词** - `ralph`、`ulw`、`ralplan`；Team 通过 `/team` 显式使用
- **HUD 状态栏** - 状态栏实时显示编排指标
  - 如果你直接使用 `claude --plugin-dir <path>` 启动 Claude Code（绕过 `omc` shim），请在 shell 中导出 `OMC_PLUGIN_ROOT=<path>`，以便 HUD bundle 解析到与插件加载器相同的 checkout。详情见 [REFERENCE.md 中的 Plugin directory flags 部分](./docs/REFERENCE.md#plugin-directory-flags)。
- **技能学习** - 从会话中提取可复用模式
- **分析与成本追踪** - 了解所有会话的 token 使用情况

### 贡献

想为 OMC 做贡献？请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解完整的开发者指南，包括如何 fork、设置本地 checkout、将其链接为活跃插件、运行测试和提交 PR。

### 自定义技能

一次学习，永久复用。OMC 将调试过程中获得的实战知识提取为可移植的技能文件，并在相关场景中自动注入。

| | 项目作用域 | 用户作用域 |
|---|---|---|
| **路径** | `.omc/skills/` | `~/.omc/skills/` |
| **共享范围** | 团队（提交技能文件以在 worktree 间保留） | 所有项目通用 |
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
**自动学习：** `/skillify` 以严格的质量标准提取可复用模式
**自动注入：** 匹配的技能自动加载到上下文中 — 无需手动调用

项目作用域技能存储在 `.omc/skills/` 中，如果你希望共享，应将其提交到版本库。如果你在已链接的 git worktree 内创建技能文件但未提交，删除该 worktree 后这些文件将消失。

[完整功能列表 →](docs/REFERENCE.md)

---

## 会话内快捷方式

这些快捷方式在 **Claude Code / OMC 会话内**运行，而非终端 CLI 命令。对于 Shell 命令，请使用上面展示的 `omc ...` 形式。Team 模式是显式的：在会话内使用 `/team ...`，或从 Shell 使用 `omc team ...`，而非期望裸 `team` 关键词触发。

| 会话内形式 | 类型 | 效果 | 示例 |
| --- | --- | --- | --- |
| `/team` | 斜杠技能 | 标准 Team 编排 | `/team 3:executor "fix all TypeScript errors"` |
| `/ccg` | 斜杠技能 | `/ask codex` + `/ask gemini` 合成 | `/ccg review this PR` |
| `/autopilot` / `autopilot` | 技能 / 提示触发 | 全自动执行 | `/autopilot "build a todo app"` |
| `/ralph` / `ralph` | 技能 / 提示触发 | 持久模式 | `/ralph "refactor auth"` |
| `/ultrawork` / `ulw` | 技能 / 提示触发 | 最大并行度 | `/ultrawork "fix all errors"` |
| `/ralplan` / `ralplan` | 技能 / 提示触发 | 迭代规划共识 | `/ralplan "plan this feature"` |
| `/deep-interview` | 斜杠技能 | 苏格拉底式需求澄清 | `/deep-interview "vague idea"` |
| `deepsearch` | 提示触发 | 聚焦代码库的搜索路由 | `deepsearch for auth middleware` |
| `ultrathink` | 提示触发 | 深度推理模式 | `ultrathink about this architecture` |
| `cancelomc`、`stopomc` | 提示触发 | 停止活跃 OMC 模式 | `stopomc` |

**注意：**

- **ralph 包含 ultrawork：** 激活 ralph 模式时，会自动包含 ultrawork 的并行执行。
- `swarm` 兼容别名已移除；请将现有提示迁移到 `/team` 语法。
- `plan this` / `plan the` 关键词触发已移除；请使用 `ralplan` 或显式 `/oh-my-claudecode:omc-plan`。

## 实用工具

### Provider Advisor（`omc ask` / `/ask`）

运行本地 provider CLI 并将 Markdown 结果保存到 `.omc/artifacts/ask/` 下。

```bash
# 终端 CLI
omc ask claude "review this migration plan"
omc ask codex --prompt "identify architecture risks"
omc ask gemini --prompt "propose UI polish ideas"
omc ask claude --agent-prompt executor --prompt "draft implementation steps"

# 在 Claude Code / OMC 会话中
/ask claude "review this migration plan"
/ask codex "identify architecture risks"
```

规范环境变量：

- `OMC_ASK_ADVISOR_SCRIPT`
- `OMC_ASK_ORIGINAL_TASK`

第一阶段别名 `OMX_ASK_ADVISOR_SCRIPT` 和 `OMX_ASK_ORIGINAL_TASK` 在带有废弃警告的情况下仍可接受。

### Autoresearch（有状态技能）

`omc autoresearch` 现在是**硬废弃 shim**。权威工作流为：

```bash
/deep-interview --autoresearch improve startup performance
/oh-my-claudecode:autoresearch
```

- `deep-interview --autoresearch` 生成/配置任务和评估器
- `autoresearch` 运行有界的、单任务有状态循环
- 每次迭代记录评估 JSON 和 Markdown 决策日志
- 未通过的迭代继续执行
- 严格停止由显式最大运行时上限控制

### 速率限制等待

当速率限制重置时自动恢复 Claude Code 会话。

```bash
omc wait          # 检查状态，获取指导
omc wait --start  # 启用自动恢复守护进程
omc wait --stop   # 禁用守护进程
```

**需要：** tmux（用于会话检测）

### 监控与可观测性

使用 HUD 进行实时观测，使用当前会话/重放 artifact 进行会话后检查：

- HUD 预设：`/oh-my-claudecode:hud setup`，然后使用支持的预设，例如 `"omcHud": { "preset": "focused" }`
- 会话摘要：`.omc/sessions/*.json`
- 重放日志：`.omc/state/agent-replay-*.jsonl`
- 实时 HUD 渲染：`omc hud`

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

将 Claude Code 会话事件转发到 [OpenClaw](https://openclaw.ai/) 网关，通过你的 OpenClaw 代理实现自动化响应和工作流程。

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
- **[CLI 参考](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#cli-reference)** - 所有 `omc` 命令、标志和工具
- **[通知指南](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#notifications)** - Discord、Telegram、Slack 和 webhook 设置
- **[推荐工作流](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#workflows)** - 常见任务的经过实战检验的技能链
- **[发布说明](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#release-notes)** - 每个版本的新内容
- **[网站](https://yeachan-heo.github.io/oh-my-claudecode-website)** - 交互式指南和示例
- **[迁移指南](docs/MIGRATION.md)** - 从 v2.x 升级
- **[架构](docs/ARCHITECTURE.md)** - 底层工作原理
- **[性能监控](docs/PERFORMANCE-MONITORING.md)** - 智能体追踪、调试和优化
- **[安全指南](SECURITY.md)** - 企业部署与加固

---

## 环境要求

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Claude Max/Pro 订阅 或 Anthropic API 密钥

### 平台 & tmux

OMC 的 `omc team` 和速率限制检测等功能需要 **tmux**：

| 平台 | tmux 提供方 | 安装 |
|------|------------|------|
| macOS | [tmux](https://github.com/tmux/tmux) | `brew install tmux` |
| Ubuntu/Debian | tmux | `sudo apt install tmux` |
| Fedora | tmux | `sudo dnf install tmux` |
| Arch | tmux | `sudo pacman -S tmux` |
| Windows | [psmux](https://github.com/marlocarlo/psmux)（原生） | `winget install psmux` |
| Windows (WSL2) | tmux（WSL 内部） | `sudo apt install tmux` |

> **Windows 用户：** [psmux](https://github.com/marlocarlo/psmux) 为 Windows 提供支持 76 个 tmux 兼容命令的原生 `tmux` 二进制文件，无需 WSL。

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

<!-- OMC:FEATURED-CONTRIBUTORS:START -->
## OMC 贡献者精选

所有历史 OMC 贡献者中，排名靠前的个人非 fork、非归档仓库（100+ GitHub 星标）。

- [@Yeachan-Heo](https://github.com/Yeachan-Heo) — [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) (⭐ 32k)
- [@junhoyeo](https://github.com/junhoyeo) — [tokscale](https://github.com/junhoyeo/tokscale) (⭐ 2.3k)
- [@psmux](https://github.com/psmux) — [psmux](https://github.com/psmux/psmux) (⭐ 1.6k)
- [@BowTiedSwan](https://github.com/BowTiedSwan) — [buildflow](https://github.com/BowTiedSwan/buildflow) (⭐ 291)
- [@alohays](https://github.com/alohays) — [awesome-visual-representation-learning-with-transformers](https://github.com/alohays/awesome-visual-representation-learning-with-transformers) (⭐ 268)
- [@jcwleo](https://github.com/jcwleo) — [random-network-distillation-pytorch](https://github.com/jcwleo/random-network-distillation-pytorch) (⭐ 261)
- [@emgeee](https://github.com/emgeee) — [mean-tutorial](https://github.com/emgeee/mean-tutorial) (⭐ 200)
- [@shaun0927](https://github.com/shaun0927) — [openchrome](https://github.com/shaun0927/openchrome) (⭐ 186)
- [@MeroZemory](https://github.com/MeroZemory) — [ida-multi-mcp](https://github.com/MeroZemory/ida-multi-mcp) (⭐ 182)
- [@anduinnn](https://github.com/anduinnn) — [HiFiNi-Auto-CheckIn](https://github.com/anduinnn/HiFiNi-Auto-CheckIn) (⭐ 171)
- [@HaD0Yun](https://github.com/HaD0Yun) — [Gopeak-godot-mcp](https://github.com/HaD0Yun/Gopeak-godot-mcp) (⭐ 148)
- [@Znuff](https://github.com/Znuff) — [consolas-powerline](https://github.com/Znuff/consolas-powerline) (⭐ 146)

<!-- OMC:FEATURED-CONTRIBUTORS:END -->

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
