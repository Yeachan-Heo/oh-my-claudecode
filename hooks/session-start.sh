#!/bin/bash
# Sisyphus Session Start Hook
# Restores persistent mode states and injects context when session starts

# Read stdin
INPUT=$(cat)

# Get directory
DIRECTORY=""
if command -v jq &> /dev/null; then
  DIRECTORY=$(echo "$INPUT" | jq -r '.directory // ""' 2>/dev/null)
fi

if [ -z "$DIRECTORY" ]; then
  DIRECTORY=$(pwd)
fi

MESSAGES=""

# Check for active ultrawork state
if [ -f "$DIRECTORY/.omc/state/ultrawork-state.json" ] || [ -f "$HOME/.omc/state/ultrawork-state.json" ]; then
  if [ -f "$DIRECTORY/.omc/state/ultrawork-state.json" ]; then
    ULTRAWORK_STATE=$(cat "$DIRECTORY/.omc/state/ultrawork-state.json" 2>/dev/null)
  else
    ULTRAWORK_STATE=$(cat "$HOME/.omc/state/ultrawork-state.json" 2>/dev/null)
  fi

  IS_ACTIVE=$(echo "$ULTRAWORK_STATE" | jq -r '.active // false' 2>/dev/null)
  if [ "$IS_ACTIVE" = "true" ]; then
    STARTED_AT=$(echo "$ULTRAWORK_STATE" | jq -r '.started_at // ""' 2>/dev/null)
    PROMPT=$(echo "$ULTRAWORK_STATE" | jq -r '.original_prompt // ""' 2>/dev/null)
    MESSAGES="$MESSAGES<session-restore>\n\n[ULTRAWORK MODE RESTORED]\n\nYou have an active ultrawork session from $STARTED_AT.\nOriginal task: $PROMPT\n\nContinue working in ultrawork mode until all tasks are complete.\n\n</session-restore>\n\n---\n\n"
  fi
fi

# Check for incomplete todos
INCOMPLETE_COUNT=0
TODOS_DIR="$HOME/.claude/todos"
if [ -d "$TODOS_DIR" ]; then
  for todo_file in "$TODOS_DIR"/*.json; do
    if [ -f "$todo_file" ]; then
      if command -v jq &> /dev/null; then
        COUNT=$(jq '[.[] | select(.status != "completed" and .status != "cancelled")] | length' "$todo_file" 2>/dev/null || echo "0")
        INCOMPLETE_COUNT=$((INCOMPLETE_COUNT + COUNT))
      fi
    fi
  done
fi

if [ "$INCOMPLETE_COUNT" -gt 0 ]; then
  MESSAGES="$MESSAGES<session-restore>\n\n[PENDING TASKS DETECTED]\n\nYou have $INCOMPLETE_COUNT incomplete tasks from a previous session.\nPlease continue working on these tasks.\n\n</session-restore>\n\n---\n\n"
fi

# Output message if we have any
if [ -n "$MESSAGES" ]; then
  # Escape for JSON
  MESSAGES_ESCAPED=$(echo "$MESSAGES" | sed 's/"/\\"/g')
  echo "{\"continue\": true, \"message\": \"$MESSAGES_ESCAPED\"}"
else
  echo '{"continue": true}'
fi
exit 0
