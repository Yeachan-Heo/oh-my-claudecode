#!/usr/bin/env bash
# setup-progress.sh - Save/clear/resume setup progress helpers
# Usage:
#   setup-progress.sh save <step_number> <config_type>
#   setup-progress.sh clear
#   setup-progress.sh resume
#   setup-progress.sh complete <version>

set -euo pipefail

STATE_FILE=".omc/state/setup-state.json"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONFIG_FILE="$CONFIG_DIR/.omc-config.json"

# Cross-platform ISO date to epoch conversion
iso_to_epoch() {
  local iso_date="$1"
  local epoch=""
  # Try GNU date first (Linux)
  epoch=$(date -d "$iso_date" +%s 2>/dev/null) || true
  if [ -n "$epoch" ] && [ "$epoch" != "0" ]; then
    echo "$epoch"
    return 0
  fi
  # Try BSD/macOS date
  local clean_date
  clean_date=$(echo "$iso_date" | sed 's/[+-][0-9][0-9]:[0-9][0-9]$//' | sed 's/Z$//' | sed 's/T/ /')
  epoch=$(date -j -f "%Y-%m-%d %H:%M:%S" "$clean_date" +%s 2>/dev/null) || true
  if [ -n "$epoch" ] && [ "$epoch" != "0" ]; then
    echo "$epoch"
    return 0
  fi
  echo "0"
}

cmd_save() {
  local step="$1"
  local config_type="${2:-unknown}"
  mkdir -p .omc/state
  cat > "$STATE_FILE" << EOF
{
  "lastCompletedStep": $step,
  "timestamp": "$(date -Iseconds)",
  "configType": "$config_type"
}
EOF
  echo "Progress saved: step $step ($config_type)"
}

cmd_clear() {
  rm -f "$STATE_FILE"
  echo "Setup state cleared."
}

cmd_resume() {
  if [ ! -f "$STATE_FILE" ]; then
    echo "fresh"
    return 0
  fi

  # Check if state is stale (older than 24 hours)
  TIMESTAMP_RAW=$(jq -r '.timestamp // empty' "$STATE_FILE" 2>/dev/null)
  if [ -n "$TIMESTAMP_RAW" ]; then
    TIMESTAMP_EPOCH=$(iso_to_epoch "$TIMESTAMP_RAW")
    NOW_EPOCH=$(date +%s)
    STATE_AGE=$((NOW_EPOCH - TIMESTAMP_EPOCH))
  else
    STATE_AGE=999999  # Force fresh start if no timestamp
  fi

  if [ "$STATE_AGE" -gt 86400 ]; then
    echo "Previous setup state is more than 24 hours old. Starting fresh."
    rm -f "$STATE_FILE"
    echo "fresh"
    return 0
  fi

  LAST_STEP=$(jq -r ".lastCompletedStep // 0" "$STATE_FILE" 2>/dev/null || echo "0")
  TIMESTAMP=$(jq -r .timestamp "$STATE_FILE" 2>/dev/null || echo "unknown")
  CONFIG_TYPE=$(jq -r '.configType // "unknown"' "$STATE_FILE" 2>/dev/null || echo "unknown")
  echo "Found previous setup session (Step $LAST_STEP completed at $TIMESTAMP, configType=$CONFIG_TYPE)"
  echo "$LAST_STEP"
}

cmd_complete() {
  local version="${1:-unknown}"

  # Clear temporary state
  rm -f "$STATE_FILE"

  # Clear skill-active-state left over from nested skill invocations (e.g. mcp-setup
  # invoked inside omc-setup). Without this, the stop hook blocks with "skill still
  # executing" even though setup has finished.
  local sid="${CLAUDE_SESSION_ID:-${CLAUDECODE_SESSION_ID:-}}"
  if [ -n "$sid" ]; then
    # Validate session ID: alphanumeric, hyphens, underscores only (matches TS SESSION_ID_REGEX)
    if [[ "$sid" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$ ]]; then
      rm -f ".omc/state/sessions/${sid}/skill-active-state.json" 2>/dev/null || true
    fi
  else
    # No session ID: fall back to cleaning stale files only (>30min, matching heavy TTL)
    find .omc/state -name "skill-active-state.json" -mmin +30 -delete 2>/dev/null || true
  fi

  # Mark setup as completed in persistent config
  mkdir -p "$(dirname "$CONFIG_FILE")"

  local existing='{}'
  if [ -f "$CONFIG_FILE" ]; then
    existing=$(cat "$CONFIG_FILE")
  fi

  echo "$existing" | jq --arg ts "$(date -Iseconds)" --arg ver "$version" \
    '. + {setupCompleted: $ts, setupVersion: $ver}' > "$CONFIG_FILE"

  echo "Setup completed successfully!"
  echo "Note: Future updates will only refresh CLAUDE.md, not the full setup wizard."
}

# Main dispatch
case "${1:-}" in
  save)
    cmd_save "${2:?step number required}" "${3:-unknown}"
    ;;
  clear)
    cmd_clear
    ;;
  resume)
    cmd_resume
    ;;
  complete)
    cmd_complete "${2:-unknown}"
    ;;
  *)
    echo "Usage: setup-progress.sh {save <step> <config_type>|clear|resume|complete <version>}" >&2
    exit 1
    ;;
esac
