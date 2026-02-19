English | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)

**Multi-agent orchestration for Claude Code. Zero learning curve.**

*Don't learn Claude Code. Just use OMC.*

[Get Started](#quick-start) • [Documentation](https://yeachan-heo.github.io/oh-my-claudecode-website) • [Migration Guide](docs/MIGRATION.md)

---

## Quick Start

**Step 1: Install**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Step 2: Setup**
```bash
/omc:omc-setup
```

**Step 3: Build something**
```
autopilot: build a REST API for managing tasks
```

That's it. Everything else is automatic.

## Team Mode (Recommended)

Starting in **v4.1.7**, **Team** is the canonical orchestration surface in OMC. Legacy entrypoints like **swarm** and **ultrapilot** are still supported, but they now **route to Team under the hood**.

```bash
/omc:team 3:executor "fix all TypeScript errors"
```

Team runs as a staged pipeline:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Enable Claude Code native teams in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> If teams are disabled, OMC will warn you and fall back to non-team execution where possible.

> **Note: Package naming** — The project is branded as **oh-my-claudecode** (repo, plugin, commands), but the npm package is published as [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus). If you install the CLI tools via npm/bun, use `npm install -g oh-my-claude-sisyphus`.

### Updating

```bash
# 1. Update the marketplace clone
/plugin marketplace update omc

# 2. Re-run setup to refresh configuration
/omc:omc-setup
```

> **Note:** If marketplace auto-update is not enabled, you must manually run `/plugin marketplace update omc` to sync the latest version before running setup.

If you experience issues after updating, clear the old plugin cache:

```bash
/omc:omc-doctor
```

<h1 align="center">Your Claude Just Have been Steroided.</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## Why oh-my-claudecode?

- **Zero configuration required** - Works out of the box with intelligent defaults
- **Team-first orchestration** - Team is the canonical multi-agent surface (swarm/ultrapilot are compatibility facades)
- **Natural language interface** - No commands to memorize, just describe what you want
- **Automatic parallelization** - Complex tasks distributed across specialized agents
- **Persistent execution** - Won't give up until the job is verified complete
- **Cost optimization** - Smart model routing saves 30-50% on tokens
- **Learn from experience** - Automatically extracts and reuses problem-solving patterns
- **Real-time visibility** - HUD statusline shows what's happening under the hood

---

## Features

### Orchestration Modes
Multiple strategies for different use cases — from Team-backed orchestration to token-efficient refactoring. [Learn more →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#execution-modes)

| Mode | What it is | Use For |
|------|------------|---------|
| **Team (recommended)** | Canonical staged pipeline (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Coordinated agents working on a shared task list |
| **Autopilot** | Autonomous execution (single lead agent) | End-to-end feature work with minimal ceremony |
| **Ultrawork** | Maximum parallelism (non-team) | Burst parallel fixes/refactors where Team isn't needed |
| **Ralph** | Persistent mode with verify/fix loops | Tasks that must complete fully (no silent partials) |
| **Ecomode** | Token-efficient routing | Budget-conscious iteration |
| **Pipeline** | Sequential, staged processing | Multi-step transformations with strict ordering |
| **Swarm / Ultrapilot (legacy)** | Compatibility facades that route to **Team** | Existing workflows and older docs |

### Intelligent Orchestration

- **32 specialized agents** for architecture, research, design, testing, data science
- **Smart model routing** - Haiku for simple tasks, Opus for complex reasoning
- **Automatic delegation** - Right agent for the job, every time

### Developer Experience

- **Magic keywords** - `ralph`, `ulw`, `eco`, `plan` for explicit control
- **HUD statusline** - Real-time orchestration metrics in your status bar
- **Skill learning** - Extract reusable patterns from your sessions
- **Analytics & cost tracking** - Understand token usage across all sessions

[Full feature list →](docs/REFERENCE.md)

---

## Magic Keywords

Optional shortcuts for power users. Natural language works fine without them.

| Keyword | Effect | Example |
|---------|--------|---------|
| `team` | Canonical Team orchestration | `/omc:team 3:executor "fix all TypeScript errors"` |
| `autopilot` | Full autonomous execution | `autopilot: build a todo app` |
| `ralph` | Persistence mode | `ralph: refactor auth` |
| `ulw` | Maximum parallelism | `ulw fix all errors` |
| `eco` | Token-efficient execution | `eco: migrate database` |
| `plan` | Planning interview | `plan the API` |
| `ralplan` | Iterative planning consensus | `ralplan this feature` |
| `swarm` | Legacy keyword (routes to Team) | `swarm 5 agents: fix lint errors` |
| `ultrapilot` | Legacy keyword (routes to Team) | `ultrapilot: build a fullstack app` |

**Notes:**
- **ralph includes ultrawork**: when you activate ralph mode, it automatically includes ultrawork's parallel execution.
- `swarm N agents` syntax is still recognized for agent count extraction, but the runtime is Team-backed in v4.1.7+.

## Utilities

### Rate Limit Wait

Auto-resume Claude Code sessions when rate limits reset.

```bash
omc wait          # Check status, get guidance
omc wait --start  # Enable auto-resume daemon
omc wait --stop   # Disable daemon
```

**Requires:** tmux (for session detection)

### Notification Tags (Telegram/Discord)

You can configure who gets tagged when stop callbacks send session summaries.

```bash
# Set/replace tag list
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"

# Incremental updates
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

Tag behavior:
- Telegram: `alice` becomes `@alice`
- Discord: supports `@here`, `@everyone`, numeric user IDs, and `role:<id>`
- `file` callbacks ignore tag options

---

## Documentation

- **[Full Reference](docs/REFERENCE.md)** - Complete feature documentation
- **[Performance Monitoring](docs/PERFORMANCE-MONITORING.md)** - Agent tracking, debugging, and optimization
- **[Website](https://yeachan-heo.github.io/oh-my-claudecode-website)** - Interactive guides and examples
- **[Migration Guide](docs/MIGRATION.md)** - Upgrade from v2.x
- **[Architecture](docs/ARCHITECTURE.md)** - How it works under the hood

---

## Requirements

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Claude Max/Pro subscription OR Anthropic API key

### Optional: Multi-AI Orchestration

OMC can optionally orchestrate external AI providers for cross-validation and design consistency. These are **not required** — OMC works fully without them.

| Provider | Install | What it enables |
|----------|---------|-----------------|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Design review, UI consistency (1M token context) |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` | Architecture validation, code review cross-check |

**Cost:** 3 Pro plans (Claude + Gemini + ChatGPT) cover everything for ~$60/month.

---

## License

MIT

---

<div align="center">

**Inspired by:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/NexTechFusion/Superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code)

**Zero learning curve. Maximum power.**

</div>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)

## 💖 Support This Project

If Oh-My-ClaudeCode helps your workflow, consider sponsoring:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/Yeachan-Heo)

### Why sponsor?

- Keep development active
- Priority support for sponsors
- Influence roadmap & features
- Help maintain free & open source

### Other ways to help

- ⭐ Star the repo
- 🐛 Report bugs
- 💡 Suggest features
- 📝 Contribute code
