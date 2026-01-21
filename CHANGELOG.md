# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.1.0] - 2026-01-21

### Added
- **8 new specialized agents** (ECC integration):
  - `security-reviewer` / `security-reviewer-low`: Security vulnerability analysis
  - `build-fixer` / `build-fixer-low`: Build error diagnosis and fixes
  - `tdd-guide` / `tdd-guide-low`: Test-driven development guidance
  - `code-reviewer` / `code-reviewer-low`: Code review and quality feedback
- **Update notification**: omc-setup now checks for and notifies about available updates
- **Rate limit reset times**: HUD shows when limits reset (e.g., `5h:0% wk:100%(1d6h)`)
- **Todos on second line**: HUD now displays todos separately as `todos:3/5 (working: task)`

### Changed
- **omc-setup rebuild behavior**: Now shows version changes when refreshing CLAUDE.md
- **Cache clearing**: omc-setup automatically removes stale plugin cache versions
- **API timeout**: Increased from 5s to 10s for slower connections
- **Cache TTL**: Reduced from 60s to 30s for fresher rate limit data

### Fixed
- **Credential reading**: Handle nested `claudeAiOauth` wrapper in credentials.json
- **HUD semver sorting**: Fixed version comparison to use numeric sort instead of alphabetical
- **ESLint**: Disabled `no-control-regex` for ANSI escape code handling in tests

## [3.0.11] - 2026-01-20

### Changed

- **Fully-qualified command names**: Documentation now uses `/oh-my-claudecode:omc-setup` and `/oh-my-claudecode:help` for namespace consistency
- **Commands folder populated**: All user-facing commands now have full content (copied from skills)
- **Separated commands vs skills**:
  - 20 commands (user-facing): analyze, cancel-ralph, cancel-ultraqa, cancel-ultrawork, deepinit, deepsearch, doctor, help, hud, learner, note, omc-setup, plan, ralph, ralph-init, ralplan, release, review, ultraqa, ultrawork
  - 6 skills-only (internal): orchestrate, frontend-ui-ux, git-master, omc-default, omc-default-global, planner
- **Consolidated planner into plan**: `planner` is now skill-only; users invoke via `/oh-my-claudecode:plan`

---

## [3.0.0] - 2026-01-20

### 🎨 Complete Rebrand - From Mythology to Intuition

This is a **breaking release** that renames the entire project and all agent names for clarity and accessibility.

### Breaking Changes

- **Package Renamed**: `oh-my-claude-sisyphus` → `oh-my-claudecode`
  - Installation: `npx oh-my-claudecode install` (previously `npx oh-my-claude-sisyphus install`)
  - All references updated in documentation and code

- **Agent Names Changed**: Greek mythology → Intuitive names
  - `prometheus` → `planner` (strategic planning)
  - `momus` → `critic` (plan review)
  - `oracle` → `architect` (architecture & debugging)
  - `metis` → `analyst` (pre-planning analysis)
  - `mnemosyne` → `learner` (learned skills system)
  - `sisyphus-junior` → `executor` (focused execution)
  - `librarian` → `researcher` (documentation research)
  - `frontend-engineer` → `designer` (UI/UX work)
  - `document-writer` → `writer` (technical documentation)
  - `multimodal-looker` → `vision` (visual analysis)
  - `orchestrator-sisyphus` → `orchestrator` (task coordination)

- **Directory Structure**: `.sisyphus/` → `.omc/` (oh-my-claudecode)
  - State files now in `~/.claude/.omc/`
  - Runtime plans in `.omc/plans/`
  - Session notes in `.omc/notepads/`

- **Environment Variables**: `SISYPHUS_*` → `OMC_*`
  - All environment variable prefixes updated for consistency

- **Slash Commands Updated**: Agent-referencing commands now use new names
  - `/plan` now uses `planner` agent (was `prometheus`)
  - `/review` now uses `critic` agent (was `momus`)
  - `/mnemosyne` → `/learner` for skill extraction

### Migration Guide

For existing users upgrading from 2.x:

1. **Reinstall**: Run `npx oh-my-claudecode install` to update hooks and configs
2. **State Migration**: Old `.sisyphus/` directories will continue to work, but new state saves to `.omc/`
3. **Agent References**: Update any custom scripts/configs that referenced old agent names
4. **Environment Variables**: Rename any `SISYPHUS_*` variables to `OMC_*`

### Rationale

The Greek mythology naming convention, while elegant, created barriers for new users:
- Non-obvious agent purposes ("What does Prometheus do?")
- Cultural accessibility concerns
- Increased cognitive load for remembering agent roles

The new intuitive names (`planner`, `architect`, `critic`) make the system immediately understandable.

### Note on Historical Entries

All changelog entries below v3.0.0 reference the old names (`prometheus`, `sisyphus-junior`, etc.) - this is intentional and accurate for those versions.

---

## [3.0.0-beta] - 2026-01-19

### 🧠 Mnemosyne - Learned Skills System (Major Feature)

Named after the Greek Titan goddess of memory, **Mnemosyne** enables Claude to extract, store, and automatically reuse knowledge from problem-solving sessions.

### 📊 Sisyphus HUD - Multi-Agent Statusline (Major Feature)

Real-time visualization of the Sisyphus orchestration system via Claude Code's statusline.

### Added

- **Mnemosyne - Learned Skills** (`src/hooks/mnemosyne/`)
  - `/mnemosyne` command to extract reusable skills from conversations
  - Automatic skill injection based on trigger keywords in user messages
  - **Hybrid storage**: User-level (`~/.claude/skills/sisyphus-learned/`) + Project-level (`.sisyphus/skills/`)
  - YAML frontmatter format for skill metadata (triggers, tags, quality scores)
  - Quality gate validation for skill extraction
  - Pattern detection for extractable moments (problem-solution, technique, workaround, optimization)
  - Promotion from ralph-progress learnings to skills
  - Configuration system with `~/.claude/sisyphus/mnemosyne.json`
  - `skill-injector.mjs` hook for UserPromptSubmit

- **Sisyphus HUD Statusline** (`src/features/hud/`)
  - Real-time statusline showing system state
  - **Display presets**: minimal, focused (default), full
  - **Elements**: ralph loop progress, PRD story, ultrawork status, context usage, agents, background tasks, todos
  - **Color coding**: Green (healthy), Yellow (warning), Red (critical)
  - `/hud` command to configure display options
  - Auto-refresh every ~300ms during active sessions
  - Type-coded agent visualization with model tier colors

- **New Commands**
  - `/mnemosyne` - Extract learned skills from current conversation
  - `/hud [preset]` - Configure HUD display (minimal/focused/full)
  - `/hud status` - Show detailed HUD status

- **New Test Suites**
  - `src/__tests__/mnemosyne/` - 41 tests for learned skills system
  - `src/__tests__/hud-agents.test.ts` - 44 tests for HUD agents
  - Total: **443 tests** (up from 399)

### Changed

- **Module Naming**: Adopted Greek mythology naming convention
  - `learned-skills` → `mnemosyne` (goddess of memory)
  - Exports: `Claudeception*` → `Mnemosyne*`

- **Context Injector**: Added `mnemosyne` as a context source type

### Breaking Changes

- Renamed `/claudeception` to `/mnemosyne`
- Renamed config from `claudeception.json` to `mnemosyne.json`
- Module path changed from `hooks/learned-skills` to `hooks/mnemosyne`

---

## [2.6.1] - 2026-01-19

### Added

- **Help Command** (`commands/help.md`)
  - Comprehensive `/oh-my-claudecode:help` command to guide users on plugin usage
  - Quick reference for all 19 commands and 19 agents
  - Example workflows for common tasks
  - Tips for effective usage and best practices
  - Integration with plugin documentation

### Fixed

- **Stop Hook Compatibility** (`scripts/persistent-mode.mjs`)
  - Fixed ERR_MODULE_NOT_FOUND error when upgrading from 2.5.0 to 2.6.0
  - Made notepad module import dynamic with graceful fallback
  - Hook now works even if notepad module is missing (backward compatibility)

## [2.6.0] - 2026-01-19

### 🧠 Compaction-Resilient Memory System (Major Feature)

This release introduces a **three-tier memory system** that survives context compaction, ensuring Claude never loses critical project knowledge during long sessions.

### 🔄 Ralph Loop PRD Support (Major Feature)

Implements structured task tracking inspired by the original [Ralph](https://github.com/snarktank/ralph) project. This brings PRD-based task management to ralph-loop, enabling reliable completion tracking across iterations.

### Added

- **Notepad Memory System** (`src/hooks/notepad/index.ts`) - **Compaction-Resilient Context**
  - `.sisyphus/notepad.md` persists across context compactions
  - **Three-tier storage architecture:**
    - **Priority Context** - Always loaded on session start (max 500 chars, critical discoveries)
    - **Working Memory** - Session notes with timestamps (auto-pruned after 7 days)
    - **MANUAL** - User content that is never auto-pruned
  - **Auto-injection** of Priority Context via SessionStart hook
  - **Auto-pruning** of old Working Memory entries on session stop
  - `/note <content>` command for manual note-taking

- **Remember Tag Auto-Capture** (`src/installer/hooks.ts`) - **PostToolUse Hook**
  - `<remember>content</remember>` - Auto-saves to Working Memory section
  - `<remember priority>content</remember>` - Auto-saves to Priority Context section
  - Agents can output remember tags to persist discoveries across compactions
  - Works without jq dependency (grep/sed fallback)
  - Installed as `post-tool-use.sh` hook

- **PRD (Product Requirements Document) Support** (`src/hooks/ralph-prd/index.ts`)
  - `prd.json` structured task format with user stories, acceptance criteria, priorities
  - Story status tracking (`passes: boolean`) for completion detection
  - CRUD operations: `readPrd`, `writePrd`, `markStoryComplete`, `getNextStory`
  - Status calculation: `getPrdStatus` returns completion stats
  - Formatting utilities for display and context injection

- **Progress Memory System** (`src/hooks/ralph-progress/index.ts`)
  - Append-only `progress.txt` for memory persistence between iterations
  - Codebase patterns section for consolidated learnings
  - Per-story progress entries with implementation notes, files changed, learnings
  - Pattern extraction and learning retrieval for context injection

- **New Commands**
  - `/ralph-init <task>` - Scaffold a PRD from task description with auto-generated user stories
  - `/ultrawork-ralph <task>` - Maximum intensity mode with completion guarantee (ultrawork + ralph loop)
  - `/ultraqa <goal>` - Autonomous QA cycling workflow (test → verify → fix → repeat)
  - `/sisyphus-default` - Configure Sisyphus in local project `.claude/CLAUDE.md`
  - `/sisyphus-default-global` - Configure Sisyphus globally in `~/.claude/CLAUDE.md`
  - `/note <content>` - Save notes to notepad.md for compaction resilience

- **New Agent Tiers**
  - `qa-tester-high` (Opus) - Complex integration testing

- **New Hooks**
  - `PostToolUse` hook for processing Task agent output
  - Remember tag detection and notepad integration

- **Comprehensive Test Suites**
  - `src/__tests__/ralph-prd.test.ts` - 29 tests for PRD operations
  - `src/__tests__/ralph-progress.test.ts` - 30 tests for progress tracking
  - `src/__tests__/notepad.test.ts` - 40 tests for notepad operations
  - `src/__tests__/hooks.test.ts` - 18 new tests for design flaw fixes
  - Total: **358 tests** (up from 231)

### Changed

- **Ralph Loop Enhanced**
  - Auto-initializes PRD when user runs `/ralph-loop` without existing `prd.json`
  - PRD-based completion: loop ends when ALL stories have `passes: true`
  - Context injection includes current story, patterns, and recent learnings
  - Updated continuation prompts with structured story information

- **Persistent Mode Integration**
  - `src/hooks/persistent-mode/index.ts` now imports and uses PRD completion checking
  - Checks PRD status before allowing ralph-loop completion
  - Clears ultrawork state when PRD loop completes (for ultrawork-ralph)

- **Installer Enhanced**
  - Now installs `post-tool-use.sh` hook for remember tag processing
  - Registers `PostToolUse` hook in settings.json
  - Platform-aware hook installation (bash/node.js)

### Fixed

- **Stale position bug in `addPattern`** - Placeholder removal now happens before calculating separator position
- **Type safety in `createPrd`** - New `UserStoryInput` type with optional priority field
- **Recursion guard in `addPattern`** - Prevents infinite loops on repeated initialization failures
- **Todo-continuation infinite loop** - Added max-attempts counter (5) to prevent agent getting stuck
- **UltraQA/Ralph-Loop conflict** - Added mutual exclusion to prevent both loops running simultaneously
- **Agent name prefixing** - Standardized all Task() calls to use `oh-my-claude-sisyphus:` prefix
- **VERSION constant mismatch** - Fixed installer VERSION from 2.4.1 to 2.6.0
- **Completion promise inconsistency** - Standardized to `TASK_COMPLETE`
- **Non-existent /start-work command** - Removed references to command that doesn't exist

### Technical Details

**Notepad.md Structure:**
```markdown
# Notepad
<!-- Auto-managed by Sisyphus. Manual edits preserved in MANUAL section. -->

## Priority Context
<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->
Project uses pnpm not npm
API client at src/api/client.ts

## Working Memory
<!-- Session notes. Auto-pruned after 7 days. -->

### 2026-01-19 10:30
Discovered auth middleware in src/middleware/auth.ts

### 2026-01-19 09:15
Database schema uses PostgreSQL with Prisma ORM

## MANUAL
<!-- User content. Never auto-pruned. -->
User's permanent notes here
```

**Remember Tag Usage:**
```
Agent output: <remember>Project uses TypeScript strict mode</remember>
→ Saved to Working Memory with timestamp

Agent output: <remember priority>API base URL is https://api.example.com</remember>
→ Saved to Priority Context (replaces previous)
```

**PRD Structure:**
```json
{
  "project": "ProjectName",
  "branchName": "ralph/feature-name",
  "description": "Feature description",
  "userStories": [
    {
      "id": "US-001",
      "title": "Story title",
      "description": "User story description",
      "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
      "priority": 1,
      "passes": false
    }
  ]
}
```

**Progress.txt Structure:**
```
# Ralph Progress Log
Started: 2026-01-19T...

## Codebase Patterns
- Pattern learned from iteration 1
- Pattern learned from iteration 2

---

## [2026-01-19 12:00] - US-001
**What was implemented:**
- Feature A
- Feature B

**Learnings for future iterations:**
- Important pattern discovered
```

---

## [2.0.1] - 2026-01-13

### Added
- **Vitest test framework** with comprehensive test suite (231 tests)
  - Model routing tests (100 tests)
  - Hook system tests (78 tests)
  - Skill activation tests (15 tests)
  - Installer validation tests (28 tests)
- **Windows native support improvements**
  - Cross-platform command detection (which → where on Windows)
  - Platform-aware auto-update with graceful Windows handling
  - Fixed Unix-only shell redirects

### Changed
- Synced shell script installer with TypeScript installer
- Removed deprecated orchestrator command from shell script
- Removed separate skills directory (now via commands only)

### Fixed
- Cross-platform `which` command replaced with platform-aware detection
- Auto-update now handles Windows gracefully with helpful error message
- Shell script command count matches TypeScript installer (11 commands)
- **Agent frontmatter** - Added missing `name` and `description` fields to all 11 agents
  - Per Claude Code sub-agent specification requirements

---

## [2.0.0-beta.2] - 2026-01-13

### 🧪 New: QA-Tester Agent for Interactive Testing

**Added tmux-based interactive testing capabilities for CLI/service verification.**

### Added
- **QA-Tester Agent** (`src/agents/qa-tester.ts`)
  - Interactive CLI testing using tmux sessions
  - Prerequisite checking (tmux availability, server connections)
  - Structured test execution workflow
  - Oracle → QA-Tester diagnostic loop pattern

- **Smart Gating for qa-tester** in ultrawork/skills
  - Prefer standard test suites over qa-tester when available
  - Use qa-tester only when interactive testing is truly needed
  - Token-efficient verification decisions

- **Adaptive Routing for qa-tester**
  - Simple verification → Haiku
  - Interactive testing → Sonnet
  - Complex integration → Opus

### Changed
- Updated ultrawork skill with verification protocol and qa-tester gating
- Updated ralph-loop and orchestrator with qa-tester integration
- Updated sisyphus command with Agent Combinations section

### Refactored
- **Merged sisyphus+orchestrator+ultrawork into default mode** - 80% behavior overlap consolidated
  - Default mode is now an intelligent orchestrator
  - `/orchestrator` command deprecated (use default mode or `/ultrawork`)
  - Skill composition replaces agent swapping
- **Removed deprecated orchestrator command** - Deleted `commands/orchestrator.md` and `orchestratorSkill` (1352 lines)
- **Updated attribution** - Changed from "Port of" to "Inspired by" oh-my-opencode (70% divergence)

### Fixed
- **Migrated to ESLint v9 flat config** - Created `eslint.config.js` for modern ESLint
- **Resolved all 50 lint warnings** - Removed unused imports, fixed prefer-const, updated re-exports
- Synced installer COMMAND_DEFINITIONS with updated skills
- Handle malformed settings.json gracefully in install.sh

---

## [2.0.0-beta.1] - 2026-01-13

### 🚀 Revolutionary: Intelligent Model Routing

**This is a major release introducing adaptive model routing for all agents.**

The orchestrator (Opus) now analyzes task complexity BEFORE delegation and routes to the appropriate model tier (Haiku/Sonnet/Opus). This dramatically improves efficiency - simple tasks use faster, cheaper models while complex tasks get the full power of Opus.

### Added
- **Intelligent Model Routing System** (`src/features/model-routing/`)
  - `types.ts`: Core types for routing (ComplexityTier, RoutingDecision, etc.)
  - `signals.ts`: Complexity signal extraction (lexical, structural, context)
  - `scorer.ts`: Weighted scoring system for complexity calculation
  - `rules.ts`: Priority-based routing rules engine
  - `router.ts`: Main routing logic with `getModelForTask()` API
  - `prompts/`: Tier-specific prompt adaptations (opus.ts, sonnet.ts, haiku.ts)

- **Adaptive Routing for ALL Agents**
  - Only orchestrators are fixed to Opus (they analyze and delegate)
  - All other agents adapt based on task complexity:
    - `oracle`: lookup → Haiku, tracing → Sonnet, debugging → Opus
    - `prometheus`: breakdown → Haiku, planning → Sonnet, strategic → Opus
    - `momus`: checklist → Haiku, gap analysis → Sonnet, adversarial → Opus
    - `metis`: impact → Haiku, deps → Sonnet, risk analysis → Opus
    - `explore`: simple search → Haiku, complex → Sonnet
    - `document-writer`: simple docs → Haiku, complex → Sonnet
    - `sisyphus-junior`: simple fix → Haiku, module work → Sonnet, risky → Opus

- **Complexity Signal Detection**
  - Lexical: word count, keywords (architecture, debugging, risk, simple)
  - Structural: subtask count, cross-file deps, impact scope, reversibility
  - Context: previous failures, conversation depth, plan complexity

- **Tiered Prompt Adaptations**
  - Haiku: Concise, direct prompts for speed
  - Sonnet: Balanced prompts for efficiency
  - Opus: Deep reasoning prompts with thinking mode

### Changed
- **Orchestrator Prompts** updated with intelligent routing guidance
- **Configuration** (`src/config/loader.ts`) now includes routing options
- **Types** (`src/shared/types.ts`) extended with routing configuration

### Breaking Changes
- Routing is now proactive (orchestrator decides upfront) instead of reactive
- Deprecated `routeWithEscalation()` - use `getModelForTask()` instead

### Migration Guide
No action needed - the system automatically routes based on complexity. To override:
```typescript
Task(subagent_type="oracle", model="opus", prompt="Force Opus for this task")
```

---

## [1.11.0] - 2026-01-13

### Added
- **Enhanced Hook Enforcement System** - Stronger Sisyphus behavior enforcement beyond CLAUDE.md
  - `pre-tool-enforcer.sh`: PreToolUse hook that injects contextual Sisyphus reminders before every tool execution
  - `post-tool-verifier.sh`: PostToolUse hook for verification after tools, with failure detection
  - Enhanced `persistent-mode.sh`: Stop hook now includes build/test/git/background task verification
  - `claude-sisyphus.sh`: CLI wrapper that uses `--append-system-prompt` for direct system prompt injection
  - `sisyphus-aliases.sh`: Shell aliases (`claude-s`, `claudew`) for easy activation

### Changed
- **Stop Hook** now enforces additional verification requirements:
  - Build verification (if build scripts exist)
  - Test verification (if tests exist)
  - Git status check (warns on uncommitted changes)
  - Background task completion check
  - All previous checks (Ralph Loop, Ultrawork, Todo completion)

- **Hook Configuration** - Added PreToolUse and PostToolUse to `hooks.json`

### Technical Details
- PreToolUse hook provides tool-specific reminders (Bash, Task, Edit, Write, Read, Grep/Glob)
- PostToolUse hook tracks session statistics in `~/.claude/.session-stats.json`
- Stop hook returns `continue: false` until ALL verification requirements are met
- CLI wrapper appends core Sisyphus rules directly to Claude's system prompt

### Enforcement Hierarchy
1. **Stop Hook** with `continue: false` - Blocks ALL stopping until verified
2. **PreToolUse** - Injects reminders BEFORE every tool
3. **PostToolUse** - Verifies AFTER every tool
4. **CLI Wrapper** - Appends rules to system prompt

## [1.10.0] - 2026-01-11

### Added
- **Persistent Mode System** - Enhanced hook system for auto-continuation
  - `ultrawork-state` module: Manages persistent ultrawork mode state across sessions
  - `persistent-mode` hook: Unified Stop handler for ultrawork, ralph-loop, and todo continuation
  - `session-start` hook: Restores persistent mode states when a new session starts
  - Three-layer priority enforcement: Ralph Loop > Ultrawork > Todo Continuation

- **Claude Code Native Hooks Integration**
  - SessionStart hook for mode restoration on session resume
  - Enhanced Stop hook with persistent mode detection
  - Cross-platform support (Bash for Unix, Node.js for Windows)

- **Popular Plugin Patterns Module** (`plugin-patterns`)
  - Auto-format support for multiple languages (TypeScript, Python, Go, Rust)
  - Lint validation with language-specific linters
  - Conventional commit message validation
  - TypeScript type checking integration
  - Test runner detection and execution
  - Pre-commit validation workflow

### Changed
- **Bridge Module** - Added persistent-mode and session-start hook handlers
- **Keyword Detector** - Now activates ultrawork state when ultrawork keyword is detected
- **Settings Configuration** - Added SessionStart hook configuration for both Bash and Node.js

### Technical Details
- New hooks: `persistent-mode.sh/.mjs`, `session-start.sh/.mjs`
- State files: `.sisyphus/ultrawork-state.json`, `~/.claude/ultrawork-state.json`
- Ultrawork mode now persists across stop attempts when todos remain incomplete
- Ralph-loop continues with iteration tracking and reinforcement messages

## [1.9.0] - 2026-01-10

### Changed
- **Synced all builtin skills with oh-my-opencode source implementation**
  - Updated `orchestrator` skill (1302 lines) with complete orchestrator-sisyphus.ts template
  - Updated `sisyphus` skill (362 lines) with complete sisyphus.ts template
  - Updated `ultrawork` skill (97 lines) - cleaned and adapted from keyword-detector
  - Updated `ralph-loop` skill (11 lines) from ralph-loop hook
  - Updated `git-master` skill with 1131-line comprehensive template
  - Updated `frontend-ui-ux` skill with enhanced Work Principles section

### Fixed
- **Installer improvements**
  - Fixed skill path format from `'skill-name.md'` to `'skill-name/skill.md'`
  - Fixed agent path for prometheus from `'prometheus/skill.md'` to `'prometheus.md'`
  - Added directory creation for both commands and skills to prevent ENOENT errors
  - Fixed ultrawork skill to remove JavaScript wrapper code (clean prompt only)

- **Template escaping**
  - Properly escaped backticks, template literals (`${}`), and backslashes in all skill templates
  - Fixed TypeScript compilation errors due to improper template string escaping

- **SDK adaptation**
  - Converted all oh-my-opencode SDK patterns to Claude Code SDK:
    - `sisyphus_task()` → `Task(subagent_type=...)`
    - `background_output()` → `TaskOutput()`
    - References to OhMyOpenCode → Oh-My-ClaudeCode-Sisyphus

### Verified
- All 6 builtin skills install correctly to `~/.claude/skills/`
- Orchestrator skill properly delegates with `Task(subagent_type=...)`
- Ultrawork skill contains clean verification guarantees and zero-tolerance failures
- Build completes without TypeScript errors
- Installation completes successfully

## [1.8.0] - 2026-01-10

### Added
- Intelligent Skill Composition with task-type routing
- Architecture comparison documentation (OpenCode vs Claude Code)
- Intelligent Skill Activation section to README

### Changed
- Merged feature/auto-skill-routing branch

## [1.7.0] - Previous Release

### Added
- Windows support with Node.js hooks
- ESM import for tmpdir

---

[2.6.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v2.5.0...v2.6.0
[2.0.1]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v2.0.0...v2.0.1
[1.11.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/releases/tag/v1.7.0
