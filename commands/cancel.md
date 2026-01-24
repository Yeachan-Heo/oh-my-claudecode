---
description: Cancel any active OMC mode (autopilot, ralph, ultrawork, ecomode, ultraqa, swarm, ultrapilot, pipeline)
---

# Cancel Command

[UNIFIED CANCEL - INTELLIGENT MODE DETECTION]

You are cancelling the active OMC mode. The cancel skill will automatically detect which mode is running and clean it up properly.

## Auto-Detection

The skill checks state files to determine what's active and cancels in order of dependency:

1. **Autopilot** - Stops workflow, preserves progress for resume, cleans up ralph/ultraqa
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

- `.omc/autopilot-state.json` → Autopilot
- `.omc/ralph-state.json` → Ralph
- `.omc/ultrawork-state.json` → Ultrawork
- `.omc/ecomode-state.json` → Ecomode
- `.omc/ultraqa-state.json` → UltraQA
- `.omc/swarm-state.json` → Swarm
- `.omc/ultrapilot-state.json` → Ultrapilot
- `.omc/pipeline-state.json` → Pipeline

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
