---
name: cancel
description: Cancel any active OMC mode (autopilot, ralph, ultrawork, ecomode, ultraqa, swarm, ultrapilot, pipeline)
---

# Cancel Skill

Intelligent cancellation that detects and cancels the active OMC mode.

## What It Does

Automatically detects which mode is active and cancels it:
- **Autopilot**: Stops workflow, preserves progress for resume
- **Ralph**: Stops persistence loop, clears linked ultrawork if applicable
- **Ultrawork**: Stops parallel execution (standalone or linked)
- **Ecomode**: Stops token-efficient parallel execution (standalone or linked to ralph)
- **UltraQA**: Stops QA cycling workflow
- **Swarm**: Stops coordinated agent swarm, releases claimed tasks
- **Ultrapilot**: Stops parallel autopilot workers
- **Pipeline**: Stops sequential agent pipeline

## Usage

```
/oh-my-claudecode:cancel
```

Or say: "stop", "cancel", "abort"

## Auto-Detection

The skill checks state files to determine what's active:
- `.omc/state/autopilot-state.json` → Autopilot detected
- `.omc/state/ralph-state.json` → Ralph detected
- `.omc/state/ultrawork-state.json` → Ultrawork detected
- `.omc/state/ecomode-state.json` → Ecomode detected
- `.omc/state/ultraqa-state.json` → UltraQA detected
- `.omc/state/swarm.db` → Swarm detected (SQLite database)
- `.omc/state/ultrapilot-state.json` → Ultrapilot detected
- `.omc/state/pipeline-state.json` → Pipeline detected
- `.omc/state/plan-consensus.json` → Plan Consensus detected
- `.omc/state/ralplan-state.json` → Plan Consensus detected (legacy)

If multiple modes are active, they're cancelled in order of dependency:
1. Autopilot (includes ralph/ultraqa/ecomode cleanup)
2. Ralph (includes linked ultrawork OR ecomode cleanup)
3. Ultrawork (standalone)
4. Ecomode (standalone)
5. UltraQA (standalone)
6. Swarm (standalone)
7. Ultrapilot (standalone)
8. Pipeline (standalone)
9. Plan Consensus (standalone)

## Force Clear All

To clear ALL state files regardless of what's active:

```
/oh-my-claudecode:cancel --force
```

Or use the `--all` alias:

```
/oh-my-claudecode:cancel --all
```

This removes all state files:
- `.omc/state/autopilot-state.json`
- `.omc/state/ralph-state.json`
- `.omc/state/ultrawork-state.json`
- `.omc/state/ecomode-state.json`
- `.omc/state/ultraqa-state.json`
- `.omc/state/swarm.db`
- `.omc/state/swarm.db-wal`
- `.omc/state/swarm.db-shm`
- `.omc/state/swarm-active.marker`
- `.omc/state/ultrapilot-state.json`
- `.omc/state/pipeline-state.json`
- `.omc/state/plan-consensus.json`
- `.omc/state/ralplan-state.json`
- `~/.claude/ralph-state.json`
- `~/.claude/ultrawork-state.json`
- `~/.claude/ecomode-state.json`

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

```bash
# Check which modes are active
AUTOPILOT_ACTIVE=false
RALPH_ACTIVE=false
ULTRAWORK_ACTIVE=false
ECOMODE_ACTIVE=false
ULTRAQA_ACTIVE=false

if [[ -f .omc/state/autopilot-state.json ]]; then
  AUTOPILOT_ACTIVE=$(cat .omc/state/autopilot-state.json | jq -r '.active // false')
fi

if [[ -f .omc/state/ralph-state.json ]]; then
  RALPH_ACTIVE=$(cat .omc/state/ralph-state.json | jq -r '.active // false')
fi

if [[ -f .omc/state/ultrawork-state.json ]]; then
  ULTRAWORK_ACTIVE=$(cat .omc/state/ultrawork-state.json | jq -r '.active // false')
fi

if [[ -f .omc/state/ecomode-state.json ]]; then
  ECOMODE_ACTIVE=$(cat .omc/state/ecomode-state.json | jq -r '.active // false')
fi

if [[ -f .omc/state/ultraqa-state.json ]]; then
  ULTRAQA_ACTIVE=$(cat .omc/state/ultraqa-state.json | jq -r '.active // false')
fi

PLAN_CONSENSUS_ACTIVE=false

# Check both new and legacy locations
if [[ -f .omc/state/plan-consensus.json ]]; then
  PLAN_CONSENSUS_ACTIVE=$(cat .omc/state/plan-consensus.json | jq -r '.active // false')
elif [[ -f .omc/state/ralplan-state.json ]]; then
  PLAN_CONSENSUS_ACTIVE=$(cat .omc/state/ralplan-state.json | jq -r '.active // false')
fi
```

### 3A. Force Mode (if --force or --all)

```bash
if [[ "$FORCE_MODE" == "true" ]]; then
  echo "FORCE CLEAR: Removing all OMC state files..."

  # Remove local state files
  rm -f .omc/state/autopilot-state.json
  rm -f .omc/state/ralph-state.json
  rm -f .omc/state/ultrawork-state.json
  rm -f .omc/state/ecomode-state.json
  rm -f .omc/state/ultraqa-state.json
  rm -f .omc/state/ralph-plan-state.json
  rm -f .omc/state/ralph-verification.json
  rm -f .omc/state/swarm.db
  rm -f .omc/state/swarm.db-wal
  rm -f .omc/state/swarm.db-shm
  rm -f .omc/state/swarm-active.marker
  rm -f .omc/state/ultrapilot-state.json
  rm -f .omc/state/pipeline-state.json
  rm -f .omc/state/plan-consensus.json
  rm -f .omc/state/ralplan-state.json

  # Remove global state files
  rm -f ~/.claude/ralph-state.json
  rm -f ~/.claude/ultrawork-state.json
  rm -f ~/.claude/ecomode-state.json

  echo "All OMC modes cleared. You are free to start fresh."
  exit 0
fi
```

### 3B. Smart Cancellation (default)

#### If Autopilot Active

Call `cancelAutopilot()` from `src/hooks/autopilot/cancel.ts:27-78`:

```bash
# Autopilot handles its own cleanup + ralph + ultraqa
# Just mark autopilot as inactive (preserves state for resume)
if [[ -f .omc/state/autopilot-state.json ]]; then
  # Clean up ralph if active
  if [[ -f .omc/state/ralph-state.json ]]; then
    RALPH_STATE=$(cat .omc/state/ralph-state.json)
    LINKED_UW=$(echo "$RALPH_STATE" | jq -r '.linked_ultrawork // false')

    # Clean linked ultrawork first
    if [[ "$LINKED_UW" == "true" ]] && [[ -f .omc/state/ultrawork-state.json ]]; then
      rm -f .omc/state/ultrawork-state.json
      rm -f ~/.claude/ultrawork-state.json
      echo "Cleaned up: ultrawork (linked to ralph)"
    fi

    # Clean ralph
    rm -f .omc/state/ralph-state.json
    rm -f ~/.claude/ralph-state.json
    rm -f .omc/state/ralph-verification.json
    echo "Cleaned up: ralph"
  fi

  # Clean up ultraqa if active
  if [[ -f .omc/state/ultraqa-state.json ]]; then
    rm -f .omc/state/ultraqa-state.json
    echo "Cleaned up: ultraqa"
  fi

  # Mark autopilot inactive but preserve state
  CURRENT_STATE=$(cat .omc/state/autopilot-state.json)
  CURRENT_PHASE=$(echo "$CURRENT_STATE" | jq -r '.phase // "unknown"')
  echo "$CURRENT_STATE" | jq '.active = false' > .omc/state/autopilot-state.json

  echo "Autopilot cancelled at phase: $CURRENT_PHASE. Progress preserved for resume."
  echo "Run /oh-my-claudecode:autopilot to resume."
fi
```

#### If Ralph Active (but not Autopilot)

Call `clearRalphState()` + `clearLinkedUltraworkState()` from `src/hooks/ralph-loop/index.ts:147-182`:

```bash
if [[ -f .omc/state/ralph-state.json ]]; then
  # Check if ultrawork is linked
  RALPH_STATE=$(cat .omc/state/ralph-state.json)
  LINKED_UW=$(echo "$RALPH_STATE" | jq -r '.linked_ultrawork // false')

  # Clean linked ultrawork first
  if [[ "$LINKED_UW" == "true" ]] && [[ -f .omc/state/ultrawork-state.json ]]; then
    UW_STATE=$(cat .omc/state/ultrawork-state.json)
    UW_LINKED=$(echo "$UW_STATE" | jq -r '.linked_to_ralph // false')

    # Only clear if it was linked to ralph
    if [[ "$UW_LINKED" == "true" ]]; then
      rm -f .omc/state/ultrawork-state.json
      rm -f ~/.claude/ultrawork-state.json
      echo "Cleaned up: ultrawork (linked to ralph)"
    fi
  fi

  # Clean ralph state (both local and global)
  rm -f .omc/state/ralph-state.json
  rm -f ~/.claude/ralph-state.json
  rm -f .omc/state/ralph-plan-state.json
  rm -f .omc/state/ralph-verification.json

  echo "Ralph cancelled. Persistent mode deactivated."
fi
```

#### If Ultrawork Active (standalone, not linked)

Call `deactivateUltrawork()` from `src/hooks/ultrawork/index.ts:150-173`:

```bash
if [[ -f .omc/state/ultrawork-state.json ]]; then
  # Check if linked to ralph
  UW_STATE=$(cat .omc/state/ultrawork-state.json)
  LINKED=$(echo "$UW_STATE" | jq -r '.linked_to_ralph // false')

  if [[ "$LINKED" == "true" ]]; then
    echo "Ultrawork is linked to Ralph. Use /oh-my-claudecode:cancel to cancel both."
    exit 1
  fi

  # Remove both local and global state
  rm -f .omc/state/ultrawork-state.json
  rm -f ~/.claude/ultrawork-state.json

  echo "Ultrawork cancelled. Parallel execution mode deactivated."
fi
```

#### If UltraQA Active (standalone)

Call `clearUltraQAState()` from `src/hooks/ultraqa/index.ts:107-120`:

```bash
if [[ -f .omc/state/ultraqa-state.json ]]; then
  rm -f .omc/state/ultraqa-state.json
  echo "UltraQA cancelled. QA cycling workflow stopped."
fi
```

#### No Active Modes

```bash
echo "No active OMC modes detected."
echo ""
echo "Checked for:"
echo "  - Autopilot (.omc/state/autopilot-state.json)"
echo "  - Ralph (.omc/state/ralph-state.json)"
echo "  - Ultrawork (.omc/state/ultrawork-state.json)"
echo "  - UltraQA (.omc/state/ultraqa-state.json)"
echo ""
echo "Use --force to clear all state files anyway."
```

## Complete Implementation

Here's the complete bash implementation you should run:

```bash
#!/bin/bash

# Parse arguments
FORCE_MODE=false
if [[ "$*" == *"--force"* ]] || [[ "$*" == *"--all"* ]]; then
  FORCE_MODE=true
fi

# Force mode: clear everything
if [[ "$FORCE_MODE" == "true" ]]; then
  echo "FORCE CLEAR: Removing all OMC state files..."

  mkdir -p .omc ~/.claude

  # Remove local state files
  rm -f .omc/state/autopilot-state.json
  rm -f .omc/state/ralph-state.json
  rm -f .omc/state/ultrawork-state.json
  rm -f .omc/state/ecomode-state.json
  rm -f .omc/state/ultraqa-state.json
  rm -f .omc/state/ralph-plan-state.json
  rm -f .omc/state/ralph-verification.json
  rm -f .omc/state/swarm.db
  rm -f .omc/state/swarm.db-wal
  rm -f .omc/state/swarm.db-shm
  rm -f .omc/state/swarm-active.marker
  rm -f .omc/state/ultrapilot-state.json
  rm -f .omc/state/pipeline-state.json
  rm -f .omc/state/plan-consensus.json
  rm -f .omc/state/ralplan-state.json

  # Remove global state files
  rm -f ~/.claude/ralph-state.json
  rm -f ~/.claude/ultrawork-state.json
  rm -f ~/.claude/ecomode-state.json

  echo ""
  echo "All OMC modes cleared. You are free to start fresh."
  exit 0
fi

# Track what we cancelled
CANCELLED_ANYTHING=false

# 1. Check Autopilot (highest priority, includes cleanup of ralph/ultraqa)
if [[ -f .omc/state/autopilot-state.json ]]; then
  AUTOPILOT_STATE=$(cat .omc/state/autopilot-state.json)
  AUTOPILOT_ACTIVE=$(echo "$AUTOPILOT_STATE" | jq -r '.active // false')

  if [[ "$AUTOPILOT_ACTIVE" == "true" ]]; then
    CURRENT_PHASE=$(echo "$AUTOPILOT_STATE" | jq -r '.phase // "unknown"')
    CLEANED_UP=()

    # Clean up ralph if active
    if [[ -f .omc/state/ralph-state.json ]]; then
      RALPH_STATE=$(cat .omc/state/ralph-state.json)
      RALPH_ACTIVE=$(echo "$RALPH_STATE" | jq -r '.active // false')

      if [[ "$RALPH_ACTIVE" == "true" ]]; then
        LINKED_UW=$(echo "$RALPH_STATE" | jq -r '.linked_ultrawork // false')

        # Clean linked ultrawork first
        if [[ "$LINKED_UW" == "true" ]] && [[ -f .omc/state/ultrawork-state.json ]]; then
          rm -f .omc/state/ultrawork-state.json
          rm -f ~/.claude/ultrawork-state.json
          CLEANED_UP+=("ultrawork")
        fi

        # Clean ralph
        rm -f .omc/state/ralph-state.json
        rm -f ~/.claude/ralph-state.json
        rm -f .omc/state/ralph-verification.json
        CLEANED_UP+=("ralph")
      fi
    fi

    # Clean up ultraqa if active
    if [[ -f .omc/state/ultraqa-state.json ]]; then
      ULTRAQA_STATE=$(cat .omc/state/ultraqa-state.json)
      ULTRAQA_ACTIVE=$(echo "$ULTRAQA_STATE" | jq -r '.active // false')

      if [[ "$ULTRAQA_ACTIVE" == "true" ]]; then
        rm -f .omc/state/ultraqa-state.json
        CLEANED_UP+=("ultraqa")
      fi
    fi

    # Mark autopilot inactive but preserve state for resume
    echo "$AUTOPILOT_STATE" | jq '.active = false' > .omc/state/autopilot-state.json

    echo "Autopilot cancelled at phase: $CURRENT_PHASE."

    if [[ ${#CLEANED_UP[@]} -gt 0 ]]; then
      echo "Cleaned up: ${CLEANED_UP[*]}"
    fi

    echo "Progress preserved for resume. Run /oh-my-claudecode:autopilot to continue."
    CANCELLED_ANYTHING=true
    exit 0
  fi
fi

# 2. Check Ralph (if not handled by autopilot)
if [[ -f .omc/state/ralph-state.json ]]; then
  RALPH_STATE=$(cat .omc/state/ralph-state.json)
  RALPH_ACTIVE=$(echo "$RALPH_STATE" | jq -r '.active // false')

  if [[ "$RALPH_ACTIVE" == "true" ]]; then
    LINKED_UW=$(echo "$RALPH_STATE" | jq -r '.linked_ultrawork // false')

    # Clean linked ultrawork first
    if [[ "$LINKED_UW" == "true" ]] && [[ -f .omc/state/ultrawork-state.json ]]; then
      UW_STATE=$(cat .omc/state/ultrawork-state.json)
      UW_LINKED=$(echo "$UW_STATE" | jq -r '.linked_to_ralph // false')

      # Only clear if it was linked to ralph
      if [[ "$UW_LINKED" == "true" ]]; then
        rm -f .omc/state/ultrawork-state.json
        rm -f ~/.claude/ultrawork-state.json
        echo "Cleaned up: ultrawork (linked to ralph)"
      fi
    fi

    # Clean linked ecomode if present
    LINKED_ECO=$(echo "$RALPH_STATE" | jq -r '.linked_ecomode // false')

    if [[ "$LINKED_ECO" == "true" ]] && [[ -f .omc/state/ecomode-state.json ]]; then
      ECO_STATE=$(cat .omc/state/ecomode-state.json)
      ECO_LINKED=$(echo "$ECO_STATE" | jq -r '.linked_to_ralph // false')

      if [[ "$ECO_LINKED" == "true" ]]; then
        rm -f .omc/state/ecomode-state.json
        rm -f ~/.claude/ecomode-state.json
        echo "Cleaned up: ecomode (linked to ralph)"
      fi
    fi

    # Clean ralph state (both local and global)
    rm -f .omc/state/ralph-state.json
    rm -f ~/.claude/ralph-state.json
    rm -f .omc/state/ralph-plan-state.json
    rm -f .omc/state/ralph-verification.json

    echo "Ralph cancelled. Persistent mode deactivated."
    CANCELLED_ANYTHING=true
    exit 0
  fi
fi

# 3. Check Ultrawork (standalone, not linked)
if [[ -f .omc/state/ultrawork-state.json ]]; then
  UW_STATE=$(cat .omc/state/ultrawork-state.json)
  UW_ACTIVE=$(echo "$UW_STATE" | jq -r '.active // false')

  if [[ "$UW_ACTIVE" == "true" ]]; then
    LINKED=$(echo "$UW_STATE" | jq -r '.linked_to_ralph // false')

    if [[ "$LINKED" == "true" ]]; then
      echo "Warning: Ultrawork is linked to Ralph, but Ralph is not active."
      echo "Clearing ultrawork state anyway..."
    fi

    # Remove both local and global state
    rm -f .omc/state/ultrawork-state.json
    rm -f ~/.claude/ultrawork-state.json

    echo "Ultrawork cancelled. Parallel execution mode deactivated."
    CANCELLED_ANYTHING=true
    exit 0
  fi
fi

# 4. Check Ecomode (standalone, not linked)
if [[ -f .omc/state/ecomode-state.json ]]; then
  ECO_STATE=$(cat .omc/state/ecomode-state.json)
  ECO_ACTIVE=$(echo "$ECO_STATE" | jq -r '.active // false')

  if [[ "$ECO_ACTIVE" == "true" ]]; then
    LINKED=$(echo "$ECO_STATE" | jq -r '.linked_to_ralph // false')

    if [[ "$LINKED" == "true" ]]; then
      echo "Warning: Ecomode is linked to Ralph, but Ralph is not active."
      echo "Clearing ecomode state anyway..."
    fi

    # Remove both local and global state
    rm -f .omc/state/ecomode-state.json
    rm -f ~/.claude/ecomode-state.json

    echo "Ecomode cancelled. Token-efficient execution mode deactivated."
    CANCELLED_ANYTHING=true
    exit 0
  fi
fi

# 5. Check UltraQA (standalone)
if [[ -f .omc/state/ultraqa-state.json ]]; then
  ULTRAQA_STATE=$(cat .omc/state/ultraqa-state.json)
  ULTRAQA_ACTIVE=$(echo "$ULTRAQA_STATE" | jq -r '.active // false')

  if [[ "$ULTRAQA_ACTIVE" == "true" ]]; then
    rm -f .omc/state/ultraqa-state.json
    echo "UltraQA cancelled. QA cycling workflow stopped."
    CANCELLED_ANYTHING=true
    exit 0
  fi
fi

# 6. Check Swarm (SQLite-based)
SWARM_DB=".omc/state/swarm.db"
if [[ -f "$SWARM_DB" ]]; then
  # Check if sqlite3 CLI is available
  if command -v sqlite3 &>/dev/null; then
    # Query SQLite to check if swarm is active
    SWARM_ACTIVE=$(sqlite3 "$SWARM_DB" "SELECT active FROM swarm_session WHERE id = 1;" 2>/dev/null || echo "0")

    if [[ "$SWARM_ACTIVE" == "1" ]]; then
      # Get stats before cancelling
      DONE_TASKS=$(sqlite3 "$SWARM_DB" "SELECT COUNT(*) FROM tasks WHERE status = 'done';" 2>/dev/null || echo "0")
      TOTAL_TASKS=$(sqlite3 "$SWARM_DB" "SELECT COUNT(*) FROM tasks;" 2>/dev/null || echo "0")

      # Mark swarm as inactive
      sqlite3 "$SWARM_DB" "UPDATE swarm_session SET active = 0, completed_at = $(date +%s000) WHERE id = 1;"

      echo "Swarm cancelled. $DONE_TASKS/$TOTAL_TASKS tasks completed."
      echo "Database preserved at $SWARM_DB for analysis."
      CANCELLED_ANYTHING=true
      exit 0
    fi
  else
    # Fallback: Check marker file if sqlite3 is not available
    MARKER_FILE=".omc/state/swarm-active.marker"
    if [[ -f "$MARKER_FILE" ]]; then
      rm -f "$MARKER_FILE"
      echo "Swarm cancelled (marker file removed). Database at $SWARM_DB may need manual cleanup."
      CANCELLED_ANYTHING=true
      exit 0
    fi
  fi
fi

# 7. Check Ultrapilot (standalone)
if [[ -f .omc/state/ultrapilot-state.json ]]; then
  ULTRAPILOT_STATE=$(cat .omc/state/ultrapilot-state.json)
  ULTRAPILOT_ACTIVE=$(echo "$ULTRAPILOT_STATE" | jq -r '.active // false')

  if [[ "$ULTRAPILOT_ACTIVE" == "true" ]]; then
    rm -f .omc/state/ultrapilot-state.json
    echo "Ultrapilot cancelled. Parallel autopilot workers stopped."
    CANCELLED_ANYTHING=true
    exit 0
  fi
fi

# 8. Check Pipeline (standalone)
if [[ -f .omc/state/pipeline-state.json ]]; then
  PIPELINE_STATE=$(cat .omc/state/pipeline-state.json)
  PIPELINE_ACTIVE=$(echo "$PIPELINE_STATE" | jq -r '.active // false')

  if [[ "$PIPELINE_ACTIVE" == "true" ]]; then
    rm -f .omc/state/pipeline-state.json
    echo "Pipeline cancelled. Sequential agent chain stopped."
    CANCELLED_ANYTHING=true
    exit 0
  fi
fi

# 9. Check Plan Consensus (standalone)
if [[ "$PLAN_CONSENSUS_ACTIVE" == "true" ]]; then
  echo "Cancelling Plan Consensus mode..."

  # Clear state files
  rm -f .omc/state/plan-consensus.json
  rm -f .omc/state/ralplan-state.json

  echo "Plan Consensus cancelled. Planning session ended."
  echo "Note: Plan file preserved at path specified in state."
  CANCELLED_ANYTHING=true
  exit 0
fi

# No active modes found
if [[ "$CANCELLED_ANYTHING" == "false" ]]; then
  echo "No active OMC modes detected."
  echo ""
  echo "Checked for:"
  echo "  - Autopilot (.omc/state/autopilot-state.json)"
  echo "  - Ralph (.omc/state/ralph-state.json)"
  echo "  - Ultrawork (.omc/state/ultrawork-state.json)"
  echo "  - Ecomode (.omc/state/ecomode-state.json)"
  echo "  - UltraQA (.omc/state/ultraqa-state.json)"
  echo "  - Swarm (.omc/state/swarm.db)"
  echo "  - Ultrapilot (.omc/state/ultrapilot-state.json)"
  echo "  - Pipeline (.omc/state/pipeline-state.json)"
  echo "  - Plan Consensus (.omc/state/plan-consensus.json)"
  echo ""
  echo "Use --force to clear all state files anyway."
fi
```

## Messages Reference

| Mode | Success Message |
|------|-----------------|
| Autopilot | "Autopilot cancelled at phase: {phase}. Progress preserved for resume." |
| Ralph | "Ralph cancelled. Persistent mode deactivated." |
| Ultrawork | "Ultrawork cancelled. Parallel execution mode deactivated." |
| Ecomode | "Ecomode cancelled. Token-efficient execution mode deactivated." |
| UltraQA | "UltraQA cancelled. QA cycling workflow stopped." |
| Swarm | "Swarm cancelled. Coordinated agents stopped." |
| Ultrapilot | "Ultrapilot cancelled. Parallel autopilot workers stopped." |
| Pipeline | "Pipeline cancelled. Sequential agent chain stopped." |
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
- **Link-aware**: Ralph cancellation cleans up linked Ultrawork or Ecomode
- **Safe**: Only clears linked Ultrawork, preserves standalone Ultrawork
- **Dual-location**: Clears both `.omc/` and `~/.claude/` state files
- **Resume-friendly**: Autopilot state is preserved for seamless resume
