---
name: cancel
description: Cancel any active OMC mode (autopilot, ralph, ultrawork, ultraqa, swarm, ultrapilot, pipeline, team)
---

# Cancel Skill

Intelligent cancellation that detects and cancels the active OMC mode.

**The cancel skill is the standard way to complete and exit any OMC mode.**
When the stop hook detects work is complete, it instructs the LLM to invoke
this skill for proper state cleanup. If cancel fails or is interrupted,
retry with `--force` flag, or wait for the 2-hour staleness timeout as
a last resort.

## What It Does

Automatically detects which mode is active and cancels it:
- **Autopilot**: Stops workflow, preserves progress for resume
- **Ralph**: Stops persistence loop, clears linked ultrawork if applicable
- **Ultrawork**: Stops parallel execution (standalone or linked)
- **UltraQA**: Stops QA cycling workflow
- **Swarm**: Stops coordinated agent swarm, releases claimed tasks
- **Ultrapilot**: Stops parallel autopilot workers
- **Pipeline**: Stops sequential agent pipeline
- **Team**: Sends shutdown_request to all teammates, waits for responses, calls TeamDelete, clears linked ralph if present
- **Team+Ralph (linked)**: Cancels team first (graceful shutdown), then clears ralph state. Cancelling ralph when linked also cancels team first.

## Usage

```
/oh-my-claudecode:cancel
```

Or say: "cancelomc", "stopomc"

## Auto-Detection

`/oh-my-claudecode:cancel` follows the session-aware state contract:
- By default the command inspects the current session via `state_list_active` and `state_get_status`, navigating `.omc/state/sessions/{sessionId}/…` to discover which mode is active.
- When a session id is provided or already known, that session-scoped path is authoritative. Legacy files in `.omc/state/*.json` are consulted only as a compatibility fallback if the session id is missing or empty.
- Swarm is a shared SQLite/marker mode (`.omc/state/swarm.db` / `.omc/state/swarm-active.marker`) and is not session-scoped.
- The default cleanup flow calls `state_clear` with the session id to remove only the matching session files; modes stay bound to their originating session.

Active modes are still cancelled in dependency order:
1. Autopilot (includes linked ralph/ultraqa/ cleanup)
2. Ralph (cleans its linked ultrawork or )
3. Ultrawork (standalone)
4. UltraQA (standalone)
5. Swarm (standalone)
6. Ultrapilot (standalone)
7. Pipeline (standalone)
8. Team (Claude Code native)
9. Plan Consensus (standalone)

## Force Clear All

Use `--force` or `--all` when you need to erase every session plus legacy artifacts, e.g., to reset the workspace entirely.

```
/oh-my-claudecode:cancel --force
```

```
/oh-my-claudecode:cancel --all
```

Steps under the hood:
1. `state_list_active` enumerates `.omc/state/sessions/{sessionId}/…` to find every known session.
2. `state_clear` runs once per session to drop that session’s files.
3. A global `state_clear` without `session_id` removes legacy files under `.omc/state/*.json`, `.omc/state/swarm*.db`, and compatibility artifacts (see list).
4. Team artifacts (`~/.claude/teams/*/`, `~/.claude/tasks/*/`, `.omc/state/team-state.json`) are best-effort cleared as part of the legacy fallback.

Every `state_clear` command honors the `session_id` argument, so even force mode still uses the session-aware paths first before deleting legacy files.

Legacy compatibility list (removed only under `--force`/`--all`):
- `.omc/state/autopilot-state.json`
- `.omc/state/ralph-state.json`
- `.omc/state/ralph-plan-state.json`
- `.omc/state/ralph-verification.json`
- `.omc/state/ultrawork-state.json`
- `.omc/state/ultraqa-state.json`
- `.omc/state/swarm.db`
- `.omc/state/swarm.db-wal`
- `.omc/state/swarm.db-shm`
- `.omc/state/swarm-active.marker`
- `.omc/state/swarm-tasks.db`
- `.omc/state/ultrapilot-state.json`
- `.omc/state/ultrapilot-ownership.json`
- `.omc/state/pipeline-state.json`
- `.omc/state/plan-consensus.json`
- `.omc/state/ralplan-state.json`
- `.omc/state/boulder.json`
- `.omc/state/hud-state.json`
- `.omc/state/subagent-tracking.json`
- `.omc/state/subagent-tracker.lock`
- `.omc/state/rate-limit-daemon.pid`
- `.omc/state/rate-limit-daemon.log`
- `.omc/state/checkpoints/` (directory)
- `.omc/state/sessions/` (empty directory cleanup after clearing sessions)

## Implementation Steps

When you invoke this skill:

### 1. Parse Arguments

```bash
# Check for --force or --all flags
FORCE_MODE=false
if [[ "$*" == *"--force"* ]] || [[ "$*" == *"--all"* ]]; then
  FORCE_MODE=true
fi
```

### 2. Detect Active Modes

The skill now relies on the session-aware state contract rather than hard-coded file paths:
1. Call `state_list_active` to enumerate `.omc/state/sessions/{sessionId}/…` and discover every active session.
2. For each session id, call `state_get_status` to learn which mode is running (`autopilot`, `ralph`, `ultrawork`, etc.) and whether dependent modes exist.
3. If a `session_id` was supplied to `/oh-my-claudecode:cancel`, skip legacy fallback entirely and operate solely within that session path; otherwise, consult legacy files in `.omc/state/*.json` only if the state tools report no active session. Swarm remains a shared SQLite/marker mode outside session scoping.
4. Any cancellation logic in this doc mirrors the dependency order discovered via state tools (autopilot → ralph → …).

### 3A. Force Mode (if --force or --all)

Use force mode to clear every session plus legacy artifacts via `state_clear`. Direct file removal is reserved for legacy cleanup when the state tools report no active sessions.

### 3B. Smart Cancellation (default)

#### If Team Active (Claude Code native)

Teams are detected by checking for config files in `~/.claude/teams/`:

```bash
# Check for active teams
TEAM_CONFIGS=$(find ~/.claude/teams -name config.json -maxdepth 2 2>/dev/null)
```

**Two-pass cancellation protocol:**

**Pass 1: Graceful Shutdown**
```
For each team found in ~/.claude/teams/:
  1. Read config.json to get team_name and members list
  2. For each non-lead member:
     a. Send shutdown_request via SendMessage
     b. Wait up to 15 seconds for shutdown_response
     c. If response received: member terminates and is auto-removed
     d. If timeout: mark member as unresponsive, continue to next
  3. Log: "Graceful pass: X/Y members responded"
```

**Pass 2: Reconciliation**
```
After graceful pass:
  1. Re-read config.json to check remaining members
  2. If only lead remains (or config is empty): proceed to TeamDelete
  3. If unresponsive members remain:
     a. Wait 5 more seconds (they may still be processing)
     b. Re-read config.json again
     c. If still stuck: attempt TeamDelete anyway
     d. If TeamDelete fails: report manual cleanup path
```

**TeamDelete + Cleanup:**
```
  1. Call TeamDelete() — removes ~/.claude/teams/{name}/ and ~/.claude/tasks/{name}/
  2. Clear team state: state_clear(mode="team")
  3. Check for linked ralph: state_read(mode="ralph") — if linked_team is true:
     a. Clear ralph state: state_clear(mode="ralph")
     b. Clear linked ultrawork if present: state_clear(mode="ultrawork")
  4. Run orphan scan (see below)
  5. Emit structured cancel report
```

**Orphan Detection (Post-Cleanup):**

After TeamDelete, verify no agent processes remain:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-orphans.mjs" --team-name "{team_name}"
```

The orphan scanner:
1. Checks `ps aux` (Unix) or `tasklist` (Windows) for processes with `--team-name` matching the deleted team
2. For each orphan whose team config no longer exists: sends SIGTERM, waits 5s, sends SIGKILL if still alive
3. Reports cleanup results as JSON

Use `--dry-run` to inspect without killing. The scanner is safe to run multiple times.

**Structured Cancel Report:**
```
Team "{team_name}" cancelled:
  - Members signaled: N
  - Responses received: M
  - Unresponsive: K (list names if any)
  - TeamDelete: success/failed
  - Manual cleanup needed: yes/no
    Path: ~/.claude/teams/{name}/ and ~/.claude/tasks/{name}/
```

**Implementation note:** The cancel skill is executed by the LLM, not as a bash script. When you detect an active team:
1. Read `~/.claude/teams/*/config.json` to find active teams
2. If multiple teams exist, cancel oldest first (by `createdAt`)
3. For each non-lead member, call `SendMessage(type: "shutdown_request", recipient: member-name, content: "Cancelling")`
4. Wait briefly for shutdown responses (15s per member timeout)
5. Re-read config.json to check for remaining members (reconciliation pass)
6. Call `TeamDelete()` to clean up
7. Clear team state: `state_clear(mode="team", session_id)`
8. Report structured summary to user

#### If Autopilot Active

Autopilot handles its own cleanup including linked ralph and ultraqa.

1. Read autopilot state via `state_read(mode="autopilot", session_id)` to get current phase
2. Check for linked ralph via `state_read(mode="ralph", session_id)`:
   - If ralph is active and has `linked_ultrawork: true`, clear ultrawork first: `state_clear(mode="ultrawork", session_id)`
   - Clear ralph: `state_clear(mode="ralph", session_id)`
3. Check for linked ultraqa via `state_read(mode="ultraqa", session_id)`:
   - If active, clear it: `state_clear(mode="ultraqa", session_id)`
4. Mark autopilot inactive (preserve state for resume) via `state_write(mode="autopilot", session_id, state={active: false, ...existing})`

#### If Ralph Active (but not Autopilot)

1. Read ralph state via `state_read(mode="ralph", session_id)` to check for linked ultrawork
2. If `linked_ultrawork: true`:
   - Read ultrawork state to verify `linked_to_ralph: true`
   - If linked, clear ultrawork: `state_clear(mode="ultrawork", session_id)`
3. Clear ralph: `state_clear(mode="ralph", session_id)`

#### If Ultrawork Active (standalone, not linked)

1. Read ultrawork state via `state_read(mode="ultrawork", session_id)`
2. If `linked_to_ralph: true`, warn user to cancel ralph instead (which cascades)
3. Otherwise clear: `state_clear(mode="ultrawork", session_id)`

#### If UltraQA Active (standalone)

Clear directly: `state_clear(mode="ultraqa", session_id)`

#### No Active Modes

Report: "No active OMC modes detected. Use --force to clear all state files anyway."

## Implementation Notes

The cancel skill runs as follows:
1. Parse the `--force` / `--all` flags, tracking whether cleanup should span every session or stay scoped to the current session id.
2. Use `state_list_active` to enumerate known session ids and `state_get_status` to learn the active mode (`autopilot`, `ralph`, `ultrawork`, etc.) for each session.
3. When operating in default mode, call `state_clear` with that session_id to remove only the session’s files, then run mode-specific cleanup (autopilot → ralph → …) based on the state tool signals.
4. In force mode, iterate every active session, call `state_clear` per session, then run a global `state_clear` without `session_id` to drop legacy files (`.omc/state/*.json`, compatibility artifacts) and report success. Swarm remains a shared SQLite/marker mode outside session scoping.
5. Team artifacts (`~/.claude/teams/*/`, `~/.claude/tasks/*/`, `.omc/state/team-state.json`) remain best-effort cleanup items invoked during the legacy/global pass.

State tools always honor the `session_id` argument, so even force mode still clears the session-scoped paths before deleting compatibility-only legacy state.

Mode-specific subsections below describe what extra cleanup each handler performs after the state-wide operations finish.
## Messages Reference

| Mode | Success Message |
|------|-----------------|
| Autopilot | "Autopilot cancelled at phase: {phase}. Progress preserved for resume." |
| Ralph | "Ralph cancelled. Persistent mode deactivated." |
| Ultrawork | "Ultrawork cancelled. Parallel execution mode deactivated." |
| UltraQA | "UltraQA cancelled. QA cycling workflow stopped." |
| Swarm | "Swarm cancelled. Coordinated agents stopped." |
| Ultrapilot | "Ultrapilot cancelled. Parallel autopilot workers stopped." |
| Pipeline | "Pipeline cancelled. Sequential agent chain stopped." |
| Team | "Team cancelled. Teammates shut down and cleaned up." |
| Plan Consensus | "Plan Consensus cancelled. Planning session ended." |
| Force | "All OMC modes cleared. You are free to start fresh." |
| None | "No active OMC modes detected." |

## What Gets Preserved

| Mode | State Preserved | Resume Command |
|------|-----------------|----------------|
| Autopilot | Yes (phase, files, spec, plan, verdicts) | `/oh-my-claudecode:autopilot` |
| Ralph | No | N/A |
| Ultrawork | No | N/A |
| UltraQA | No | N/A |
| Swarm | No | N/A |
| Ultrapilot | No | N/A |
| Pipeline | No | N/A |
| Plan Consensus | Yes (plan file path preserved) | N/A |

## Notes

- **Dependency-aware**: Autopilot cancellation cleans up Ralph and UltraQA
- **Link-aware**: Ralph cancellation cleans up linked Ultrawork
- **Safe**: Only clears linked Ultrawork, preserves standalone Ultrawork
- **Local-only**: Clears state files in `.omc/state/` directory
- **Resume-friendly**: Autopilot state is preserved for seamless resume
- **Team-aware**: Detects native Claude Code teams and performs graceful shutdown

## MCP Worker Cleanup

When cancelling modes that may have spawned MCP workers (team bridge daemons), the cancel skill should also:

1. **Check for active MCP workers**: Look for heartbeat files at `.omc/state/team-bridge/{team}/*.heartbeat.json`
2. **Send shutdown signals**: Write shutdown signal files for each active worker
3. **Kill tmux sessions**: Run `tmux kill-session -t omc-team-{team}-{worker}` for each worker
4. **Clean up heartbeat files**: Remove all heartbeat files for the team
5. **Clean up shadow registry**: Remove `.omc/state/team-mcp-workers.json`

### Force Clear Addition

When `--force` is used, also clean up:
```bash
rm -rf .omc/state/team-bridge/       # Heartbeat files
rm -f .omc/state/team-mcp-workers.json  # Shadow registry
# Kill all omc-team-* tmux sessions
tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^omc-team-' | while read s; do tmux kill-session -t "$s" 2>/dev/null; done
```
