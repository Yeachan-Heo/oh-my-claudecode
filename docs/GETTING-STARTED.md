# Getting Started

> Quick start guide: from installation to your first OMC session.

If you're new to Oh My ClaudeCode (OMC), follow the steps below in order.

1. [Installation](#installation) - Install the OMC plugin and run initial setup
2. [First Session](#first-session) - Run your first task with autopilot
3. [Configuration](#configuration) - Customize settings and agent models per project

### What this guide covers

- How to install the OMC plugin
- Running your first autopilot session and understanding the flow
- Configuring per-user and per-project settings

### Prerequisites

- [Claude Code](https://docs.anthropic.com/claude-code) must be installed
- Claude Max/Pro subscription or an Anthropic API key is required

---

## Installation

OMC is installed exclusively as a Claude Code Plugin. Direct installation via npm or bun is not supported.

### Step 1: Add the marketplace source

Run the following command inside Claude Code:

```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
```

### Step 2: Install the plugin

After adding the marketplace, install the plugin:

```bash
/plugin install oh-my-claudecode
```

### Step 3: Run initial setup

After installation, enter one of the following in Claude Code:

```bash
# Option 1: natural language
setup omc

# Option 2: skill command
/oh-my-claudecode:omc-setup
```

### Prerequisites summary

| Item | Requirement |
|------|-------------|
| Claude Code | Must be installed |
| Authentication | Claude Max/Pro subscription or `ANTHROPIC_API_KEY` environment variable |

### Choosing a setup scope

#### Project-scoped setup (recommended)

Applies OMC only to the current project:

```bash
/oh-my-claudecode:omc-setup --local
```

- Settings are saved to `./.claude/CLAUDE.md`
- No effect on other projects
- Existing global `CLAUDE.md` is preserved

#### Global setup

Applies OMC to all Claude Code sessions:

```bash
/oh-my-claudecode:omc-setup
```

- Settings are saved to `~/.claude/CLAUDE.md`
- Applied across all projects

> ⚠️ **Warning:** Global setup overwrites the existing `~/.claude/CLAUDE.md` file. If you already have configuration there, use project-scoped setup (`--local`) instead.

### Verifying the installation

To confirm everything is working, run the diagnostics tool:

```bash
/oh-my-claudecode:omc-doctor
```

This checks the following:

- Dependency installation status
- Configuration file errors
- Hook installation status
- Agent availability
- Skill registration status

### Platform support

| Platform | Installation | Hook type |
|----------|--------------|-----------|
| macOS | Claude Code Plugin | Bash (.sh) |
| Linux | Claude Code Plugin | Bash (.sh) |
| Windows | WSL2 recommended | Node.js (.mjs) |

> ℹ️ **Note:** Native Windows support is experimental. OMC requires tmux, which is not available on native Windows. Use WSL2 instead.

### Updates

OMC automatically checks for updates every 24 hours. To update manually, re-run the plugin install command.

> ⚠️ **Warning:** After a plugin update, run `/oh-my-claudecode:omc-setup` again to apply the latest configuration.

### Uninstalling

```bash
/plugin uninstall oh-my-claudecode@oh-my-claudecode
```

---

## First Session

Once OMC is installed, run your first task immediately. Open Claude Code and type:

```bash
autopilot build me a hello world app
```

That single line is enough for OMC to run the full development pipeline automatically.

### What happens

When OMC detects the `autopilot` magic keyword, it starts a 5-stage pipeline:

### Stage 1: Expansion

The `analyst` and `architect` agents analyze the idea, clarify requirements, and produce a technical specification.

### Stage 2: Planning

The `planner` agent creates an execution plan. The `critic` agent reviews the plan and identifies gaps.

### Stage 3: Execution

The `executor` agent writes the code. Multiple agents work in parallel when needed.

### Stage 4: QA

Verifies that the build succeeds and tests pass. Automatically fixes failures and re-verifies.

### Stage 5: Validation

Specialist agents perform a final review of functionality, security, and code quality. Work is complete once all pass.

### HUD status display

While work is in progress, you can monitor the current state in the Claude Code status bar (HUD):

```
[OMC] autopilot:execution | agents:3 | todos:2/5 | ctx:45%
```

| Field | Meaning |
|-------|---------|
| `autopilot:execution` | Current stage within the autopilot pipeline |
| `agents:3` | Number of currently active agents |
| `todos:2/5` | Completed tasks / total tasks |
| `ctx:45%` | Context window usage percentage |

To configure the HUD display, run:

```bash
/oh-my-claudecode:hud setup
```

### Starting smaller

If autopilot feels too large, start with a single-task command:

```bash
# Code analysis
analyze why this test is failing

# File search
deepsearch for files that handle authentication

# Simple implementation
ultrawork add a health check endpoint
```

These keywords invoke a single appropriate agent directly, without running the full pipeline.

### Next steps

- [Configuration](#configuration) - Adjust agent models and features for your project
- [Concepts](/docs/concepts) - Understand the relationship between agents, skills, and hooks

---

## Configuration

OMC supports two levels of configuration files.

| Scope | File path | Purpose |
|-------|-----------|---------|
| User (global) | `~/.config/claude-omc/config.jsonc` | Applied to all projects |
| Project | `.claude/omc.jsonc` | Applied to current project only |

> ⚠️ **Warning:** The configuration file format is JSONC (JSON with comments support). It is not a TypeScript config file (`omc.config.ts`).

### Configuration priority

When settings exist from multiple sources, they are merged in the following order (lower entries take precedence):

```
Defaults → User config (~/.config/claude-omc/config.jsonc)
         → Project config (.claude/omc.jsonc)
         → Environment variables
```

### Basic configuration structure

```jsonc
{
  // Per-agent model assignments
  "agents": {
    "explore": { "model": "haiku" },
    "executor": { "model": "sonnet" },
    "architect": { "model": "opus" }
  },

  // Feature toggles
  "features": {
    "parallelExecution": true,
    "lspTools": true,
    "astTools": true
  },

  // Magic keyword customization
  "magicKeywords": {
    "ultrawork": ["ultrawork", "ulw", "uw"],
    "search": ["search", "find", "locate"],
    "analyze": ["analyze", "investigate", "examine"],
    "ultrathink": ["ultrathink", "think", "reason"]
  }
}
```

### Overriding agent models

You can change the AI model used by each agent:

```jsonc
{
  "agents": {
    // Upgrade explore agent to a stronger model
    "explore": { "model": "sonnet" },

    // Upgrade executor to opus for complex projects
    "executor": { "model": "opus" },

    // Cost saving: use haiku for documentation writing
    "writer": { "model": "haiku" }
  }
}
```

#### Default model mapping

| Agent | Default model | Role |
|-------|--------------|------|
| `explore` | haiku | Codebase discovery |
| `writer` | haiku | Documentation writing |
| `executor` | sonnet | Code implementation |
| `debugger` | sonnet | Debugging |
| `designer` | sonnet | UI/UX design |
| `verifier` | sonnet | Verification |
| `tracer` | sonnet | Evidence-driven causal tracing |
| `security-reviewer` | sonnet | Security vulnerabilities and trust boundaries |
| `test-engineer` | sonnet | Test strategy and coverage |
| `qa-tester` | sonnet | Interactive CLI/service runtime validation |
| `scientist` | sonnet | Data and statistical analysis |
| `git-master` | sonnet | Git operations and history management |
| `document-specialist` | sonnet | External documentation and API reference lookup |
| `architect` | opus | System design |
| `planner` | opus | Strategic planning |
| `critic` | opus | Plan review |
| `analyst` | opus | Requirements analysis |
| `code-reviewer` | opus | Comprehensive code review |
| `code-simplifier` | opus | Code clarity and simplification |

### Customizing magic keywords

You can change keywords in four categories via the `magicKeywords` section of `config.jsonc`:

```jsonc
{
  "magicKeywords": {
    // Triggers parallel execution mode
    "ultrawork": ["ultrawork", "ulw", "parallel"],

    // Triggers codebase search mode
    "search": ["search", "find", "locate", "grep"],

    // Triggers analysis mode
    "analyze": ["analyze", "debug", "investigate"],

    // Triggers deep reasoning mode
    "ultrathink": ["ultrathink", "think", "reason"]
  }
}
```

> ℹ️ **Note:** The `magicKeywords` section in `config.jsonc` only allows customizing four categories: `ultrawork`, `search`, `analyze`, and `ultrathink`. Keywords such as `autopilot`, `ralph`, and `ccg` are hardcoded in the keyword-detector hook and cannot be changed via config files.

### Model routing configuration

OMC automatically selects a model tier based on task complexity:

```jsonc
{
  "routing": {
    "enabled": true,
    "defaultTier": "MEDIUM",
    // Force all agents to inherit the parent model
    // (auto-activated when using CC Switch, Bedrock, or Vertex AI)
    "forceInherit": false
  }
}
```

| Tier | Model | Use case |
|------|-------|----------|
| LOW | haiku | Quick lookups, simple tasks |
| MEDIUM | sonnet | Standard implementation, general tasks |
| HIGH | opus | Architecture, deep analysis |

### CLAUDE.md configuration

OMC's default behavior is also configured via `CLAUDE.md` files. Running `/oh-my-claudecode:omc-setup` generates this file automatically.

| Scope | File | Description |
|-------|------|-------------|
| Global | `~/.claude/CLAUDE.md` | Shared settings across all projects |
| Project | `.claude/CLAUDE.md` | Per-project context and overrides |

### When to re-run setup

- After initial installation
- After an OMC update (to apply the latest configuration)
- When switching to a different machine
- When starting a new project (use the `--local` option)
