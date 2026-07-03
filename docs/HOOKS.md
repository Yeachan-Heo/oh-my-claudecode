# Hooks System

> OMC's 21 hooks intercept Claude Code lifecycle events to enable magic keywords, context injection, and quality enforcement.

## What Are Hooks?

Hooks are scripts that execute automatically in response to Claude Code lifecycle events. oh-my-claudecode extends Claude Code's default behavior with 21 hooks.

When a user submits a prompt, a tool runs, or a session starts/ends, hooks fire automatically to inject additional context, activate modes, and manage state.

## How Hooks Work

Hooks are defined in a `hooks.json` file. Each hook follows this structure:

```json
{
  "EventName": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "node scripts/hook-script.mjs",
          "timeout": 5
        }
      ]
    }
  ]
}
```

- **EventName**: The lifecycle event the hook responds to
- **matcher**: Condition for running the hook (`*` matches all cases)
- **command**: The Node.js script to execute
- **timeout**: Maximum execution time in seconds

Hook output is injected into Claude via `<system-reminder>` tags. Additional context is passed through `hookSpecificOutput.additionalContext`.

## Hook Categories

OMC hooks fall into four categories:

### Core Hooks

Handle orchestration, keyword detection, and mode persistence.

| Hook | Description |
|------|-------------|
| keyword-detector | Detects magic keywords and activates corresponding skills |
| persistent-mode | Enforces continuation when an execution mode (ralph, autopilot, ultrawork, etc.) is active — injects reinforcement messages on Stop to prevent premature halting |

### Context Management Hooks

Manage memory, project state, and compaction.

| Hook | Description |
|------|-------------|
| notepad | Compaction-resistant memory system |
| project-memory | Manages project-level memory |
| pre-compact | Processes state before compaction |

### Quality / Verification Hooks

Handle code quality, permissions, and subagent tracking.

| Hook | Description |
|------|-------------|
| permission-handler | Handles permission requests and validation |
| subagent-tracker | Tracks subagent spawn and completion |
| code-simplifier | Auto-simplifies recently modified files on Stop (opt-in) |
| workflow-drift-guard | Blocks only deterministic Stop-hook workflow drift: structured-question drift and fake completion with changed-code TODO/stub/skipped-test blockers |

## Disabling Hooks

### Disable All Hooks

```bash
export DISABLE_OMC=1
```

### Disable Specific Hooks

```bash
export OMC_SKIP_HOOKS="keyword-detector,notepad"
```

Separate hook names with commas to skip only those hooks.

---

## Lifecycle Events

Claude Code emits events throughout a session. OMC attaches hooks to these events to extend behavior. There are 11 lifecycle events.

### UserPromptSubmit

Fires when the user submits a prompt.

| Script | Role | Timeout |
|--------|------|---------|
| `keyword-detector.mjs` | Detects magic keywords and invokes the corresponding skill | 10s |
| `skill-injector.mjs` | Injects skill prompts | 15s |

Runs on all user input (`matcher: "*"`). When the keyword detector finds keywords like "ultrawork", "ralph", or "autopilot", it injects the corresponding skill invocation instruction via `additionalContext`.

### SessionStart

Fires when a new session begins.

| Script | Matcher | Role | Timeout |
|--------|---------|------|---------|
| `session-start.mjs` | `*` | Session initialization, state restoration | 5s |
| `project-memory-session.mjs` | `*` | Loads project memory | 5s |
| `setup-init.mjs` | `init` | Initial setup wizard | 30s |
| `setup-maintenance.mjs` | `maintenance` | Maintenance tasks | 60s |

The `init` and `maintenance` matchers only run in special cases. For normal session starts, only the two `*` matcher scripts execute.

### PreToolUse

Fires immediately before Claude uses a tool.

| Script | Role | Timeout |
|--------|------|---------|
| `pre-tool-enforcer.mjs` | Validates rules before tool use | 3s |

Runs on all tool calls (`matcher: "*"`). Enforces agent permission restrictions (e.g., blocking Write/Edit for read-only agents).

### PermissionRequest

Fires when a permission request arises during Bash tool execution.

| Script | Matcher | Role | Timeout |
|--------|---------|------|---------|
| `permission-handler.mjs` | `Bash` | Handles Bash command permissions | 5s |

Only processes permission requests for the Bash tool.

### PostToolUse

Fires after a tool use completes.

| Script | Role | Timeout |
|--------|------|---------|
| `post-tool-verifier.mjs` | Verifies tool results and injects additional context | 3s |
| `project-memory-posttool.mjs` | Updates project memory | 3s |

Injects additional guidance based on Read, Write, Edit, and Bash results. For example, after reading a file it may hint "consider using parallel reads."

### PostToolUseFailure

Fires when a tool use fails.

| Script | Role | Timeout |
|--------|------|---------|
| `post-tool-use-failure.mjs` | Provides recovery guidance for failed tool use | 3s |

Disable via `DISABLE_OMC=1` (or `DISABLE_OMC=true`) or `OMC_SKIP_HOOKS=post-tool-use-failure` (the `post-tool-use` token also skips it, alongside `post-tool-verifier.mjs`).

### SubagentStart

Fires when a subagent is spawned.

| Script | Role | Timeout |
|--------|------|---------|
| `subagent-tracker.mjs start` | Tracks subagent start, injects prompts | 3s |

Records the subagent name, start time, and session information.

### SubagentStop

Fires when a subagent completes.

| Script | Role | Timeout |
|--------|------|---------|
| `subagent-tracker.mjs stop` | Tracks subagent completion | 5s |
| `verify-deliverables.mjs` | Verifies subagent deliverables | 5s |

### PreCompact

Fires immediately before context compaction.

| Script | Role | Timeout |
|--------|------|---------|
| `pre-compact.mjs` | Preserves state before compaction | 10s |
| `project-memory-precompact.mjs` | Preserves project memory | 5s |

Saves important state and memory before compaction runs because the context window is full.

### Stop

Fires when Claude finishes a response.

| Script | Role | Timeout |
|--------|------|---------|
| `context-guard-stop.mjs` | Monitors context usage | 5s |
| `workflow-drift-guard.mjs` | Blocks narrow structured-question and fake-completion drift | 3s |
| `persistent-mode.cjs` | Maintains active mode state (ralph, ultrawork, etc.) | 10s |
| `code-simplifier.mjs` | Auto-simplifies modified files (opt-in) | 5s |

`persistent-mode` injects a reinforcement message like "The boulder never stops" when an active execution mode is running, prompting continued work.

### SessionEnd

Fires when a session ends.

| Script | Role | Timeout |
|--------|------|---------|
| `session-end.mjs` | Saves session summary, sends callback notifications | 30s |

Saves agent activity, token usage, and other session data to `.omc/sessions/`. If configured, sends completion notifications via Discord, Telegram, or Slack.

---

## Core Hooks

### Core Hook Details

#### keyword-detector

Detects magic keywords in user prompts and invokes the corresponding skill.

- **Event**: UserPromptSubmit
- **Behavior**: Sanitizes the prompt (removes code blocks, URLs, file paths) then matches keyword patterns
- **Conflict resolution**: cancel has highest priority, then ralph > autopilot > ultrawork
- **Safety**: Disabled inside team workers to prevent infinite spawning

See the [Magic Keywords](#magic-keywords) section for the full keyword list.


#### workflow-drift-guard

Blocks only deterministic recurring workflow drift at the Claude Code `Stop` lifecycle point. The boundary follows the official Claude Code [hooks reference](https://code.claude.com/docs/en/hooks): Stop hooks receive `last_assistant_message`, may return `decision: "block"` with a `reason`, and must account for `stop_hook_active` to avoid self-reinforcing loops. Plugin/Hookify installs follow the official Claude Code [plugins reference](https://code.claude.com/docs/en/plugins-reference): plugin hooks can live in `hooks/hooks.json` at the plugin root and respond to the same lifecycle events as user hooks.

- **Event**: Stop
- **Behavior**: Blocks when the final assistant message ends with a narrow preference/approval question that should be asked via structured `AskUserQuestion`; the reason tells Claude to use 2-4 options and keep `allowOther` enabled unless free-form input is unsafe.
- **Fake completion guard**: Blocks only when the final assistant message claims completion and changed code adds deterministic blockers (`test.skip`/`.only`, placeholder TODOs, unimplemented throws, placeholder returns, or explicit stub/placeholder implementations).
- **Allowed cases**: Free-form/`Other` question wording is allowed; TODO/stub markers are allowed while the assistant is not claiming completion; `stop_hook_active` fails open to avoid hook loops.
- **Minimal safe boundary**: Worktree/session continuity remains SessionStart guidance plus existing mode-state restoration because a generic Stop hook cannot safely infer that the assistant is in the wrong branch or has lost context without overblocking valid work.

#### persistent-mode

Enforces continuation when an execution mode is active. This is the hook that keeps skills like autopilot, ralph, and ultrawork running.

- **Event**: Stop
- **Behavior**: Checks `.omc/state/` for active mode state files. If any mode (ralph, ultragoal, autopilot, ultrawork, ultraqa, team, pipeline) is active, injects a reinforcement message to prevent Claude from stopping.
- **Reinforcement message**: "The boulder never stops" — prompts Claude to continue working
- **Staleness check**: States older than 2 hours are treated as inactive to prevent stale state from blocking new sessions
- **Notification**: Sends Discord/Telegram/Slack notification on first stop (if configured)
- **Cancel**: Use `/oh-my-claudecode:cancel` to deactivate modes

> **Note**: autopilot, ralph, ultrawork, and ultraqa are **skills** (invoked via keyword-detector), not hooks. The persistent-mode hook is what enforces their continuation by blocking the Stop event.

### Mode State Management

Execution mode hooks manage state files in the `.omc/state/` directory.

```json
{
  "active": true,
  "started_at": "2025-01-15T10:30:00Z",
  "prompt": "ultrawork implement auth",
  "session_id": "abc123",
  "project_path": "/path/to/project",
  "iteration": 0,
  "max_iterations": 10,
  "linked_ultrawork": false,
  "last_checked_at": "2025-01-15T10:30:00Z"
}
```

When a session ID is present, state is stored in session scope under `.omc/state/sessions/{sessionId}/`.


#### ultragoal-state.json lifecycle

`ultragoal-state.json` is the session-scoped Stop/PreToolUse guard for `$ultragoal` runs. The durable plan and audit trail remain `.omc/ultragoal/goals.json` and `.omc/ultragoal/ledger.jsonl`; the state file only records the active runtime guard.

- **Location**: `.omc/state/sessions/{sessionId}/ultragoal-state.json` when a Claude session id is available; legacy fallback is `.omc/state/ultragoal-state.json`.
- **Active fields**: `active: true`, `session_id`, `project_path`, `started_at`, `last_checked_at`, `current_phase`, optional `claude_goal_objective`, and `reinforcement_count`.
- **Stop hook**: reinforces only when the state is active, fresh (within the normal 2-hour mode-state freshness window), session-matching, and project-matching. Terminal phases (`complete`, `completed`, `done`, `all-done`, `failed`, `cancelled`) and all-done `.omc/ultragoal/goals.json` plans are ignored.
- **PreToolUse guard**: while active, tools are denied unless the hook can see a matching active Claude `/goal` snapshot. Use `ALLOW_ULTRAGOAL_WITHOUT_GOAL=1` only as an intentional local bypass.
- **Completion**: after the final quality gate and ultragoal checkpoint, mark the state inactive or run `/oh-my-claudecode:cancel` so the state file is cleared with other workflow state.

#### Canceling a Mode

```
cancelomc
```

or

```
/oh-my-claudecode:cancel
```

`cancel` removes state files for all active modes: ralph, autopilot, ultrawork, and any others.

---

## Context Management Hooks

Claude Code's context window is finite. During long sessions, compaction occurs and previous conversation content is summarized. OMC's context management hooks prepare for compaction, preserve important information, and maintain project-level memory.

### notepad

A compaction-resistant memory system.

- **Storage path**: `.omc/notepad.md`
- **MCP tools**: `notepad_read`, `notepad_write_priority`, `notepad_write_working`, `notepad_write_manual`
- **Behavior**: Information written to the notepad persists after compaction

The notepad supports three priority levels:

| Priority | Tool | Description |
|----------|------|-------------|
| Priority | `notepad_write_priority` | Information that must never be lost |
| Working | `notepad_write_working` | Current work-in-progress status |
| Manual | `notepad_write_manual` | Manually recorded notes |

Use `notepad_prune` to clean up old entries and `notepad_stats` to check status.

### project-memory

Manages permanent project-level memory.

- **Storage path**: `.omc/project-memory.json`
- **MCP tools**: `project_memory_read`, `project_memory_write`, `project_memory_add_note`, `project_memory_add_directive`
- **Related hooks**:
  - `project-memory-session.mjs` (SessionStart): Loads project memory when session starts
  - `project-memory-posttool.mjs` (PostToolUse): Updates memory after tool use
  - `project-memory-precompact.mjs` (PreCompact): Preserves memory before compaction
- **Multi-session contract**: Both writers acquire `withProjectMemoryLock` (see `src/lib/file-lock.ts`) before reading or rewriting `project-memory.json`. Concurrent sessions in the same workspace serialize through this lock, so lost-update races between parallel Claude sessions are impossible. See `tests/integration/concurrent-project-memory.test.ts` for the regression guard.

Two types of data are stored in project-memory:

- **Notes**: Learned facts about the project (architecture patterns, bug history, etc.)
- **Directives**: Instructions to follow when working on the project

### pre-compact

Preserves important state immediately before compaction.

- **Event**: PreCompact
- **Behavior**: Summarizes and preserves the current work state, in-progress TODOs, and critical context
- **Purpose**: Retains essential information so work can resume after compaction

### Context Preservation Strategy

OMC's context management hooks cooperate with the following strategy:

```
Session Start
  → Load project-memory
    → [Work in progress]
    → Write important info to notepad
    → Update project-memory
      → [Compaction fires]
      → pre-compact preserves state
      → project-memory preserved
        → [After compaction]
        → Restored via notepad / project-memory
```

---

## Magic Keywords

Magic keywords automatically activate OMC skills or execution modes when specific words or patterns are detected in the user's natural language prompt. No slash command is needed — include a keyword in your prompt and the feature activates automatically.

### How keyword-detector Works

`keyword-detector.mjs` runs on the UserPromptSubmit event.

1. Receives the user prompt and sanitizes it
2. Removes code blocks, XML tags, URLs, and file paths to prevent false positives
3. Matches keyword patterns against the sanitized text
4. Resolves conflicts, then injects the skill invocation instruction

**Safety measures:**

- **Sanitization**: Keywords inside code blocks, within URLs, or in file paths are ignored
- **Team worker protection**: Disabled when the `OMC_TEAM_WORKER` environment variable is set (prevents infinite spawning)
- **Disable**: Set `DISABLE_OMC=1` or `OMC_SKIP_HOOKS=keyword-detector`

### Execution Mode Keywords

These keywords invoke a skill and create a state file.

| Keyword | Skill | Description |
|---------|-------|-------------|
| `cancelomc`, `stopomc` | cancel | Cancels all active modes |
| `ralph`, `don't stop`, `must complete`, `until done` | ralph | Persistent execution until verification completes |
| `autopilot`, `build me`, `I want a`, `handle it all`, `end to end`, `auto-pilot`, `full auto`, `fullsend`, `e2e this` | autopilot | Fully autonomous execution |
| `ultrawork`, `ulw`, `uw` | ultrawork | Maximum parallel execution |
| `ccg`, `claude-codex-gemini` | ccg | Claude-Codex-Gemini tri-model orchestration (use `antigravity` workers when using the Antigravity CLI) |
| `ralplan` | ralplan | Consensus-based iterative planning |
| `deep interview`, `ouroboros` | deep-interview | Socratic deep interview |

### AI Slop Cleanup Keywords

Supports two pattern types:

**Explicit patterns** (activate on their own):

- `ai-slop`, `anti-slop`, `deslop`, `de-slop`

**Combination patterns** (activate when an action keyword is combined with a smell keyword):

| Action Keywords | Smell Keywords |
|----------------|----------------|
| `cleanup`, `refactor`, `simplify`, `dedupe`, `prune` | `slop`, `duplicate`, `dead code`, `unused code`, `over-abstraction`, `wrapper layers`, `needless abstractions`, `ai-generated`, `tech debt` |

Example: "cleanup the duplicate code" → activates the ai-slop-cleaner skill.

### Agent Shortcut Keywords

Activate agents with natural language instead of slash commands.

| Keyword | Effect | Behavior |
|---------|--------|----------|
| `tdd`, `test first`, `red green` | TDD mode | Enforces test-first writing |
| `code review`, `review code` | Code review mode | Runs comprehensive code review |
| `security review`, `review security` | Security review mode | Runs security-focused review |

These keywords inject an inline mode message rather than invoking a skill.

### Reasoning Enhancement Keywords

| Keyword | Effect |
|---------|--------|
| `ultrathink`, `think hard`, `think deeply` | Activates extended reasoning mode |
| `deepsearch`, `search the codebase`, `find in codebase` | Activates codebase-focused search mode |
| `deep-analyze`, `deepanalyze` | Activates deep analysis mode |

### Localized Triggers (Korean / Japanese)

`keyword-detector.mjs` also recognizes Korean and Japanese aliases for these keywords (e.g. `랄프` / `ラルフ` → ralph, `코드 리뷰` / `コード レビュー` → code-review, `딥 분석` / `ディープ アナライズ` → analyze). Because Korean and Japanese have no ASCII word boundary, these aliases match by substring, so a localized alias inside a longer noun phrase still routes (e.g. `コードレビュー記事を要約して` → code-review).

See [REFERENCE.md → Magic Keywords → Localized triggers](./REFERENCE.md#magic-keywords) for the full alias table and routing-behavior details (reviewer-suffix guard, informational suppression including `違いを教えて`/`何が違う` difference questions).

### Priority and Conflict Resolution

When multiple keywords are detected simultaneously, they resolve by the following priority:

```
cancel  (highest priority, exclusive)
  → ralph
    → autopilot
      → ultrawork
        → ccg
          → ralplan
            → deep-interview
              → ai-slop-cleaner
                → tdd
                  → code-review
                    → security-review
                      → ultrathink
                        → deepsearch
                          → analyze
```

`cancel` is exclusive — it ignores all other matches and only runs the cancel action. All other keywords can be matched together and are processed in priority order.

### Usage Examples

```bash
# In Claude Code:

# Autonomous execution
autopilot: implement user authentication with OAuth

# Parallel execution
ultrawork write all tests for this module

# Persistent execution
ralph refactor this authentication module

# TDD
implement password validation with tdd

# Code review
code review the recent changes

# Cancel
stopomc
```

### Note on the `team` Keyword

`team` is not auto-detected. It must be invoked explicitly via the `/team` slash command to prevent infinite spawning.

```
/oh-my-claudecode:team 3:executor "build a fullstack todo app"
```
