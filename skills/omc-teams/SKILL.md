---
name: omc-teams
description: Spawn claude, codex, or gemini CLI workers in tmux panes for parallel task execution
aliases: []
---

# OMC Teams Skill

Spawn N CLI worker processes in tmux panes to execute tasks in parallel. Supports `claude`, `codex`, and `gemini` agent types.

`/omc-teams` is a legacy compatibility skill for the CLI-first runtime: use `omc team ...` commands (not deprecated MCP runtime tools).

## Usage

```bash
/oh-my-claudecode:omc-teams N:claude "task description"
/oh-my-claudecode:omc-teams N:codex "task description"
/oh-my-claudecode:omc-teams N:gemini "task description"
```

### Parameters

- **N** - Number of CLI workers (1-10)
- **agent-type** - `claude` (Claude CLI), `codex` (OpenAI Codex CLI), or `gemini` (Google Gemini CLI)
- **task** - Task description to distribute across all workers

### Examples

```bash
/omc-teams 2:claude "implement auth module with tests"
/omc-teams 2:codex "review the auth module for security issues"
/omc-teams 3:gemini "redesign UI components for accessibility"
```

## Requirements

- **tmux** must be running (`$TMUX` set in the current shell)
- **claude** CLI: `npm install -g @anthropic-ai/claude-code`
- **codex** CLI: `npm install -g @openai/codex`
- **gemini** CLI: `npm install -g @google/gemini-cli`

## Workflow

### Phase 1: Parse input

Extract:

- `N` — worker count (1–10)
- `agent-type` — `claude|codex|gemini`
- `task` — task description

### Phase 2: Decompose task

Break work into N independent subtasks (file- or concern-scoped) to avoid write conflicts.

### Phase 3: Start CLI team runtime

Activate mode state (recommended):

```text
state_write(mode="team", current_phase="team-exec", active=true)
```

Start workers via CLI:

```bash
omc team <N>:<claude|codex|gemini> "<task>"
```

Team name defaults to a slug from the task text (example: `review-auth-flow`).

### Phase 4: Monitor + lifecycle API

```bash
omc team status <team-name>
omc team api list-tasks --input '{"team_name":"<team-name>"}' --json
```

Use `omc team api ...` for task claiming, task transitions, mailbox delivery, and worker state updates.

### Phase 5: Shutdown (only when needed)

```bash
omc team shutdown <team-name>
omc team shutdown <team-name> --force
```

Use shutdown for intentional cancellation or stale-state cleanup. Prefer non-force shutdown first.

### Phase 6: Report + state close

Report task results with completion/failure summary and any remaining risks.

```text
state_write(mode="team", current_phase="complete", active=false)
```

## Deprecated Runtime Note

Legacy MCP runtime tools are deprecated for execution:

- `omc_run_team_start`
- `omc_run_team_status`
- `omc_run_team_wait`
- `omc_run_team_cleanup`

If encountered, switch to `omc team ...` CLI commands.

## Error Reference

| Error                        | Cause                               | Fix                                                                                 |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `not inside tmux`            | Shell not running inside tmux       | Start tmux and rerun                                                                |
| `codex: command not found`   | Codex CLI not installed             | `npm install -g @openai/codex`                                                      |
| `gemini: command not found`  | Gemini CLI not installed            | `npm install -g @google/gemini-cli`                                                 |
| `Team <name> is not running` | stale or missing runtime state      | `omc team status <team-name>` then `omc team shutdown <team-name> --force` if stale |
| `status: failed`             | Workers exited with incomplete work | inspect runtime output, narrow scope, rerun                                         |

## Relationship to `/team`

| Aspect       | `/team`                                   | `/omc-teams`                                         |
| ------------ | ----------------------------------------- | ---------------------------------------------------- |
| Worker type  | Claude Code native team agents            | claude / codex / gemini CLI processes in tmux        |
| Invocation   | `TeamCreate` / `Task` / `SendMessage`     | `omc team [N:agent]` + `status` + `shutdown` + `api` |
| Coordination | Native team messaging and staged pipeline | tmux worker runtime + CLI API state files            |
| Use when     | You want Claude-native team orchestration | You want external CLI worker execution               |
