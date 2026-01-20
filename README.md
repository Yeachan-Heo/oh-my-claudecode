<div align="center">

![oh-my-claudecode](https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode-website/main/social-preview.png)

# oh-my-claudecode

[![Version](https://img.shields.io/badge/version-3.0.0--beta-ff6b6b)](https://github.com/Yeachan-Heo/oh-my-claudecode/releases)
[![npm version](https://img.shields.io/npm/v/oh-my-claudecode?color=cb3837)](https://www.npmjs.com/package/oh-my-claudecode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**Multi-agent orchestration system for [Claude Code](https://docs.anthropic.com/claude-code)**

[Install](#quick-install) • [Usage](#usage) • [Agents](#the-twelve-agents) • [Architecture](docs/ARCHITECTURE.md) • [Website](https://yeachan-heo.github.io/oh-my-claudecode-website)

</div>

---

## ⚡ NEW in 3.0: HUD Statusline, Learned Skills & Enhanced Orchestration

**Game-changing release:** Claude never forgets critical project knowledge, even through context compaction.

### 🧠 Three-Tier Memory System

**The Problem:** Long sessions lose context through compaction. Critical discoveries vanish.

**The Solution:** Persistent notepad system that survives compaction:

| Tier | Purpose | Retention |
|------|---------|-----------|
| **Priority Context** | Critical discoveries (API URLs, key files) | Always loaded on session start |
| **Working Memory** | Session notes with timestamps | Auto-pruned after 7 days |
| **MANUAL** | User permanent notes | Never pruned |

```bash
# Agents can persist discoveries automatically
<remember>Project uses pnpm not npm</remember>
<remember priority>API client at src/api/client.ts</remember>

# Or save notes manually
/note Database schema uses PostgreSQL with Prisma ORM
```

### 📋 Ralph Loop PRD Support

**Structured task tracking** inspired by [Ralph](https://github.com/snarktank/ralph):

- **Product Requirements Document (PRD)** format with user stories
- **Progress tracking** with learnings and patterns
- **Completion guarantee** - loop continues until ALL stories pass
- **Three powerful modes:**
  - `/ralph-loop` - Self-referential loop until completion
  - `/ultrawork-ralph` - Maximum intensity + completion guarantee
  - `/ultraqa` - Autonomous test-verify-fix cycles

```bash
# Initialize a structured task
/ralph-init implement user authentication with OAuth

# Maximum intensity with completion guarantee
/ultrawork-ralph refactor the entire API layer

# Autonomous QA cycling
/ultraqa all tests must pass with 90%+ coverage
```

See [CHANGELOG.md](CHANGELOG.md) for full details.

---

## Quick Install

Choose **ONE** installation method below. Do not mix methods.

### Option A: Claude Code Plugin (Recommended)

```bash
# In Claude Code, run:
/plugin marketplace add Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

Uses Node.js hooks from the plugin directory. Integrates directly with Claude Code's plugin system.

### Option B: Curl One-Liner (Deprecated)

```bash
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/scripts/install.sh | bash
```

> **Deprecated**: This method installs bash hooks to `~/.claude/` which can conflict with plugin installations. Use the plugin method above instead.

### Option C: Via npm (Windows & Cross-Platform)

```bash
npm install -g oh-my-claudecode
```

> **Windows Users**: This is the recommended installation method. Requires Node.js 20+.

> **Important:** Plugin install and curl install are **mutually exclusive**. Using both will cause hook conflicts. Choose one method only.

### Manual Install (macOS/Linux)

```bash
git clone https://github.com/Yeachan-Heo/oh-my-claudecode.git
cd oh-my-claudecode
chmod +x scripts/install.sh
./scripts/install.sh
```

---

## 🎯 Configuration: Choose Global or Project Scope

**After ANY installation method**, choose how you want to configure omc:

### Option A: Project-Scoped (Recommended)

Configure omc for the current project only:

```
/omc-default
```

- Creates `./.claude/CLAUDE.md` in your current project
- Configuration applies only to this project
- Won't affect other projects or global settings
- **Safe**: Preserves your global CLAUDE.md

### Option B: Global Configuration

Configure omc for all Claude Code sessions:

```
/omc-default-global
```

- Creates `~/.claude/CLAUDE.md` globally
- Configuration applies to all projects
- **Warning**: Completely overwrites existing `~/.claude/CLAUDE.md`

### Why This Matters

Without running one of these commands, Claude operates with basic capabilities. Running either enables:

| Feature | Without | With omc Config |
|---------|---------|-----------------|
| Agent delegation | Manual only | Automatic based on task |
| Keyword detection | Disabled | ultrawork, search, analyze |
| Todo continuation | Basic | Enforced completion |
| Model routing | Default | Smart tier selection |
| Skill composition | None | Auto-combines skills |

### What These Commands Do

1. ✅ Download latest CLAUDE.md with full omc orchestration prompt
2. ✅ Configure 19 agents with intelligent model routing
3. ✅ Enable magic keyword detection (ultrawork, search, analyze)
4. ✅ Activate continuation enforcement (tasks complete before stopping)
5. ✅ Set up skill composition (orchestrate + ultrawork + git-master, etc.)

### When to Run Them

- **First time**: Run after installation (choose project or global)
- **After updates**: Re-run to get the latest configuration
- **Different machines**: Run on each machine where you use Claude Code
- **New projects**: Run `/omc-default` in each project that needs omc

### Configuration Precedence

If both configurations exist, **project-scoped takes precedence** over global:

```
./.claude/CLAUDE.md  (project)   →  Overrides  →  ~/.claude/CLAUDE.md  (global)
```

> **NOTE**: After updating the plugin (via `npm update`, `git pull`, or Claude Code's plugin update), you MUST re-run `/omc-default` or `/omc-default-global` to apply the latest CLAUDE.md changes. The plugin update does NOT automatically update your CLAUDE.md files.

---

## What Gets Installed

### Plugin Structure (Claude Code Plugin Format)

The repository is also a Claude Code plugin with this structure:

```
oh-my-claudecode/
├── .claude-plugin/
│   └── plugin.json            # Plugin manifest
├── agents/                    # 12 specialized subagents
├── commands/                  # 12 slash commands
├── skills/                    # 4 skills (ultrawork, deepinit, git-master, frontend-ui-ux)
├── hooks/
│   └── hooks.json             # Hook configuration
└── scripts/                   # Hook scripts
```

### Traditional Installation Structure

The installer adds to your Claude Code config (`~/.claude/`):

```
~/.claude/
├── agents/
│   ├── architect.md           # Architecture & debugging expert (Opus)
│   ├── researcher.md          # Documentation & research (Sonnet)
│   ├── explore.md             # Fast pattern matching (Haiku)
│   ├── designer.md            # UI/UX specialist (Sonnet)
│   ├── writer.md              # Technical writing (Haiku)
│   ├── vision.md              # Visual analysis (Sonnet)
│   ├── critic.md              # Plan reviewer (Opus)
│   ├── analyst.md             # Pre-planning consultant (Opus)
│   ├── executor.md            # Focused executor (Sonnet)
│   ├── planner.md             # Strategic planner (Opus)
│   └── qa-tester.md           # CLI/service testing (Sonnet)
├── commands/
│   ├── orchestrate.md      # /orchestrate command
│   ├── omc-default.md      # /omc-default command (project-scoped)
│   ├── omc-default-global.md # /omc-default-global command (global)
│   ├── ultrawork.md        # /ultrawork command
│   ├── deepsearch.md       # /deepsearch command
│   ├── analyze.md          # /analyze command
│   ├── plan.md             # /plan command (planner)
│   ├── review.md           # /review command (critic)
│   ├── planner.md          # /planner command
│   ├── orchestrator.md     # /orchestrator command
│   ├── ralph-loop.md       # /ralph-loop command
│   └── cancel-ralph.md     # /cancel-ralph command
├── skills/
│   ├── ultrawork/SKILL.md  # Maximum performance mode
│   ├── deepinit/SKILL.md   # Hierarchical AGENTS.md generation
│   ├── git-master/SKILL.md # Git expert skill
│   └── frontend-ui-ux/SKILL.md # UI/UX design skill
└── CLAUDE.md               # omc system prompt
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
| `/orchestrate <task>` | Activate multi-agent orchestration mode |
| `/omc-default` | Configure omc for current project (./.claude/CLAUDE.md) |
| `/omc-default-global` | Configure omc globally (~/.claude/CLAUDE.md) |
| `/ultrawork <task>` | Maximum performance mode with parallel agents |
| `/ralph-init <task>` | Initialize PRD (Product Requirements Document) for structured task tracking |
| `/ralph-loop <task>` | Self-referential loop until task completion |
| `/ultrawork-ralph <task>` | Maximum intensity + completion guarantee (ultrawork + ralph loop) |
| `/ultraqa <goal>` | Autonomous QA cycling workflow (test → verify → fix → repeat) |
| `/cancel-ralph` | Cancel active Ralph Loop (and ultrawork-ralph if active) |
| `/cancel-ultraqa` | Cancel active UltraQA cycling workflow |
| `/note <content>` | Save notes to notepad.md for compaction resilience |
| `/deepsearch <query>` | Thorough multi-strategy codebase search |
| `/deepinit [path]` | Index codebase with hierarchical AGENTS.md files |
| `/analyze <target>` | Deep analysis and investigation |
| `/plan <description>` | Start planning session with planner |
| `/review [plan-path]` | Review a plan with critic |
| `/planner <task>` | Strategic planning with interview workflow |
| `/doctor` | Diagnose and fix installation issues |

### Examples

```bash
# In Claude Code:

# Activate orchestration for a task
/orchestrate refactor the authentication module

# Configure for current project
/omc-default

# Or configure globally for all projects
/omc-default-global

# Use ultrawork for maximum performance
/ultrawork implement user dashboard with charts

# Initialize structured task with PRD
/ralph-init implement user authentication with OAuth

# Maximum intensity with completion guarantee
/ultrawork-ralph migrate database schema to PostgreSQL

# Autonomous QA cycling
/ultraqa all tests must pass with 90%+ coverage

# Save important discoveries
/note Project uses Bun runtime instead of Node.js

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

Oh-my-claudecode includes a silent auto-update system that checks for updates in the background. Updates are applied automatically without interrupting your workflow.

Features:
- **Rate-limited**: Checks at most once every 24 hours
- **Concurrent-safe**: Lock file prevents simultaneous update attempts
- **Cross-platform**: Works on both macOS and Linux

To manually update, re-run the plugin install command or use Claude Code's built-in update mechanism.

---

## Hooks System

Oh-my-claudecode includes 19 lifecycle hooks that enhance Claude Code's behavior:

### Core Hooks

| Hook | Description |
|------|-------------|
| **rules-injector** | Dynamic rules injection with YAML frontmatter parsing |
| **omc-orchestrator** | Enforces orchestrator behavior and delegation |
| **auto-slash-command** | Automatic slash command detection and execution |
| **keyword-detector** | Magic keyword detection (ultrawork, search, analyze) |
| **ralph-loop** | Self-referential development loop management |
| **todo-continuation** | Ensures todo list completion |
| **notepad** | Compaction-resilient memory system with three-tier storage |

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
| **post-tool-use** | Remember tag auto-capture to notepad system |

### Environment & Notifications

| Hook | Description |
|------|-------------|
| **non-interactive-env** | CI/non-interactive environment handling |
| **agent-usage-reminder** | Reminder to use specialized agents |
| **background-notification** | Background task completion notifications |

---

## Builtin Skills

21 builtin skills provide specialized capabilities:

### Core Skills
| Skill | Description |
|-------|-------------|
| **orchestrate** | Multi-agent orchestration mode |
| **ultrawork** | Maximum performance with parallel agents |
| **ralph-loop** | Self-referential development until completion |
| **ralph-init** | Initialize PRD for structured task tracking |
| **ultrawork-ralph** | Maximum intensity + completion guarantee |
| **ultraqa** | Autonomous QA cycling workflow |
| **planner** | Strategic planning with interview workflow |
| **plan** | Start planning session |
| **review** | Review work plans with critic |

### Enhancement Skills
| Skill | Description |
|-------|-------------|
| **deepinit** | Hierarchical AGENTS.md codebase documentation |
| **deepsearch** | Thorough multi-strategy codebase search |
| **analyze** | Deep analysis and investigation |
| **frontend-ui-ux** | Designer-turned-developer UI/UX expertise |
| **git-master** | Git expert for atomic commits and history |

### Utility Skills
| Skill | Description |
|-------|-------------|
| **note** | Save notes to compaction-resilient notepad |
| **cancel-ralph** | Cancel Ralph Loop or ultrawork-ralph |
| **cancel-ultraqa** | Cancel UltraQA cycling workflow |
| **omc-default** | Configure omc for current project |
| **omc-default-global** | Configure omc globally |
| **doctor** | Diagnose and fix installation issues |
| **release** | Automated release workflow |

Skills are automatically activated via slash commands or magic keywords.

---

## Intelligent Skill Activation

> **New in v1.11.0**: Enhanced Hook Enforcement System - PreToolUse/PostToolUse hooks and strengthened Stop hook for stronger orchestration behavior beyond CLAUDE.md.

### Skill Layers

Skills work in **three composable layers**:

| Layer | Skills | Purpose |
|-------|--------|---------|
| **Execution** | orchestrate, orchestrator, planner | HOW you work (pick primary) |
| **Enhancement** | ultrawork, git-master, frontend-ui-ux | ADD capabilities (stack multiple) |
| **Guarantee** | ralph-loop | ENSURE completion |

**Combination Formula:** `[Execution] + [0-N Enhancements] + [Optional Guarantee]`

### Task Type → Skill Selection

Claude uses judgment to detect task type and activate appropriate skill combinations:

| Task Type | Skill Combination | When |
|-----------|-------------------|------|
| Multi-step implementation | `orchestrate` | Building features, refactoring |
| + parallel subtasks | `orchestrate + ultrawork` | 3+ independent subtasks |
| + multi-file changes | `orchestrate + git-master` | Changes span 3+ files |
| + must complete | `orchestrate + ralph-loop` | User emphasizes completion |
| UI/frontend work | `orchestrate + frontend-ui-ux` | Components, styling |
| Complex debugging | `architect` → `orchestrate` | Root cause → fix |
| Strategic planning | `planner` | Need plan first |
| Maximum performance | `ultrawork` (stacks) | Speed critical |

### Examples

```
"Add dark mode with proper commits"
→ orchestrate + frontend-ui-ux + git-master

"ultrawork: refactor the entire API layer"
→ ultrawork + orchestrate + git-master

"Plan auth system, then implement it completely"
→ planner (first) → orchestrate + ralph-loop (after plan)

"Fix this bug, don't stop until it's done"
→ orchestrate + ralph-loop
```

---

## The Twelve Agents

Claude will automatically delegate to these specialized agents:

### Task Execution

| | Agent | Model | Best For |
|---|-------|-------|----------|
| **architect** | Opus | Complex debugging, architecture decisions, root cause analysis |
| **researcher** | Sonnet | Finding documentation, understanding code organization |
| **explore** | Haiku | Quick file searches, pattern matching, reconnaissance |
| **designer** | Sonnet | UI components, styling, accessibility |
| **writer** | Haiku | README files, API docs, code comments |
| **vision** | Sonnet | Analyzing screenshots, diagrams, mockups |
| **qa-tester** | Sonnet | Interactive CLI/service testing with tmux |

### Planning & Review

| | Agent | Model | Best For |
|---|-------|-------|----------|
| **planner** | Opus | Strategic planning, comprehensive work plans, interview-style requirement gathering |
| **critic** | Opus | Critical plan review, feasibility assessment, risk identification |
| **analyst** | Opus | Pre-planning analysis, hidden requirement detection, ambiguity resolution |

### Orchestration

| | Agent | Model | Best For |
|---|-------|-------|----------|
| **orchestrator** | Opus | Master todo coordination, complex multi-step task management |
| **executor** | Sonnet | Focused task execution, plan following, direct implementation |

### Manual Agent Invocation

You can explicitly request an agent:

```
Use the architect agent to debug the memory leak in the worker process

Have the researcher find all documentation about the API

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
name: architect
description: Your custom description
tools: Read, Grep, Glob, Bash, Edit
model: opus  # or sonnet, haiku
---

Your custom system prompt here...
```

---

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/scripts/uninstall.sh | bash
```

Or manually:

```bash
rm ~/.claude/agents/{architect,researcher,explore,designer,writer,vision,critic,analyst,executor,planner,qa-tester}.md
rm ~/.claude/commands/{orchestrate,omc-default,omc-default-global,ultrawork,deepsearch,analyze,plan,review,planner,orchestrator,ralph-loop,cancel-ralph}.md
```

---

## SDK Usage (Advanced)

For programmatic use with the Claude Agent SDK:

```bash
npm install oh-my-claudecode @anthropic-ai/claude-agent-sdk
```

```typescript
import { createOmcSession } from 'oh-my-claudecode';
import { query } from '@anthropic-ai/claude-agent-sdk';

const session = createOmcSession();

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
│                         ORCHESTRATOR                             │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│    PLANNING     │  │   EXECUTION     │  │    SUPPORT      │
├─────────────────┤  ├─────────────────┤  ├─────────────────┤
│ planner         │  │ architect       │  │ researcher      │
│ critic          │  │ designer        │  │ explore         │
│ analyst         │  │ orchestrator    │  │ writer          │
│                 │  │ executor        │  │ vision          │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

1. **Orchestrator**: The main Claude instance coordinates all work
2. **Specialized Subagents**: Each agent has focused expertise and tools
3. **Parallel Execution**: Independent tasks run concurrently
4. **Continuation Enforcement**: Agents persist until ALL tasks complete
5. **Context Injection**: Project-specific instructions from CLAUDE.md files

---

<details>
<summary><h2>Differences from oh-my-opencode</h2></summary>

This project is inspired by [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode), reimagined for Claude Code with skill composition, intelligent model routing, and native integration. Here's what's different:

### Model Mapping

The original oh-my-opencode used multiple AI providers. This project uses Claude models exclusively:

| Agent | Original Model | Ported Model | Notes |
|-------|---------------|--------------|-------|
| **orchestrator** | Claude Opus 4.5 | Claude Opus 4.5 | Same |
| **architect** | GPT-5.2 | Claude Opus | Was OpenAI's flagship for deep reasoning |
| **researcher** | Claude Sonnet or Gemini 3 Flash | Claude Sonnet | Multi-provider → Claude only |
| **explore** | Grok Code or Gemini 3 Flash | Claude Haiku 4.5 | Fast/cheap model for quick searches |
| **designer** | Gemini 3 Pro | Claude Sonnet | Was Google's model |
| **writer** | Gemini 3 Flash | Claude Haiku 4.5 | Fast model for docs |
| **vision** | Various | Claude Sonnet | Visual analysis |
| **critic** | GPT-5.2 | Claude Opus | Plan reviewer |
| **analyst** | Claude Opus 4.5 | Claude Opus | Pre-planning consultant |
| **executor** | Configurable | Claude Sonnet | Focused task executor |
| **planner** | Planning System | Claude Opus | Strategic planner |

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
| **19 Specialized Agents** | architect, researcher, explore, designer, writer, vision, qa-tester, critic, analyst, orchestrator, executor, planner (+ tiered variants) |
| **19 Lifecycle Hooks** | rules-injector, omc-orchestrator, auto-slash-command, keyword-detector, ralph-loop, todo-continuation, notepad, post-tool-use, context-window-limit-recovery, preemptive-compaction, session-recovery, directory-readme-injector, comment-checker, thinking-block-validator, empty-message-sanitizer, edit-error-recovery, non-interactive-env, agent-usage-reminder, background-notification |
| **21 Builtin Skills** | orchestrate, ultrawork, ralph-loop, ralph-init, ultrawork-ralph, ultraqa, planner, plan, review, deepinit, deepsearch, analyze, frontend-ui-ux, git-master, note, cancel-ralph, cancel-ultraqa, omc-default, omc-default-global, doctor, release |
| **Magic Keywords** | `ultrawork`, `search`, `analyze`, `ultrathink` trigger enhanced modes |
| **Slash Commands** | `/orchestrate`, `/omc-default`, `/omc-default-global`, `/ultrawork`, `/ralph-init`, `/ralph-loop`, `/ultrawork-ralph`, `/ultraqa`, `/cancel-ralph`, `/cancel-ultraqa`, `/note`, `/deepsearch`, `/deepinit`, `/analyze`, `/plan`, `/review`, `/planner`, `/doctor` |
| **Compaction-Resilient Memory** | Three-tier notepad system (Priority Context, Working Memory, MANUAL) |
| **Remember Tag Auto-Capture** | Agents can persist discoveries with `<remember>` tags |
| **PRD Support** | Structured task tracking with user stories and acceptance criteria |
| **Progress Tracking** | Append-only progress log with learnings and patterns |
| **Auto-Update System** | Updates via Claude Code's plugin system |
| **Configuration System** | JSONC config with multi-source merging |
| **Context Injection** | Auto-loads CLAUDE.md and AGENTS.md files |
| **Continuation Enforcement** | System prompt and hooks enforce task completion |
| **Session Recovery** | Automatic state recovery on crashes |
| **Background Task Manager** | Async agent execution with concurrency limits |
| **Context Window Recovery** | Multi-stage recovery when hitting token limits |
| **MCP Server Configs** | Exa, Context7, grep.app server definitions |
| **LSP Tools** | Real LSP server integration with 11 tools |
| **AST Tools** | ast-grep integration for structural code search/replace |
| **Comprehensive Test Suite** | 358 tests covering all major features |

#### Not Implemented ❌

| Feature | Original Capability | Why Not Ported |
|---------|---------------------|----------------|
| **Multi-Model Routing** | Route to GPT/Gemini/Grok based on task | Claude-only by design |
| **Per-Model Concurrency** | Fine-grained concurrency per provider | Single provider simplifies this |
| **Interactive Bash + Tmux** | Advanced terminal with Tmux integration | Standard Bash tool sufficient |

### Architecture Differences

```
oh-my-opencode (Original)          oh-my-claudecode (Port)
─────────────────────────          ────────────────────────
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

- **Model Diversity**: Can't use GPT-5.2 for architect's deep reasoning
- **Advanced Hooks**: Fewer lifecycle interception points (22 hooks → system prompt enforcement)

### Migration Tips

If you're coming from oh-my-opencode:

1. **Architect Tasks**: Claude Opus handles architecture/debugging well, but differently than GPT-5.2
2. **LSP Workflows**: All LSP tools are available! Use `lsp_servers` to check which servers are installed
3. **AST Searches**: Use `ast_grep_search` with pattern syntax (e.g., `function $NAME($$$)`)
4. **Background Tasks**: Claude Code's `Task` tool with `run_in_background` works similarly
5. **Planning**: Use `/plan` command to start a planning session with planner

</details>

---

## Requirements

- [Claude Code](https://docs.anthropic.com/claude-code) installed
- Anthropic API key (`ANTHROPIC_API_KEY` environment variable)
- **Windows**: Node.js 20+ (for npm installation)
- **macOS/Linux**: Bash shell (default) or Node.js 20+ (optional)

### Platform Support

| Platform | Install Method | Hook Type |
|----------|---------------|-----------|
| **Windows** | `npm install -g` | Node.js (.mjs) |
| **macOS** | curl or npm | Bash (.sh) |
| **Linux** | curl or npm | Bash (.sh) |

> **Note**: Bash hooks are fully portable across macOS and Linux (no GNU-specific dependencies).

> **Advanced**: Set `OMC_USE_NODE_HOOKS=1` to use Node.js hooks on macOS/Linux.

## License

MIT - see [LICENSE](LICENSE)

## Credits

Inspired by [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by code-yeongyu.
