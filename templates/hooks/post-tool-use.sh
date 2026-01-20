#!/bin/bash
# OMC Post-Tool-Use Hook
# Processes <remember> tags from Task agent output
# Saves to .omc/notepad.md for compaction-resilient memory

# Read stdin
INPUT=$(cat)

# Get directory and tool info
DIRECTORY=""
TOOL_NAME=""
TOOL_OUTPUT=""
if command -v jq &> /dev/null; then
  DIRECTORY=$(echo "$INPUT" | jq -r '.directory // ""' 2>/dev/null)
  TOOL_NAME=$(echo "$INPUT" | jq -r '.toolName // ""' 2>/dev/null)
  TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.toolOutput // ""' 2>/dev/null)
else
  # Fallback: use grep/sed for extraction
  DIRECTORY=$(echo "$INPUT" | grep -oP '"directory"\s*:\s*"\K[^"]+' | head -1)
  TOOL_NAME=$(echo "$INPUT" | grep -oP '"toolName"\s*:\s*"\K[^"]+' | head -1)
  TOOL_OUTPUT=$(echo "$INPUT" | grep -oP '"toolOutput"\s*:\s*"\K[^"]+' | head -1)
fi

if [ -z "$DIRECTORY" ]; then
  DIRECTORY=$(pwd)
fi

# Only process Task tool output
if [ "$TOOL_NAME" != "Task" ] && [ "$TOOL_NAME" != "task" ]; then
  echo '{"continue": true}'
  exit 0
fi

# Check for <remember> tags
if ! echo "$TOOL_OUTPUT" | grep -q '<remember'; then
  echo '{"continue": true}'
  exit 0
fi

# Create .omc directory if needed
OMC_DIR="$DIRECTORY/.omc"
NOTEPAD_FILE="$OMC_DIR/notepad.md"
mkdir -p "$OMC_DIR" 2>/dev/null

# Initialize notepad.md if it doesn't exist
if [ ! -f "$NOTEPAD_FILE" ]; then
  cat > "$NOTEPAD_FILE" << 'NOTEPAD_INIT'
# Notepad
<!-- Auto-managed by OMC. Manual edits preserved in MANUAL section. -->

## Priority Context
<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->

## Working Memory
<!-- Session notes. Auto-pruned after 7 days. -->

## MANUAL
<!-- User content. Never auto-pruned. -->
NOTEPAD_INIT
fi

# Process priority remember tags
PRIORITY_CONTENT=$(echo "$TOOL_OUTPUT" | grep -oP '<remember\s+priority>\K[\s\S]*?(?=</remember>)' | head -1)
if [ -n "$PRIORITY_CONTENT" ]; then
  # Read current notepad
  NOTEPAD_CONTENT=$(cat "$NOTEPAD_FILE")
  # Replace Priority Context section
  NEW_NOTEPAD=$(echo "$NOTEPAD_CONTENT" | sed '/## Priority Context/,/## Working Memory/{
    /## Priority Context/!{/## Working Memory/!d}
  }' | sed "/## Priority Context/a\\<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->\\n$PRIORITY_CONTENT")
  echo "$NEW_NOTEPAD" > "$NOTEPAD_FILE"
fi

# Process regular remember tags
while IFS= read -r CONTENT; do
  if [ -n "$CONTENT" ]; then
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
    # Append to Working Memory section (before MANUAL)
    sed -i "/## MANUAL/i\\### $TIMESTAMP\\n$CONTENT\\n" "$NOTEPAD_FILE" 2>/dev/null || {
      # macOS sed fallback
      sed -i '' "/## MANUAL/i\\
### $TIMESTAMP\\
$CONTENT\\
" "$NOTEPAD_FILE"
    }
  fi
done < <(echo "$TOOL_OUTPUT" | grep -oP '<remember>\K[\s\S]*?(?=</remember>)')

echo '{"continue": true}'
exit 0
