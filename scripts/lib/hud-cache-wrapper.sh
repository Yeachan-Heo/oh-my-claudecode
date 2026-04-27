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

mkdir -p "$CACHE_DIR" 2>/dev/null || {
  printf '[OMC] Starting...\n'
  exit 0
}

# Capture Claude's current statusLine stdin first so rendered output can be
# scoped per session/worktree instead of leaking across concurrent sessions.
cat > "$INPUT_TMP" 2>/dev/null || :

extract_json_string() {
  key=$1
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$INPUT_TMP" 2>/dev/null | head -1
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

# Hot path: return immediately from the last successful render for this session.
if [ -s "$OUTPUT_FILE" ]; then
  cat "$OUTPUT_FILE" 2>/dev/null || printf '[OMC] Starting...\n'
else
  printf '[OMC] Starting...\n'
fi

# Avoid spawning a Node renderer on every statusLine render. mkdir is atomic.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # Recover from stale locks left by crashes.
  if [ -d "$LOCK_DIR" ]; then
    now=$(date +%s 2>/dev/null || printf '0')
    lock_mtime=$( (stat -c %Y "$LOCK_DIR" 2>/dev/null || stat -f %m "$LOCK_DIR" 2>/dev/null) | head -1 )
    if [ -n "$lock_mtime" ] && [ "$now" -gt 0 ] && [ $((now - lock_mtime)) -gt 10 ]; then
      rm -rf "$LOCK_DIR" 2>/dev/null || :
      mkdir "$LOCK_DIR" 2>/dev/null || exit 0
    else
      exit 0
    fi
  else
    exit 0
  fi
fi

refresh_cache() {
  if [ ! -s "$INPUT_FILE" ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || :
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

  rm -f "$NODE_STDOUT_TMP" "$NODE_STDERR_TMP" 2>/dev/null || :
  rm -rf "$LOCK_DIR" 2>/dev/null || :
}

if [ "${OMC_HUD_SYNC_REFRESH:-0}" = "1" ]; then
  refresh_cache
else
  ( refresh_cache ) >/dev/null 2>&1 &
fi

exit 0
