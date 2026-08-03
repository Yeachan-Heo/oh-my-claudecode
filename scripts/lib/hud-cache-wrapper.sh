#!/bin/sh
# OMC HUD cached statusLine launcher.
#
# Claude Code invokes statusLine commands for every render. Starting Node and
# importing the HUD bundle each time can take hundreds of milliseconds, which
# makes the first frame blank/flickery. This POSIX wrapper keeps the statusLine
# protocol unchanged (stdin JSON in, one line out) while making the hot path a
# shell read + cat of the last rendered line. A single background Node refresh
# updates the session-scoped cache for the next frame.

case "$0" in
  */*) SCRIPT_DIR=${0%/*} ;;
  *) SCRIPT_DIR=. ;;
esac
SCRIPT_DIR=$(cd "$SCRIPT_DIR" 2>/dev/null && pwd -P) || SCRIPT_DIR=.
CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)}
CACHE_DIR=${OMC_HUD_CACHE_DIR:-"$CONFIG_DIR/hud/cache"}
HUD_SCRIPT=${1:-"$SCRIPT_DIR/omc-hud.mjs"}
INPUT_TMP="$CACHE_DIR/stdin.$$.tmp"
LOCK_STALE_SECONDS=${OMC_HUD_LOCK_STALE_SECONDS:-10}

mkdir -p "$CACHE_DIR" 2>/dev/null || {
  printf '[OMC] Starting...\n'
  exit 0
}
CACHE_DIR=$(cd "$CACHE_DIR" 2>/dev/null && pwd -P) || {
  printf '[OMC] Starting...\n'
  exit 0
}
INPUT_TMP="$CACHE_DIR/stdin.$$.tmp"

file_mtime() {
  (stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null) | head -1
}

is_stale_path() {
  path=$1
  now=$(date +%s 2>/dev/null || printf '0')
  path_mtime=$(file_mtime "$path")
  [ -n "$path_mtime" ] || return 1
  [ "$now" -gt 0 ] || return 1
  [ $((now - path_mtime)) -gt "$LOCK_STALE_SECONDS" ] || return 1
}

cleanup_empty_temp_files() {
  for temp_path in "$CACHE_DIR"/stdin.*.tmp "$CACHE_DIR"/statusline.*.tmp "$CACHE_DIR"/statusline.*.err; do
    [ -f "$temp_path" ] || continue
    [ -s "$temp_path" ] && continue
    is_stale_path "$temp_path" || continue
    rm -f "$temp_path" 2>/dev/null || :
  done
}

cleanup_stale_render_locks() {
  for stale_lock_dir in "$CACHE_DIR"/render.*.lock; do
    [ -d "$stale_lock_dir" ] || continue
    is_stale_path "$stale_lock_dir" || continue
    rm -rf "$stale_lock_dir" 2>/dev/null || :
  done
}

cleanup_empty_temp_files
cleanup_stale_render_locks

# Capture Claude's current statusLine stdin first so rendered output can be
# scoped per session/worktree instead of leaking across concurrent sessions.
cat > "$INPUT_TMP" 2>/dev/null || :

extract_json_string() {
  key=$1
  file=${2:-$INPUT_TMP}
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" 2>/dev/null | head -1
}

# Like extract_json_string, but scoped to a specific flat parent object
# (e.g. "id" within "model":{...}) instead of the first bare match anywhere
# in the payload. Both `model` and `effort` are flat, single-level objects
# in the real statusline schema, so matching up to the first `}` is safe.
extract_nested_json_string() {
  parent=$1
  key=$2
  file=${3:-$INPUT_TMP}
  object=$(sed -n "s/.*\"$parent\"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p" "$file" 2>/dev/null | head -1)
  [ -n "$object" ] || return 0
  printf '%s' "$object" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
}

SESSION_KEY=$(extract_json_string session_id)
if [ -z "$SESSION_KEY" ] && [ -n "${CLAUDE_SESSION_ID:-}" ]; then
  SESSION_KEY=$CLAUDE_SESSION_ID
fi
if [ -z "$SESSION_KEY" ] && [ -n "${CLAUDECODE_SESSION_ID:-}" ]; then
  SESSION_KEY=$CLAUDECODE_SESSION_ID
fi
TRANSCRIPT_PATH=$(extract_json_string transcript_path)
if [ -z "$SESSION_KEY" ] && [ -n "$TRANSCRIPT_PATH" ]; then
  SESSION_KEY=$(printf '%s\n' "$TRANSCRIPT_PATH" | sed -n 's/.*\([0-9a-fA-F][0-9a-fA-F-]\{35\}\).*/\1/p' | head -1)
  if [ -z "$SESSION_KEY" ]; then
    SESSION_KEY=$(printf '%s\n' "$TRANSCRIPT_PATH" | cksum 2>/dev/null | awk '{print "transcript-" $1}')
  fi
fi
if [ -z "$SESSION_KEY" ]; then
  CWD_VALUE=$(extract_json_string cwd)
  if [ -n "$CWD_VALUE" ]; then
    SESSION_KEY=$(printf '%s\n' "$CWD_VALUE" | cksum 2>/dev/null | awk '{print "cwd-" $1}')
  fi
fi
if [ -z "$SESSION_KEY" ]; then
  SESSION_KEY=default
fi
SESSION_KEY=$(printf '%s' "$SESSION_KEY" | sed 's/[^A-Za-z0-9_.-]/_/g')

INPUT_FILE="$CACHE_DIR/stdin.$SESSION_KEY.json"
OUTPUT_FILE="$CACHE_DIR/statusline.$SESSION_KEY.txt"
LOCK_DIR="$CACHE_DIR/render.$SESSION_KEY.lock"
NODE_STDOUT_TMP="$CACHE_DIR/statusline.$SESSION_KEY.$$.tmp"
NODE_STDERR_TMP="$CACHE_DIR/statusline.$SESSION_KEY.$$.err"

if [ -s "$INPUT_TMP" ]; then
  mv "$INPUT_TMP" "$INPUT_FILE" 2>/dev/null || cp "$INPUT_TMP" "$INPUT_FILE" 2>/dev/null || :
fi
rm -f "$INPUT_TMP" 2>/dev/null || :

# Detect a model/effort switch (e.g. `/model`) so the hot path below can
# force a synchronous refresh instead of serving stale cached text. Claude
# Code does not reliably re-poll the statusLine right after a bare /model
# selection, so without this the wrong model can stay on screen until some
# unrelated interaction happens to trigger another statusLine call.
MARKER_FILE="$CACHE_DIR/model-effort.$SESSION_KEY.txt"
NEW_MARKER=""
MODEL_CHANGED=0
if [ -s "$INPUT_FILE" ]; then
  NEW_MODEL_ID=$(extract_nested_json_string model id "$INPUT_FILE")
  if [ -n "$NEW_MODEL_ID" ]; then
    NEW_EFFORT_LEVEL=$(extract_nested_json_string effort level "$INPUT_FILE")
    NEW_MARKER="${NEW_MODEL_ID}|${NEW_EFFORT_LEVEL}"
    if [ -f "$MARKER_FILE" ]; then
      PREV_MARKER=$(cat "$MARKER_FILE" 2>/dev/null)
      if [ "$NEW_MARKER" != "$PREV_MARKER" ]; then
        MODEL_CHANGED=1
      fi
    fi
  fi
fi

try_acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    return 0
  fi
  if [ ! -d "$LOCK_DIR" ]; then
    return 1
  fi
  is_stale_path "$LOCK_DIR" || return 1
  rm -rf "$LOCK_DIR" 2>/dev/null || :
  mkdir "$LOCK_DIR" 2>/dev/null
}

refresh_cache() {
  cleanup_refresh_artifacts() {
    rm -f "$NODE_STDOUT_TMP" 2>/dev/null || :
    if [ ! -s "$NODE_STDERR_TMP" ]; then
      rm -f "$NODE_STDERR_TMP" 2>/dev/null || :
    fi
    rm -rf "$LOCK_DIR" 2>/dev/null || :
  }

  trap 'cleanup_refresh_artifacts' EXIT
  trap 'cleanup_refresh_artifacts; exit 0' HUP INT TERM

  if [ ! -s "$INPUT_FILE" ]; then
    cleanup_refresh_artifacts
    return
  fi

  if [ -x "$SCRIPT_DIR/find-node.sh" ]; then
    sh "$SCRIPT_DIR/find-node.sh" "$HUD_SCRIPT" < "$INPUT_FILE" > "$NODE_STDOUT_TMP" 2> "$NODE_STDERR_TMP"
  else
    node "$HUD_SCRIPT" < "$INPUT_FILE" > "$NODE_STDOUT_TMP" 2> "$NODE_STDERR_TMP"
  fi

  # Keep the last good line if rendering fails or returns empty output.
  if [ -s "$NODE_STDOUT_TMP" ]; then
    mv "$NODE_STDOUT_TMP" "$OUTPUT_FILE" 2>/dev/null || cp "$NODE_STDOUT_TMP" "$OUTPUT_FILE" 2>/dev/null || :
  fi

  # Record that we've reacted to this model/effort regardless of whether the
  # render itself succeeded. The marker means "already forced a synchronous
  # refresh for this selection", not "successfully rendered it" — otherwise a
  # renderer that keeps failing would never advance the marker, and every
  # single frame would retry a blocking foreground Node spawn forever instead
  # of falling back to the cheap hot path like it did before this selection.
  if [ -n "$NEW_MARKER" ]; then
    printf '%s' "$NEW_MARKER" > "$MARKER_FILE" 2>/dev/null || :
  fi

  rm -f "$NODE_STDOUT_TMP" "$NODE_STDERR_TMP" 2>/dev/null || :
  rm -rf "$LOCK_DIR" 2>/dev/null || :
  trap - EXIT HUP INT TERM
}

# Hot path: return immediately from the last successful render for this
# session, unless the model/effort just changed (see MODEL_CHANGED above).
if [ -s "$OUTPUT_FILE" ] && [ "$MODEL_CHANGED" != "1" ]; then
  cat "$OUTPUT_FILE" 2>/dev/null || printf '[OMC] Starting...\n'
  # Refresh in background for the next frame.
  if try_acquire_lock; then
    if [ "${OMC_HUD_SYNC_REFRESH:-0}" = "1" ]; then
      refresh_cache
    else
      ( refresh_cache ) >/dev/null 2>&1 &
    fi
  fi
  exit 0
fi

# First render for this session, or a just-detected model/effort switch: do
# a synchronous refresh so the user sees the correct HUD on this frame.
# Claude Code v2.1.x does not re-poll the statusLine until user interaction,
# so an async background refresh could leave a stale/placeholder line on
# screen until some unrelated interaction happens to trigger another call.
if [ -s "$INPUT_FILE" ] && try_acquire_lock; then
  refresh_cache
  if [ -s "$OUTPUT_FILE" ]; then
    cat "$OUTPUT_FILE" 2>/dev/null && exit 0
  fi
fi

# Couldn't refresh synchronously (e.g. a background refresh already holds
# the lock) — fall back to the last good render rather than a blank
# placeholder; the next call will pick up the fresh content.
if [ -s "$OUTPUT_FILE" ]; then
  cat "$OUTPUT_FILE" 2>/dev/null && exit 0
fi

printf '[OMC] Starting...\n'
exit 0
