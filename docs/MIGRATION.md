# Migration Guide

This guide covers all migration paths for oh-my-claudecode. Find your current version below.

---

## Table of Contents

- [v3.5.3 → v3.5.5: Test Fixes & Cleanup](#v353--v355-test-fixes--cleanup)
- [v3.5.2 → v3.5.3: Skill Consolidation](#v352--v353-skill-consolidation)
- [v2.x → v3.0: Package Rename & Auto-Activation](#v2x--v30-package-rename--auto-activation)
- [v3.0 → v3.1: Notepad Wisdom & Enhanced Features](#v30--v31-notepad-wisdom--enhanced-features)
- [v3.x → v4.0: Major Architecture Overhaul](#v3x--v40-major-architecture-overhaul)

---

## v3.5.3 → v3.5.5: Test Fixes & Cleanup

### TL;DR

Maintenance release fixing test suite issues and continuing skill consolidation from v3.5.3.

### What Changed

**Test Fixes:**
- Delegation-enforcer tests marked as skipped (implementation pending)
- Analytics expectations corrected for agent attribution
- All remaining tests now pass cleanly

**Skill Consolidation:**
- Continued cleanup from v3.5.3
- Removed deprecated `cancel-*` skills (use `/cancel` instead)
- Final skill count: 37 core skills

### Migration Steps

1. **No breaking changes** - All functionality preserved
2. **Test suite** now runs cleanly with `npm run test:run`
3. **Deprecated skills** removed (already replaced in v3.5.3)

### For Developers

If you were depending on deprecated `cancel-*` skills, update to use the unified `/cancel` command which auto-detects the active mode.

---

## v3.5.2 → v3.5.3: Skill Consolidation

### TL;DR

8 deprecated skills have been removed. The unified `/cancel` and `/omc-setup` commands replace them.

### Removed Skills

The following skills have been **completely removed** in v3.5.3:

| Removed Skill | Replacement |
|---------------|-------------|
| `cancel-autopilot` | `/oh-my-claudecode:cancel` |
| `cancel-ralph` | `/oh-my-claudecode:cancel` |
| `cancel-ultrawork` | `/oh-my-claudecode:cancel` |
| `cancel-ultraqa` | `/oh-my-claudecode:cancel` |
| `cancel-ecomode` | `/oh-my-claudecode:cancel` |
| `omc-default` | `/oh-my-claudecode:omc-setup --local` |
| `omc-default-global` | `/oh-my-claudecode:omc-setup --global` |
| `planner` | `/oh-my-claudecode:plan` |

### What Changed

**Before v3.5.3:**
```bash
/oh-my-claudecode:cancel-ralph      # Cancel ralph specifically
/oh-my-claudecode:omc-default       # Configure local project
/oh-my-claudecode:planner "task"    # Start planning
```

**After v3.5.3:**
```bash
/oh-my-claudecode:cancel            # Auto-detects and cancels any active mode
/oh-my-claudecode:omc-setup --local # Configure local project
/oh-my-claudecode:plan "task"       # Start planning (includes interview mode)
```

### New Features

**New skill: `/learn-about-omc`**
- Analyzes your OMC usage patterns
- Provides personalized recommendations
- Identifies underutilized features

**Plan skill now supports consensus mode:**
```bash
/oh-my-claudecode:plan --consensus "task"  # Iterative planning with Critic review
/oh-my-claudecode:ralplan "task"           # Alias for plan --consensus
```

### Migration Steps

1. **No action required** - The unified `/cancel` command already worked in v3.5
2. **Update any scripts** that reference removed commands
3. **Re-run `/omc-setup`** if you want to update your CLAUDE.md configuration

### Skill Count

- v3.5: 42 skills
- v3.5.3: 37 skills (8 removed, 3 added)

---

## v2.x → v3.0: Package Rename & Auto-Activation

### TL;DR

Your old commands still work! But now you don't need them.

**Before 3.0:** Explicitly invoke 25+ commands like `/oh-my-claudecode:ralph "task"`, `/oh-my-claudecode:ultrawork "task"`

**After 3.0:** Just work naturally - Claude auto-activates the right behaviors. One-time setup: just say "setup omc"

### Project Rebrand

The project was rebranded to better reflect its purpose and improve discoverability.

- **Project/brand name**: `oh-my-claudecode` (GitHub repo, plugin name, commands)
- **npm package name**: `oh-my-claude-sisyphus` (unchanged)

> **Why the difference?** The npm package name `oh-my-claude-sisyphus` was kept for backward compatibility with existing installations. The project, GitHub repository, plugin, and all commands use `oh-my-claudecode`.

#### NPM Install Command (unchanged)

```bash
npm install -g oh-my-claude-sisyphus
```

### What Changed

#### Before (2.x): Explicit Commands

You had to remember and explicitly invoke specific commands for each mode:

```bash
# 2.x workflow: Multiple commands, lots to remember
/oh-my-claudecode:ralph "implement user authentication"       # Persistence mode
/oh-my-claudecode:ultrawork "refactor the API layer"          # Maximum parallelism
/oh-my-claudecode:planner "plan the new dashboard"            # Planning interview
/oh-my-claudecode:deepsearch "find database schema files"     # Deep search
/oh-my-claudecode:git-master "commit these changes"           # Git expertise
/oh-my-claudecode:deepinit ./src                              # Index codebase
/oh-my-claudecode:analyze "why is this test failing?"         # Deep analysis
```

#### After (3.0): Auto-Activation + Keywords

Work naturally. Claude detects intent and activates behaviors automatically:

```bash
# 3.0 workflow: Just talk naturally OR use optional keywords
"don't stop until user auth is done"                # Auto-activates ralph-loop
"fast: refactor the entire API layer"               # Auto-activates ultrawork
"plan: design the new dashboard"                    # Auto-activates planning
"ralph ulw: migrate the database"                   # Combined: persistence + parallelism
"find all database schema files"                    # Auto-activates search mode
"commit these changes properly"                     # Auto-activates git expertise
```

### Agent Name Mapping

All agent names have been updated from Greek mythology references to intuitive, descriptive names:

| Old Name (Greek) | New Name (Intuitive) |
|------------------|----------------------|
| prometheus | planner |
| momus | critic |
| oracle | architect |
| metis | analyst |
| mnemosyne | learner |
| sisyphus-junior | executor |
| orchestrator-sisyphus | coordinator |
| librarian | document-specialist |
| frontend-engineer | designer |
| document-writer | writer |
| multimodal-looker | vision |
| explore | explore (unchanged) |
| qa-tester | qa-tester (unchanged) |

### Directory Migration

Directory structures have been renamed for consistency with the new package name:

#### Local Project Directories
- **Old**: `.sisyphus/`
- **New**: `.omc/`

#### Global Directories
- **Old**: `~/.sisyphus/`
- **New**: `~/.omc/`

#### Skills Directory
- **Old**: `~/.claude/skills/sisyphus-learned/`
- **New**: `~/.claude/skills/omc-learned/`

#### Config Files
- **Old**: `~/.claude/sisyphus/mnemosyne.json`
- **New**: `~/.claude/omc/learner.json`

### Environment Variables

All environment variables have been renamed from `SISYPHUS_*` to `OMC_*`:

| Old | New |
|-----|-----|
| SISYPHUS_USE_NODE_HOOKS | OMC_USE_NODE_HOOKS |
| SISYPHUS_USE_BASH_HOOKS | OMC_USE_BASH_HOOKS |
| SISYPHUS_PARALLEL_EXECUTION | OMC_PARALLEL_EXECUTION |
| SISYPHUS_LSP_TOOLS | OMC_LSP_TOOLS |
| SISYPHUS_MAX_BACKGROUND_TASKS | OMC_MAX_BACKGROUND_TASKS |
| SISYPHUS_ROUTING_ENABLED | OMC_ROUTING_ENABLED |
| SISYPHUS_ROUTING_DEFAULT_TIER | OMC_ROUTING_DEFAULT_TIER |
| SISYPHUS_ESCALATION_ENABLED | OMC_ESCALATION_ENABLED |
| SISYPHUS_DEBUG | OMC_DEBUG |

### Command Mapping

All 2.x commands continue to work. Here's what changed:

| 2.x Command | 3.0 Equivalent | Works? |
|-------------|----------------|--------|
| `/oh-my-claudecode:ralph "task"` | Say "don't stop until done" OR use `ralph` keyword | ✅ YES (both ways) |
| `/oh-my-claudecode:ultrawork "task"` | Say "fast" or "parallel" OR use `ulw` keyword | ✅ YES (both ways) |
| `/oh-my-claudecode:ultrawork-ralph` | Say "ralph ulw:" prefix | ✅ YES (keyword combo) |
| `/oh-my-claudecode:planner "task"` | Say "plan this" OR use `plan` keyword | ✅ YES (both ways) |
| `/oh-my-claudecode:plan "description"` | Start planning naturally | ✅ YES |
| `/oh-my-claudecode:review [path]` | Invoke normally | ✅ YES (unchanged) |
| `/oh-my-claudecode:deepsearch "query"` | Say "find" or "search" | ✅ YES (auto-detect) |
| `/oh-my-claudecode:analyze "target"` | Say "analyze" or "investigate" | ✅ YES (auto-detect) |
| `/oh-my-claudecode:deepinit [path]` | Invoke normally | ✅ YES (unchanged) |
| `/oh-my-claudecode:git-master` | Say "git", "commit", "atomic commit" | ✅ YES (auto-detect) |
| `/oh-my-claudecode:frontend-ui-ux` | Say "UI", "styling", "component", "design" | ✅ YES (auto-detect) |
| `/oh-my-claudecode:note "content"` | Say "remember this" or "save this" | ✅ YES (auto-detect) |
| `/oh-my-claudecode:cancel-ralph` | Say "stop", "cancel", or "abort" | ✅ YES (auto-detect) |
| `/oh-my-claudecode:omc-doctor` | Invoke normally | ✅ YES (unchanged) |
| All other commands | Work exactly as before | ✅ YES |

### Magic Keywords

Include these anywhere in your message to explicitly activate behaviors. Use keywords when you want explicit control (optional):

| Keyword | Effect | Example |
|---------|--------|---------|
| `ralph` | Persistence mode - won't stop until done | "ralph: refactor the auth system" |
| `ralplan` | Iterative planning with consensus | "ralplan: add OAuth support" |
| `ulw` / `ultrawork` | Maximum parallel execution | "ulw: fix all type errors" |
| `plan` | Planning interview | "plan: new API design" |

**ralph includes ultrawork:**
```
ralph: migrate the entire database
    ↓
Persistence (won't stop) + Ultrawork (maximum parallelism) built-in
```

**No keywords?** Claude still auto-detects:
```
"don't stop until this works"      # Triggers ralph
"fast, I'm in a hurry"             # Triggers ultrawork
"help me design the dashboard"     # Triggers planning
```

### Natural Cancellation

Say any of these to stop:
- "stop"
- "cancel"
- "abort"
- "nevermind"
- "enough"
- "halt"

Claude intelligently determines what to stop:

```
If in ralph-loop     → Exit persistence loop
If in ultrawork      → Return to normal mode
If in planning       → End planning interview
If multiple active   → Stop the most recent
```

No more `/oh-my-claudecode:cancel-ralph` - just say "cancel"!

### Migration Steps

Follow these steps to migrate your existing setup:

#### 1. Uninstall Old Package (if installed via npm)

```bash
npm uninstall -g oh-my-claude-sisyphus
```

#### 2. Install via Plugin System (Required)

```bash
# In Claude Code:
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

> **Note**: npm/bun global installs are no longer supported. Use the plugin system.

#### 3. Rename Local Project Directories

If you have existing projects using the old directory structure:

```bash
# In each project directory
mv .sisyphus .omc
```

#### 4. Rename Global Directories

```bash
# Global configuration directory
mv ~/.sisyphus ~/.omc

# Skills directory
mv ~/.claude/skills/sisyphus-learned ~/.claude/skills/omc-learned

# Config directory
mv ~/.claude/sisyphus ~/.claude/omc
```

#### 5. Update Environment Variables

Update your shell configuration files (`.bashrc`, `.zshrc`, etc.):

```bash
# Replace all SISYPHUS_* variables with OMC_*
# Example:
# OLD: export SISYPHUS_ROUTING_ENABLED=true
# NEW: export OMC_ROUTING_ENABLED=true
```

#### 6. Update Scripts and Configurations

Search for and update any references to:
- Package name: `oh-my-claude-sisyphus` → `oh-my-claudecode`
- Agent names: Use the mapping table above
- Commands: Use the new slash commands
- Directory paths: Update `.sisyphus` → `.omc`

#### 7. Run One-Time Setup

In Claude Code, just say "setup omc", "omc setup", or any natural language equivalent.

This:
- Downloads latest CLAUDE.md
- Configures 32 agents
- Enables auto-behavior detection
- Activates continuation enforcement
- Sets up skill composition

### Verification

After migration, verify your setup:

1. **Check installation**:
   ```bash
   npm list -g oh-my-claude-sisyphus
   ```

2. **Verify directories exist**:
   ```bash
   ls -la .omc/  # In project directory
   ls -la ~/.omc/  # Global directory
   ```

3. **Test a simple command**:
   Run `/oh-my-claudecode:omc-help` in Claude Code to ensure the plugin is loaded correctly.

### New Features in 3.0

#### 1. Zero-Learning-Curve Operation

**No commands to memorize.** Work naturally:

```
Before: "OK, I need to use /oh-my-claudecode:ultrawork for speed..."
After:  "I'm in a hurry, go fast!"
        ↓
        Claude: "I'm activating ultrawork mode..."
```

#### 2. Delegate Always (Automatic)

Complex work auto-routes to specialist agents:

```
Your request              Claude's action
────────────────────     ────────────────────
"Refactor the database"   → Delegates to architect
"Fix the UI colors"       → Delegates to designer
"Document this API"       → Delegates to writer
"Search for all errors"   → Delegates to explore
"Debug this crash"        → Delegates to architect
```

You don't ask for delegation - it happens automatically.

#### 3. Learned Skills (`/oh-my-claudecode:learner`)

Extract reusable insights from problem-solving:

```bash
# After solving a tricky bug:
"Extract this as a skill"
    ↓
Claude learns the pattern and stores it
    ↓
Next time keywords match → Solution auto-injects
```

Storage:
- **Project-level**: `.omc/skills/` (version-controlled)
- **User-level**: `~/.claude/skills/omc-learned/` (portable)

#### 4. HUD Statusline (Real-Time Orchestration)

See what Claude is doing in the status bar:

```
[OMC] ralph:3/10 | US-002 | ultrawork skill:planner | ctx:67% | agents:2 | todos:2/5
```

Run `/oh-my-claudecode:hud setup` to install. Presets: minimal, focused, full.

#### 5. Three-Tier Memory System

Critical knowledge survives context compaction:

```
<remember priority>API client at src/api/client.ts</remember>
    ↓
Permanently loaded on session start
    ↓
Never lost through compaction
```

Or use `/oh-my-claudecode:note` to save discoveries manually:

```bash
/oh-my-claudecode:note Project uses PostgreSQL with Prisma ORM
```

#### 6. Structured Task Tracking (PRD Support)

**Ralph Loop now uses Product Requirements Documents:**

```bash
/oh-my-claudecode:ralph-init "implement OAuth with multiple providers"
    ↓
Auto-creates PRD with user stories
    ↓
Each story: description + acceptance criteria + pass/fail
    ↓
Ralph loops until ALL stories pass
```

#### 7. Intelligent Continuation

**Tasks complete before Claude stops:**

```
You: "Implement user dashboard"
    ↓
Claude: "I'm activating ralph-loop to ensure completion"
    ↓
Creates todo list, works through each item
    ↓
Only stops when EVERYTHING is verified complete
```

### Backward Compatibility Note

**Note**: v3.0 does not maintain backward compatibility with v2.x naming. You must complete the migration steps above for the new version to work correctly.

---

## v3.0 → v3.1: Notepad Wisdom & Enhanced Features

### Overview

Version 3.1 is a minor release adding powerful new features while maintaining full backward compatibility with v3.0.

### What's New

#### 1. Notepad Wisdom System

Plan-scoped wisdom capture for learnings, decisions, issues, and problems.

**Location:** `.omc/notepads/{plan-name}/`

| File | Purpose |
|------|---------|
| `learnings.md` | Technical discoveries and patterns |
| `decisions.md` | Architectural and design decisions |
| `issues.md` | Known issues and workarounds |
| `problems.md` | Blockers and challenges |

**API:**
- `initPlanNotepad()` - Initialize notepad for a plan
- `addLearning()` - Record technical discoveries
- `addDecision()` - Record architectural choices
- `addIssue()` - Record known issues
- `addProblem()` - Record blockers
- `getWisdomSummary()` - Get summary of all wisdom
- `readPlanWisdom()` - Read full wisdom for context

#### 2. Delegation Categories

Semantic task categorization that auto-maps to model tier, temperature, and thinking budget.

| Category | Tier | Temperature | Thinking | Use For |
|----------|------|-------------|----------|---------|
| `visual-engineering` | HIGH | 0.7 | high | UI/UX, frontend, design systems |
| `ultrabrain` | HIGH | 0.3 | max | Complex reasoning, architecture, deep debugging |
| `artistry` | MEDIUM | 0.9 | medium | Creative solutions, brainstorming |
| `quick` | LOW | 0.1 | low | Simple lookups, basic operations |
| `writing` | MEDIUM | 0.5 | medium | Documentation, technical writing |

**Auto-detection:** Categories detect from prompt keywords automatically.

#### 3. Directory Diagnostics Tool

Project-level type checking via `lsp_diagnostics_directory` tool.

**Strategies:**
- `auto` (default) - Auto-selects best strategy, prefers tsc when tsconfig.json exists
- `tsc` - Fast, uses TypeScript compiler
- `lsp` - Fallback, iterates files via Language Server

**Usage:** Check entire project for errors before commits or after refactoring.

#### 4. Session Resume

Background agents can be resumed with full context via `resume-session` tool.

### Migration Steps

Version 3.1 is a drop-in upgrade. No migration required!

```bash
npm update -g oh-my-claude-sisyphus
```

All existing configurations, plans, and workflows continue working unchanged.

### New Tools Available

Once upgraded, agents automatically gain access to:
- Notepad wisdom APIs (read/write wisdom during execution)
- Delegation categories (automatic categorization)
- Directory diagnostics (project-level type checking)
- Session resume (recover background agent state)

---

## v3.3.x → v3.4.0: Parallel Execution & Advanced Workflows

### Overview

Version 3.4.0 introduces powerful parallel execution modes and advanced workflow orchestration while maintaining full backward compatibility with v3.3.x.

### What's New

#### 1. Ultrapilot: Parallel Autopilot

Execute complex tasks with up to 5 concurrent workers for 3-5x speedup:

```bash
/oh-my-claudecode:ultrapilot "build a fullstack todo app"
```

**Key Features:**
- Automatic task decomposition into parallelizable subtasks
- File ownership coordination to prevent conflicts
- Parallel execution with intelligent coordination
- State files: `.omc/state/ultrapilot-state.json`, `.omc/state/ultrapilot-ownership.json`

**Best for:** Multi-component systems, fullstack apps, large refactoring

#### 2. Swarm: Coordinated Agent Teams

N coordinated agents with atomic task claiming:

```bash
/oh-my-claudecode:swarm 5:executor "fix all TypeScript errors"
```

**Key Features:**
- Shared task pool with atomic claiming (prevents duplicate work)
- 5-minute timeout per task with auto-release
- Scales from 2 to 10 workers
- Clean completion when all tasks done

#### 3. Pipeline: Sequential Agent Chaining

Chain agents with data passing between stages:

```bash
/oh-my-claudecode:pipeline explore:haiku -> architect:opus -> executor:sonnet
```

**Built-in Presets:**
- `review` - explore → architect → critic → executor
- `implement` - planner → executor → tdd-guide
- `debug` - explore → architect → build-fixer
- `research` - parallel(document-specialist, explore) → architect → writer
- `refactor` - explore → architect-medium → executor-high → qa-tester
- `security` - explore → security-reviewer → executor → security-reviewer-low

#### 4. Ecomode: Token-Efficient Execution

Maximum parallelism with 30-50% token savings:

```bash
/oh-my-claudecode:ecomode "refactor the authentication system"
```

**Smart model routing:**
- Simple tasks → Haiku (ultra-cheap)
- Standard work → Sonnet (balanced)
- Complex reasoning → Opus (when needed)

#### 5. Unified Cancel Command

Smart cancellation that auto-detects active mode:

```bash
/oh-my-claudecode:cancel
# Or just say: "stop", "cancel", "abort"
```

**Auto-detects and cancels:** autopilot, ultrapilot, ralph, ultrawork, ultraqa, ecomode, swarm, pipeline

**Deprecation Notice:**
Individual cancel commands are deprecated but still work:
- `/oh-my-claudecode:cancel-ralph` (deprecated)
- `/oh-my-claudecode:cancel-ultraqa` (deprecated)
- `/oh-my-claudecode:cancel-ultrawork` (deprecated)
- `/oh-my-claudecode:cancel-ecomode` (deprecated)
- `/oh-my-claudecode:cancel-autopilot` (deprecated)

Use `/oh-my-claudecode:cancel` instead.

#### 6. Explore-High Agent

Opus-powered architectural search for complex codebase exploration:

```typescript
Task(subagent_type="oh-my-claudecode:explore-high",
     model="opus",
     prompt="Find all authentication-related code patterns...")
```

**Best for:** Architectural analysis, cross-cutting concerns, complex refactoring planning

#### 7. State Management Standardization

State files now use standardized paths:

**Standard paths:**
- Local: `.omc/state/{name}.json`
- Global: `~/.omc/state/{name}.json`

Legacy locations are auto-migrated on read.

#### 8. Keyword Conflict Resolution

When multiple execution mode keywords are present:

**Conflict Resolution Priority:**
| Priority | Condition | Result |
|----------|-----------|--------|
| 1 (highest) | Both explicit keywords present (e.g., "ulw eco fix errors") | `ecomode` wins (more token-restrictive) |
| 2 | Single explicit keyword | That mode wins |
| 3 | Generic "fast"/"parallel" only | Read from config (`defaultExecutionMode`) |
| 4 (lowest) | No config file | Default to `ultrawork` |

**Explicit mode keywords:** `ulw`, `ultrawork`, `eco`, `ecomode`
**Generic keywords:** `fast`, `parallel`

Users set their default mode preference via `/oh-my-claudecode:omc-setup`.

### Migration Steps

Version 3.4.0 is a drop-in upgrade. No migration required!

```bash
npm update -g oh-my-claude-sisyphus
```

All existing configurations, plans, and workflows continue working unchanged.

### New Configuration Options

#### Default Execution Mode

Set your preferred execution mode in `~/.claude/.omc-config.json`:

```json
{
  "defaultExecutionMode": "ultrawork"  // or "ecomode"
}
```

When you use generic keywords like "fast" or "parallel" without explicit mode keywords, this setting determines which mode activates.

#### Disable Ecomode / Low Tier Agents

If you want to fully disable ecomode keywords and LOW-tier (`haiku` / `*-low`) delegation:

```json
{
  "ecomode": { "enabled": false },
  "agentTiers": { "lowEnabled": false }
}
```

Equivalent CLI commands:

```bash
omc config-ecomode --disable
omc config-agent-tiers --disable-low
```

### Breaking Changes

None. All v3.3.x features and commands continue to work in v3.4.0.

### New Tools Available

Once upgraded, you automatically gain access to:
- Ultrapilot (parallel autopilot)
- Swarm coordination
- Pipeline workflows
- Ecomode execution
- Unified cancel command
- Explore-high agent

### Best Practices for v3.4.0

#### When to Use Each Mode

| Scenario | Recommended Mode | Why |
|----------|------------------|-----|
| Multi-component systems | `ultrapilot` | Parallel workers handle independent components |
| Many small fixes | `swarm` | Atomic task claiming prevents duplicate work |
| Sequential dependencies | `pipeline` | Data passes between stages |
| Budget-conscious | `ecomode` | 30-50% token savings with smart routing |
| Single complex task | `autopilot` | Full autonomous execution |
| Must complete | `ralph` | Persistence guarantee |

#### Keyword Usage

**Explicit mode control (v3.4.0):**
```bash
"ulw: fix all errors"           # ultrawork (explicit)
"eco: refactor auth system"     # ecomode (explicit)
"ulw eco: migrate database"     # ecomode wins (conflict resolution)
"fast: implement feature"       # reads defaultExecutionMode config
```

**Natural language (still works):**
```bash
"don't stop until done"         # ralph
"parallel execution"            # reads defaultExecutionMode
"build me a todo app"           # autopilot
```

### Verification

After upgrading, verify new features:

1. **Check installation**:
   ```bash
   npm list -g oh-my-claude-sisyphus
   ```

2. **Test ultrapilot**:
   ```bash
   /oh-my-claudecode:ultrapilot "create a simple React component"
   ```

3. **Test unified cancel**:
   ```bash
   /oh-my-claudecode:cancel
   ```

4. **Check state directory**:
   ```bash
   ls -la .omc/state/  # Should see ultrapilot-state.json after running ultrapilot
   ```

---

## v3.x → v4.0: Major Architecture Overhaul

### Overview

Version 4.0 is a complete architectural redesign focusing on scalability, maintainability, and developer experience.

### What's Coming

⚠️ **This section is under active development as v4.0 is being built.**

#### Planned Changes

1. **Modular Architecture**
   - Plugin system for extensibility
   - Core/extension separation
   - Better dependency management

2. **Enhanced Agent System**
   - Improved agent lifecycle management
   - Better error recovery
   - Performance optimizations

3. **Improved Configuration**
   - Unified config schema
   - Better validation
   - Migration tooling

4. **Breaking Changes**
   - TBD based on development progress
   - Full migration guide will be provided

### Migration Path (Coming Soon)

Detailed migration instructions will be provided when v4.0 reaches release candidate status.

Expected timeline: Q1 2026

### Stay Updated

- Watch the [GitHub repository](https://github.com/Yeachan-Heo/oh-my-claude-sisyphus) for announcements
- Check [CHANGELOG.md](../CHANGELOG.md) for detailed release notes
- Join discussions in GitHub Issues

---

## Common Scenarios Across Versions

### Scenario 1: Quick Implementation Task

**2.x Workflow:**
```
/oh-my-claudecode:ultrawork "implement the todo list feature"
```

**3.0+ Workflow:**
```
"implement the todo list feature quickly"
    ↓
Claude: "I'm activating ultrawork for maximum parallelism"
```

**Result:** Same outcome, more natural interaction.

### Scenario 2: Complex Debugging

**2.x Workflow:**
```
/oh-my-claudecode:ralph "debug the memory leak"
```

**3.0+ Workflow:**
```
"there's a memory leak in the worker process - don't stop until we fix it"
    ↓
Claude: "I'm activating ralph-loop to ensure completion"
```

**Result:** Ralph-loop with more context from your natural language.

### Scenario 3: Strategic Planning

**2.x Workflow:**
```
/oh-my-claudecode:planner "design the new authentication system"
```

**3.0+ Workflow:**
```
"plan the new authentication system"
    ↓
Claude: "I'm starting a planning session"
    ↓
Interview begins automatically
```

**Result:** Planning interview triggered by natural language.

### Scenario 4: Stopping Work

**2.x Workflow:**
```
/oh-my-claudecode:cancel-ralph
```

**3.0+ Workflow:**
```
"stop"
```

**Result:** Claude intelligently cancels the active operation.

---

## Configuration Options

### Project-Scoped Configuration (Recommended)

Apply oh-my-claudecode to current project only:

```
/oh-my-claudecode:omc-default
```

Creates: `./.claude/CLAUDE.md`

### Global Configuration

Apply to all Claude Code sessions:

```
/oh-my-claudecode:omc-default-global
```

Creates: `~/.claude/CLAUDE.md`

**Precedence:** Project config overrides global if both exist.

---

## FAQ

**Q: Do I have to use keywords?**
A: No. Keywords are optional shortcuts. Claude auto-detects intent without them.

**Q: Will my old commands break?**
A: No. All commands continue to work across minor versions (3.0 → 3.1). Major version changes (3.x → 4.0) will provide migration paths.

**Q: What if I like explicit commands?**
A: Keep using them! `/oh-my-claudecode:ralph`, `/oh-my-claudecode:ultrawork`, and `/oh-my-claudecode:plan` work. Note: `/oh-my-claudecode:planner` now redirects to `/oh-my-claudecode:plan`.

**Q: How do I know what Claude is doing?**
A: Claude announces major behaviors: "I'm activating ralph-loop..." or set up `/oh-my-claudecode:hud` for real-time status.

**Q: Where's the full command list?**
A: See [README.md](../README.md) for full command reference. All commands still work.

**Q: What's the difference between keywords and natural language?**
A: Keywords are explicit shortcuts. Natural language triggers auto-detection. Both work.

---

## Need Help?

- **Diagnose issues**: Run `/oh-my-claudecode:omc-doctor`
- **See all commands**: Run `/oh-my-claudecode:omc-help`
- **View real-time status**: Run `/oh-my-claudecode:hud setup`
- **Review detailed changelog**: See [CHANGELOG.md](../CHANGELOG.md)
- **Report bugs**: [GitHub Issues](https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/issues)

---

## What's Next?

Now that you understand the migration:

1. **For immediate impact**: Start using keywords (`ralph`, `ulw`, `plan`) in your work
2. **For full power**: Read [docs/CLAUDE.md](CLAUDE.md) to understand orchestration
3. **For advanced usage**: Check [docs/ARCHITECTURE.md](ARCHITECTURE.md) for deep dives
4. **For team onboarding**: Share this guide with teammates

Welcome to oh-my-claudecode!
