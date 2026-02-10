---
description: Cancel any active OMC mode (autopilot, ralph, ultrawork, ecomode, ultraqa, swarm, ultrapilot, pipeline)
---

# Cancel Command

[UNIFIED CANCEL - INTELLIGENT MODE DETECTION]

You are cancelling the active OMC mode. The cancel skill will automatically detect which mode is running and clean it up properly.

## Auto-Detection

Cancel follows the Phase 2 session-aware state contract:
- `/oh-my-claudecode:cancel` inspects the current session via `state_list_active` and `state_get_status`, so it knows which mode files live under `.omc/state/sessions/{sessionId}/…` before falling back to legacy paths.
- When a session id is supplied or already known, those session-scoped files are authoritative; legacy `.omc/state/*.json` artifacts are only used when the session id is missing or empty.
- Swarm is a shared SQLite/marker mode (`.omc/state/swarm.db` / `.omc/state/swarm-active.marker`) and does not have per-session state isolation.
- `state_clear` called without `--force`/`--all` keeps cleanup scoped to that session, ensuring modes are cancelled where they run.

It still cancels active modes in dependency order:
1. **Autopilot** - Stops workflow, preserves progress for resume, cleans up ralph/ultraqa/ecomode
2. **Ralph** - Stops persistence loop, cleans up linked ultrawork or ecomode
3. **Ultrawork** - Stops parallel execution (standalone)
4. **Ecomode** - Stops token-efficient execution (standalone)
5. **UltraQA** - Stops QA cycling workflow
6. **Swarm** - Stops coordinated agents, releases claimed tasks
7. **Ultrapilot** - Stops parallel autopilot workers
8. **Pipeline** - Stops sequential agent chain

## Usage

Basic cancellation (auto-detects mode):
```
/oh-my-claudecode:cancel
```

Force clear ALL state files:
```
/oh-my-claudecode:cancel --force
/oh-my-claudecode:cancel --all
```

## User Arguments

{{ARGUMENTS}}

## State Files Checked

- **Session-aware state:** `.omc/state/sessions/{sessionId}/…` (discovered via `state_list_active` / `state_get_status`). When a session id is known, those files are authoritative and `state_clear` removes only that session’s artifacts.
- **Legacy compatibility (fallback when session id is missing or in `--force`/`--all` mode):**
  - `.omc/state/autopilot-state.json` → Autopilot
  - `.omc/state/ralph-state.json` → Ralph
  - `.omc/state/ultrawork-state.json` → Ultrawork
  - `.omc/state/ecomode-state.json` → Ecomode
  - `.omc/state/ultraqa-state.json` → UltraQA
  - `.omc/state/swarm.db` (SQLite) or `.omc/state/swarm-active.marker` → Swarm
  - `.omc/state/ultrapilot-state.json` → Ultrapilot
  - `.omc/state/pipeline-state.json` → Pipeline
  - `.omc/state/plan-consensus.json` / `.omc/state/ralplan-state.json` → Plan Consensus

## What Gets Preserved

| Mode | Progress Preserved | Resume |
|------|-------------------|--------|
| Autopilot | Yes (phase, spec, plan) | `/oh-my-claudecode:autopilot` |
| All Others | No | N/A |

## Dependency-Aware Cleanup

- **Autopilot cancellation** → Cleans ralph + ultraqa if active
- **Ralph cancellation** → Cleans linked ultrawork OR ecomode if applicable
- **Force mode** → Clears ALL state files regardless of what's active

## Exit Messages

The skill will report:
- Which mode was cancelled
- What phase/iteration it was in (if applicable)
- What dependent modes were cleaned up
- How to resume (if applicable)

## Implementation

Run the cancel skill which contains the full bash implementation for intelligent mode detection and cleanup.
