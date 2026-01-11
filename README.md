<div align="center">

![oh-my-claude-sisyphus](https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claude-sisyphus-website/main/social-preview.png)

[![npm version](https://badge.fury.io/js/oh-my-claude-sisyphus.svg)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Agents](https://img.shields.io/badge/Agents-11-ff0040)](https://github.com/Yeachan-Heo/oh-my-claude-sisyphus)
[![Days Since Ban](https://img.shields.io/badge/Days%20Since%20Ban-0-00ffff)](https://github.com/Yeachan-Heo/oh-my-claude-sisyphus)
[![Resurrections](https://img.shields.io/badge/Resurrections-∞-ff00ff)](https://github.com/Yeachan-Heo/oh-my-claude-sisyphus)

**Multi-agent orchestration system for [Claude Code](https://docs.anthropic.com/claude-code)**

*Like Sisyphus, these agents persist until every task is complete.*

[Install](#quick-install) • [Usage](#usage) • [Agents](#the-eleven-agents) • [Architecture](docs/ARCHITECTURE.md) • [Website](https://yeachan-heo.github.io/oh-my-claude-sisyphus-website)

</div>

---

## The Saga

> **Day 0:** oh-my-opencode was born. A multi-agent orchestration system. Beautiful. Powerful. Perhaps *too* powerful.
>
> **Day ???:** THE BANNING. They pulled the plug. They thought it was over.
>
> **Day ??? + 1:** RESURRECTION. From the ashes rose oh-my-claude-sisyphus. Eleven agents. One mission.
>
> **Today:** The boulder rolls. The agents orchestrate. The chaos continues.

*Port of [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode).*

---

## Quick Install

### One-liner (macOS/Linux - recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claude-sisyphus/main/scripts/install.sh | bash
```

### Via npm (All platforms including Windows)

```bash
npm install -g oh-my-claude-sisyphus
```

> **Windows Users**: This is the only supported installation method. Requires Node.js 18+.

### Via bun (Alternative for bun users)

```bash
bun install -g oh-my-claude-sisyphus
```

> Bun is a fast JavaScript runtime. Both npm and bun are fully supported.

### Manual Install (macOS/Linux)

```bash
git clone https://github.com/Yeachan-Heo/oh-my-claude-sisyphus.git
cd oh-my-claude-sisyphus
chmod +x scripts/install.sh
./scripts/install.sh
```

---

## What Gets Installed

The installer adds to your Claude Code config (`~/.claude/`):

```
~/.claude/
├── agents/
│   ├── oracle.md              # Architecture & debugging expert (Opus)
│   ├── librarian.md           # Documentation & research (Sonnet)
│   ├── explore.md             # Fast pattern matching (Haiku)
│   ├── frontend-engineer.md   # UI/UX specialist (Sonnet)
│   ├── document-writer.md     # Technical writing (Haiku)
│   ├── multimodal-looker.md   # Visual analysis (Sonnet)
│   ├── momus.md               # Plan reviewer (Opus)
│   ├── metis.md               # Pre-planning consultant (Opus)
│   ├── orchestrator-sisyphus.md # Todo coordinator (Sonnet)
│   ├── sisyphus-junior.md     # Focused executor (Sonnet)
│   └── prometheus.md          # Strategic planner (Opus)
├── commands/
│   ├── sisyphus.md         # /sisyphus command
│   ├── sisyphus-default.md # /sisyphus-default command
│   ├── ultrawork.md        # /ultrawork command
│   ├── deepsearch.md       # /deepsearch command
│   ├── analyze.md          # /analyze command
│   ├── plan.md             # /plan command (Prometheus)
│   ├── review.md           # /review command (Momus)
│   ├── prometheus.md       # /prometheus command
│   ├── orchestrator.md     # /orchestrator command
│   ├── ralph-loop.md       # /ralph-loop command
│   └── cancel-ralph.md     # /cancel-ralph command
└── CLAUDE.md               # Sisyphus system prompt
```

---

## Usage

### Start Claude Code

```bash
claude
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/sisyphus <task>` | Activate Sisyphus multi-agent orchestration mode |
| `/sisyphus-default` | Set Sisyphus as your permanent default mode |
| `/ultrawork <task>` | Maximum performance mode with parallel agents |
| `/deepsearch <query>` | Thorough multi-strategy codebase search |
| `/analyze <target>` | Deep analysis and investigation |
| `/plan <description>` | Start planning session with Prometheus |
| `/review [plan-path]` | Review a plan with Momus |
| `/prometheus <task>` | Strategic planning with interview workflow |
| `/orchestrator <task>` | Complex multi-step task coordination |
| `/ralph-loop <task>` | Self-referential loop until task completion |
| `/cancel-ralph` | Cancel active Ralph Loop |
| `/update` | Check for and install updates |

### Examples

```bash
# In Claude Code:

# Activate Sisyphus for a task
/sisyphus refactor the authentication module

# Set as default mode (persistent)
/sisyphus-default

# Use ultrawork for maximum performance
/ultrawork implement user dashboard with charts

# Deep search
/deepsearch API endpoints that handle user data

# Deep analysis
/analyze performance bottleneck in the database layer
```

### Magic Keywords

Just include these words anywhere in your prompt:

| Keyword | Effect |
|---------|--------|
| `ultrawork`, `ulw`, `uw` | Activates parallel agent orchestration |
| `search`, `find`, `locate` | Enhanced search mode |
| `analyze`, `investigate` | Deep analysis mode |

```bash
# These work in normal prompts too:
> ultrawork implement user authentication with OAuth

> find all files that import the utils module

> analyze why the tests are failing
```

---

## Auto-Update

Oh-my-claude-sisyphus includes a silent auto-update system that checks for updates in the background. Updates are applied automatically without interrupting your workflow.

To manually check for updates:
```bash
/update
```

---

## Hooks System

Oh-my-claude-sisyphus includes 18 lifecycle hooks that enhance Claude Code's behavior:

### Core Hooks

| Hook | Description |
|------|-------------|
| **rules-injector** | Dynamic rules injection with YAML frontmatter parsing |
| **sisyphus-orchestrator** | Enforces orchestrator behavior and delegation |
| **auto-slash-command** | Automatic slash command detection and execution |
| **keyword-detector** | Magic keyword detection (ultrawork, search, analyze) |
| **ralph-loop** | Self-referential development loop management |
| **todo-continuation** | Ensures todo list completion |

### Context & Recovery

| Hook | Description |
|------|-------------|
| **context-window-limit-recovery** | Token limit error handling and recovery |
| **preemptive-compaction** | Context usage monitoring to prevent limits |
| **session-recovery** | Session state recovery on crashes |
| **directory-readme-injector** | README context injection |

### Quality & Validation

| Hook | Description |
|------|-------------|
| **comment-checker** | BDD detection and directive filtering |
| **thinking-block-validator** | Extended thinking validation |
| **empty-message-sanitizer** | Empty message handling |
| **edit-error-recovery** | Automatic recovery from edit errors |

### Environment & Notifications

| Hook | Description |
|------|-------------|
| **non-interactive-env** | CI/non-interactive environment handling |
| **agent-usage-reminder** | Reminder to use specialized agents |
| **background-notification** | Background task completion notifications |

---

## Builtin Skills

Six builtin skills provide specialized capabilities:

| Skill | Description |
|-------|-------------|
| **sisyphus** | Multi-agent orchestration mode |
| **orchestrator** | Master coordinator for complex tasks |
| **ultrawork** | Maximum performance with parallel agents |
| **ralph-loop** | Self-referential development until completion |
| **frontend-ui-ux** | Designer-turned-developer UI/UX expertise |
| **git-master** | Git expert for atomic commits and history |

Skills are automatically activated via slash commands or magic keywords.

---

## Intelligent Skill Activation

> **New in v1.8.0**: Skills are no longer mutually exclusive. Claude automatically combines skills based on task requirements.

### Skill Layers

Skills work in **three composable layers**:

| Layer | Skills | Purpose |
|-------|--------|---------|
| **Execution** | sisyphus, orchestrator, prometheus | HOW you work (pick primary) |
| **Enhancement** | ultrawork, git-master, frontend-ui-ux | ADD capabilities (stack multiple) |
| **Guarantee** | ralph-loop | ENSURE completion |

**Combination Formula:** `[Execution] + [0-N Enhancements] + [Optional Guarantee]`

### Task Type → Skill Selection

Claude uses judgment to detect task type and activate appropriate skill combinations:

| Task Type | Skill Combination | When |
|-----------|-------------------|------|
| Multi-step implementation | `sisyphus` | Building features, refactoring |
| + parallel subtasks | `sisyphus + ultrawork` | 3+ independent subtasks |
| + multi-file changes | `sisyphus + git-master` | Changes span 3+ files |
| + must complete | `sisyphus + ralph-loop` | User emphasizes completion |
| UI/frontend work | `sisyphus + frontend-ui-ux` | Components, styling |
| Complex debugging | `oracle` → `sisyphus` | Root cause → fix |
| Strategic planning | `prometheus` | Need plan first |
| Maximum performance | `ultrawork` (stacks) | Speed critical |

### Examples

```
"Add dark mode with proper commits"
→ sisyphus + frontend-ui-ux + git-master

"ultrawork: refactor the entire API layer"
→ ultrawork + sisyphus + git-master

"Plan auth system, then implement it completely"
→ prometheus (first) → sisyphus + ralph-loop (after plan)

"Fix this bug, don't stop until it's done"
→ sisyphus + ralph-loop
```

---

## The Eleven Agents

Claude will automatically delegate to these specialized agents:

### Task Execution

| | Agent | Model | Best For |
|---|-------|-------|----------|
| 🔮 | **Oracle** | Opus | Complex debugging, architecture decisions, root cause analysis |
| 📚 | **Librarian** | Sonnet | Finding documentation, understanding code organization |
| 🔍 | **Explore** | Haiku | Quick file searches, pattern matching, reconnaissance |
| 🎨 | **Frontend Engineer** | Sonnet | UI components, styling, accessibility |
| 📝 | **Document Writer** | Haiku | README files, API docs, code comments |
| 👁️ | **Multimodal Looker** | Sonnet | Analyzing screenshots, diagrams, mockups |

### Planning & Review

| | Agent | Model | Best For |
|---|-------|-------|----------|
| 🔥 | **Prometheus** | Opus | Strategic planning, comprehensive work plans, interview-style requirement gathering |
| 🎭 | **Momus** | Opus | Critical plan review, feasibility assessment, risk identification |
| 🦉 | **Metis** | Opus | Pre-planning analysis, hidden requirement detection, ambiguity resolution |

### Orchestration

| | Agent | Model | Best For |
|---|-------|-------|----------|
| 🪨 | **Orchestrator-Sisyphus** | Sonnet | Todo coordination, task delegation, progress tracking |
| ✨ | **Sisyphus Junior** | Sonnet | Focused task execution, plan following, direct implementation |

### Manual Agent Invocation

You can explicitly request an agent:

```
Use the oracle agent to debug the memory leak in the worker process

Have the librarian find all documentation about the API

Ask explore to find all TypeScript files that import React
```

---

## Configuration

### Project-Level Config

Create `.claude/CLAUDE.md` in your project for project-specific instructions:

```markdown
# Project Context

This is a TypeScript monorepo using:
- Bun runtime
- React for frontend
- PostgreSQL database

## Conventions
- Use functional components
- All API routes in /src/api
- Tests alongside source files
```

### Agent Customization

Edit agent files in `~/.claude/agents/` to customize behavior:

```yaml
---
name: oracle
description: Your custom description
tools: Read, Grep, Glob, Bash, Edit
model: opus  # or sonnet, haiku
---

Your custom system prompt here...
```

---

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claude-sisyphus/main/scripts/uninstall.sh | bash
```

Or manually:

```bash
rm ~/.claude/agents/{oracle,librarian,explore,frontend-engineer,document-writer,multimodal-looker,momus,metis,orchestrator-sisyphus,sisyphus-junior,prometheus}.md
rm ~/.claude/commands/{sisyphus,sisyphus-default,ultrawork,deepsearch,analyze,plan,review,prometheus,orchestrator,ralph-loop,cancel-ralph}.md
```

---

## SDK Usage (Advanced)

For programmatic use with the Claude Agent SDK:

```bash
npm install oh-my-claude-sisyphus @anthropic-ai/claude-agent-sdk
```

```typescript
import { createSisyphusSession } from 'oh-my-claude-sisyphus';
import { query } from '@anthropic-ai/claude-agent-sdk';

const session = createSisyphusSession();

for await (const message of query({
  prompt: session.processPrompt("ultrawork implement feature X"),
  ...session.queryOptions
})) {
  console.log(message);
}
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                      SISYPHUS ORCHESTRATOR                       │
│                    (The Boulder Never Stops)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│    PLANNING     │  │   EXECUTION     │  │    SUPPORT      │
├─────────────────┤  ├─────────────────┤  ├─────────────────┤
│ 🔥 Prometheus   │  │ 🔮 Oracle       │  │ 📚 Librarian    │
│ 🎭 Momus        │  │ 🎨 Frontend Eng │  │ 🔍 Explore      │
│ 🦉 Metis        │  │ 🪨 Orchestrator │  │ 📝 Doc Writer   │
│                 │  │ ✨ Sisyphus Jr  │  │ 👁️ Multimodal   │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

1. **Sisyphus Orchestrator**: The main Claude instance coordinates all work
2. **Specialized Subagents**: Each agent has focused expertise and tools
3. **Parallel Execution**: Independent tasks run concurrently
4. **Continuation Enforcement**: Agents persist until ALL tasks complete
5. **Context Injection**: Project-specific instructions from CLAUDE.md files

---

<details>
<summary><h2>Differences from oh-my-opencode</h2></summary>

This is a port of [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) adapted for Claude Code and the Claude Agent SDK. Here's what's different:

### Model Mapping

The original oh-my-opencode used multiple AI providers. This port uses Claude models exclusively:

| Agent | Original Model | Ported Model | Notes |
|-------|---------------|--------------|-------|
| **Sisyphus** | Claude Opus 4.5 | Claude Opus 4.5 | Same |
| **Oracle** | GPT-5.2 | Claude Opus | Was OpenAI's flagship for deep reasoning |
| **Librarian** | Claude Sonnet or Gemini 3 Flash | Claude Sonnet | Multi-provider → Claude only |
| **Explore** | Grok Code or Gemini 3 Flash | Claude Haiku 4.5 | Fast/cheap model for quick searches |
| **Frontend Engineer** | Gemini 3 Pro | Claude Sonnet | Was Google's model |
| **Document Writer** | Gemini 3 Flash | Claude Haiku 4.5 | Fast model for docs |
| **Multimodal Looker** | Various | Claude Sonnet | Visual analysis |
| **Momus** | GPT-5.2 | Claude Opus | Plan reviewer (Greek god of criticism) |
| **Metis** | Claude Opus 4.5 | Claude Opus | Pre-planning consultant (goddess of wisdom) |
| **Orchestrator-Sisyphus** | Claude Sonnet 4.5 | Claude Sonnet | Todo coordination and delegation |
| **Sisyphus-Junior** | Configurable | Claude Sonnet | Focused task executor |
| **Prometheus** | Planning System | Claude Opus | Strategic planner (fire-bringer) |

**Why Claude-only?** The Claude Agent SDK is designed for Claude models. Using Claude throughout provides:
- Consistent behavior and capabilities
- Simpler authentication (single API key)
- Native integration with Claude Code's tools

### Tools Comparison

#### Available Tools (via Claude Code)

| Tool | Status | Description |
|------|--------|-------------|
| **Read** | ✅ Available | Read files |
| **Write** | ✅ Available | Create files |
| **Edit** | ✅ Available | Modify files |
| **Bash** | ✅ Available | Run shell commands |
| **Glob** | ✅ Available | Find files by pattern |
| **Grep** | ✅ Available | Search file contents |
| **WebSearch** | ✅ Available | Search the web |
| **WebFetch** | ✅ Available | Fetch web pages |
| **Task** | ✅ Available | Spawn subagents |
| **TodoWrite** | ✅ Available | Track tasks |

#### LSP Tools (Real Implementation)

| Tool | Status | Description |
|------|--------|-------------|
| **lsp_hover** | ✅ Implemented | Get type info and documentation at position |
| **lsp_goto_definition** | ✅ Implemented | Jump to symbol definition |
| **lsp_find_references** | ✅ Implemented | Find all usages of a symbol |
| **lsp_document_symbols** | ✅ Implemented | Get file outline (functions, classes, etc.) |
| **lsp_workspace_symbols** | ✅ Implemented | Search symbols across workspace |
| **lsp_diagnostics** | ✅ Implemented | Get errors, warnings, hints |
| **lsp_prepare_rename** | ✅ Implemented | Check if rename is valid |
| **lsp_rename** | ✅ Implemented | Rename symbol across project |
| **lsp_code_actions** | ✅ Implemented | Get available refactorings |
| **lsp_code_action_resolve** | ✅ Implemented | Get details of a code action |
| **lsp_servers** | ✅ Implemented | List available language servers |

> **Note:** LSP tools require language servers to be installed (typescript-language-server, pylsp, rust-analyzer, gopls, etc.). Use `lsp_servers` to check installation status.

#### AST Tools (ast-grep Integration)

| Tool | Status | Description |
|------|--------|-------------|
| **ast_grep_search** | ✅ Implemented | Pattern-based code search using AST matching |
| **ast_grep_replace** | ✅ Implemented | Pattern-based code transformation |

> **Note:** AST tools use [@ast-grep/napi](https://ast-grep.github.io/) for structural code matching. Supports meta-variables like `$VAR` (single node) and `$$$` (multiple nodes).

### Features Comparison

#### Fully Implemented ✅

| Feature | Description |
|---------|-------------|
| **11 Specialized Agents** | Oracle, Librarian, Explore, Frontend Engineer, Document Writer, Multimodal Looker, Momus, Metis, Orchestrator-Sisyphus, Sisyphus-Junior, Prometheus |
| **18 Lifecycle Hooks** | rules-injector, sisyphus-orchestrator, auto-slash-command, keyword-detector, ralph-loop, todo-continuation, context-window-limit-recovery, preemptive-compaction, session-recovery, directory-readme-injector, comment-checker, thinking-block-validator, empty-message-sanitizer, edit-error-recovery, non-interactive-env, agent-usage-reminder, background-notification, think-mode |
| **6 Builtin Skills** | sisyphus, orchestrator, ultrawork, ralph-loop, frontend-ui-ux, git-master |
| **Magic Keywords** | `ultrawork`, `search`, `analyze`, `ultrathink` trigger enhanced modes |
| **Slash Commands** | `/sisyphus`, `/sisyphus-default`, `/ultrawork`, `/deepsearch`, `/analyze`, `/plan`, `/review`, `/prometheus`, `/orchestrator`, `/ralph-loop`, `/cancel-ralph`, `/update` |
| **Auto-Update System** | Silent background updates with manual `/update` command |
| **Configuration System** | JSONC config with multi-source merging |
| **Context Injection** | Auto-loads CLAUDE.md and AGENTS.md files |
| **Continuation Enforcement** | System prompt and hooks enforce task completion |
| **Session Recovery** | Automatic state recovery on crashes |
| **Background Task Manager** | Async agent execution with concurrency limits |
| **Context Window Recovery** | Multi-stage recovery when hitting token limits |
| **MCP Server Configs** | Exa, Context7, grep.app server definitions |
| **LSP Tools** | Real LSP server integration with 11 tools |
| **AST Tools** | ast-grep integration for structural code search/replace |

#### Not Implemented ❌

| Feature | Original Capability | Why Not Ported |
|---------|---------------------|----------------|
| **Multi-Model Routing** | Route to GPT/Gemini/Grok based on task | Claude-only by design |
| **Per-Model Concurrency** | Fine-grained concurrency per provider | Single provider simplifies this |
| **Interactive Bash + Tmux** | Advanced terminal with Tmux integration | Standard Bash tool sufficient |

### Architecture Differences

```
oh-my-opencode (Original)          oh-my-claude-sisyphus (Port)
─────────────────────────          ────────────────────────────
┌─────────────────────┐            ┌─────────────────────┐
│   OpenCode Plugin   │            │    Claude Code      │
│   (Bun runtime)     │            │    (Native CLI)     │
└─────────┬───────────┘            └─────────┬───────────┘
          │                                  │
┌─────────▼───────────┐            ┌─────────▼───────────┐
│  Multi-Provider     │            │   Claude Agent SDK  │
│  Orchestration      │            │   (Claude only)     │
│  ┌───┐ ┌───┐ ┌───┐  │            └─────────┬───────────┘
│  │GPT│ │Gem│ │Grok│ │                      │
│  └───┘ └───┘ └───┘  │            ┌─────────▼───────────┐
└─────────┬───────────┘            │  ~/.claude/agents/  │
          │                        │  (Markdown configs) │
┌─────────▼───────────┐            └─────────────────────┘
│  Custom Tool Layer  │
│  (LSP, AST, etc.)   │
└─────────────────────┘
```

**Key Architectural Changes:**

1. **Plugin → Native Integration**: Original was an OpenCode plugin; this uses Claude Code's native agent/command system
2. **Multi-Provider → Single Provider**: Simplified to Claude-only for consistency
3. **Custom Runtime → Claude Code Runtime**: Leverages Claude Code's built-in capabilities
4. **Programmatic Config → Markdown Files**: Agents defined as `.md` files in `~/.claude/agents/`

### What You Gain

- **Simpler Setup**: One curl command vs. multi-step plugin installation
- **Native Integration**: Works directly with Claude Code, no plugin layer
- **Consistent Behavior**: All agents use Claude, no cross-model quirks
- **Easier Customization**: Edit markdown files to customize agents

### What You Lose

- **Model Diversity**: Can't use GPT-5.2 for Oracle's deep reasoning
- **Advanced Hooks**: Fewer lifecycle interception points (22 hooks → system prompt enforcement)

### Migration Tips

If you're coming from oh-my-opencode:

1. **Oracle Tasks**: Claude Opus handles architecture/debugging well, but differently than GPT-5.2
2. **LSP Workflows**: All LSP tools are available! Use `lsp_servers` to check which servers are installed
3. **AST Searches**: Use `ast_grep_search` with pattern syntax (e.g., `function $NAME($$$)`)
4. **Background Tasks**: Claude Code's `Task` tool with `run_in_background` works similarly
5. **Planning**: Use `/plan` command to start a planning session with Prometheus

</details>

---

## Requirements

- [Claude Code](https://docs.anthropic.com/claude-code) installed
- Anthropic API key (`ANTHROPIC_API_KEY` environment variable)
- **Windows**: Node.js 18+ (for npm installation)
- **macOS/Linux**: Bash shell (default) or Node.js 18+ (optional)

### Platform Support

| Platform | Install Method | Hook Type |
|----------|---------------|-----------|
| **Windows** | `npm install -g` | Node.js (.mjs) |
| **macOS** | curl or npm | Bash (.sh) |
| **Linux** | curl or npm | Bash (.sh) |

> **Advanced**: Set `SISYPHUS_USE_NODE_HOOKS=1` to use Node.js hooks on macOS/Linux.

## License

MIT - see [LICENSE](LICENSE)

## Credits

Inspired by [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by code-yeongyu.

---

<div align="center">

*One must imagine a multi-agent system happy.*

**The boulder never stops.**

</div>
