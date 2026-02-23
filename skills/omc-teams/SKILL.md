---
name: omc-teams
description: Spawn claude, codex, or gemini CLI workers in tmux panes for parallel task execution
aliases: []
---

# OMC Teams Skill

Spawn N CLI worker processes in tmux panes to execute tasks in parallel. Supports `claude`, `codex`, and `gemini` agent types. Unlike `/team` (which uses Claude Code's native `TeamCreate`/`Task` tools), this skill uses the tmux runtime to launch actual CLI processes in visible tmux panes.

## Usage

```
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
/omc-teams 1:codex "write comprehensive tests for src/api/"
```

## Requirements

- **tmux** must be running (`$TMUX` set in the current shell)
- **claude** CLI: `npm install -g @anthropic-ai/claude-code` (for claude workers)
- **codex** CLI: `npm install -g @openai/codex` (for codex workers)
- **gemini** CLI: `npm install -g @google/gemini-cli` (for gemini workers)

## How It Works

1. Claude decomposes the task into N independent subtasks (one per worker)
2. Calls `mcp__team__omc_run_team_start` then `mcp__team__omc_run_team_wait`
3. The OMC MCP server spawns `runtime-cli.cjs` (co-located in the same install directory)
4. The runtime creates tmux split-panes and launches the CLI processes
5. Each worker reads its task from an inbox file and writes `done.json` on completion
6. The runtime collects results, shuts down workers, returns structured JSON
7. Claude parses the result and reports to the user

---

## Workflow

### Phase 1: Parse input

Extract from the user command:
- `N` — number of workers (integer, 1–10)
- `agent-type` — must be `claude`, `codex`, or `gemini`; reject anything else with an error
- `task` — the task description

### Phase 2: Decompose task

Break the task into exactly N subtasks. Each subtask must be:
- **Independent** — no conflicting writes between workers
- **Scoped** — operates on a distinct subset of files or concerns
- **Self-contained** — completable without inter-worker coordination

Choose a `teamName` slug from the task (e.g., `auth-security-review`).

### Phase 3: Start the team (non-blocking)

MCP tools block Claude Code while running, so we use a two-tool async pattern.
Call `mcp__team__omc_run_team_start` — it spawns workers in the background and returns a
`jobId` immediately. No Bash, no path resolution; the MCP server finds `runtime-cli.cjs`
from its own install directory automatically.

```
mcp__team__omc_run_team_start({
  "teamName": "{teamName}",
  "agentTypes": ["{agentType}", "{agentType}", ...],
  "tasks": [
    {"subject": "Subtask 1 title", "description": "Full description..."},
    {"subject": "Subtask 2 title", "description": "Full description..."}
  ],
  "cwd": "{cwd}",
  "timeoutSeconds": 300
})
```

Returns: `{ "jobId": "omc-...", "pid": 12345, "message": "Team started in background..." }`

### Phase 4: Wait for completion, then report

Call `mcp__team__omc_run_team_wait` — a single blocking call that polls internally
(500ms → 2000ms exponential backoff) and returns only when the job reaches a terminal
state. No repeated polling needed; one call instead of N.

```
mcp__team__omc_run_team_wait({
  "job_id": "{jobId}",
  "timeout_ms": 60000
})
```

> **Timeout guidance:** Use `60000` (60 s) as the default. If the job times out,
> **workers are left running** — the timeout does NOT kill them. You have two options:
> - Call `omc_run_team_wait` again with the same `job_id` to keep waiting (workers continue)
> - Call `omc_run_team_cleanup` to explicitly stop all worker panes when you want to cancel
>
> Teams can silently stall due to stuck workers or tmux session issues. Use
> `mcp__team__omc_run_team_status` to inspect live progress before deciding to cancel.

Returns when done:
```json
{
  "jobId": "omc-...",
  "status": "completed|failed|timeout",
  "elapsedSeconds": "95.3",
  "result": {
    "status": "completed",
    "teamName": "...",
    "taskResults": [
      {"taskId": "1", "status": "completed", "summary": "Done: added 12 tests"},
      {"taskId": "2", "status": "failed", "summary": "Worker exited early"}
    ],
    "duration": 95.1,
    "workerCount": 2
  }
}
```

> **Why no deadlock?** `omc_run_team_wait` uses `async/await` with `setTimeout`,
> which yields the Node.js event loop between polls. The `child.on('close', ...)`
> callback that updates job status fires during those yields. The background
> `runtime-cli.cjs` child process is completely independent — it never calls back
> into this MCP server.
>
> If you need non-blocking checks (e.g. to do other work while waiting), use
> `mcp__team__omc_run_team_status` instead.

Report results to the user. For `failed` or `timeout`, explain what happened and suggest next steps (reduce scope, check CLI installation, verify tmux is running).

Update OMC state:
```
state_write(mode="team", current_phase="completed", active=false)
```

---

## Error Reference

| Error | Cause | Fix |
|-------|-------|-----|
| `not inside tmux` | Shell not running inside a tmux session | Start tmux and rerun |
| `codex: command not found` | Codex CLI not installed | `npm install -g @openai/codex` |
| `gemini: command not found` | Gemini CLI not installed | `npm install -g @google/gemini-cli` |
| `status: timeout` | Workers exceeded 300s | Reduce task scope or raise `timeoutSeconds` in config |
| `status: failed` | All workers exited with work remaining | Check stderr for crash details |

---

## Relationship to `/team`

| Aspect | `/team` | `/omc-teams` |
|--------|---------|-------------|
| Worker type | Claude Code agents (`Task(subagent_type=...)`) | claude / codex / gemini CLI processes |
| Invocation | `TeamCreate` / `SendMessage` / `TeamDelete` | `mcp__team__omc_run_team_start` + `omc_run_team_wait` |
| Coordination | Native Claude Code team messaging | tmux panes + inbox files + `done.json` sentinels |
| Communication | Native Claude Code team messaging | File-based (inbox.md → done.json) |
| Use when | You want Claude agents with full tool access | You want CLI autonomy (codex/gemini) at scale |
