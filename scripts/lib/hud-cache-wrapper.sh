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
CACHE_TTL_SECONDS=${OMC_HUD_CACHE_TTL_SECONDS:-604800}

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

is_cache_stale_path() {
  path=$1
  now=$(date +%s 2>/dev/null || printf '0')
  path_mtime=$(file_mtime "$path")
  [ -n "$path_mtime" ] || return 1
  [ "$now" -gt 0 ] || return 1
  [ $((now - path_mtime)) -gt "$CACHE_TTL_SECONDS" ] || return 1
}

is_numeric_pid() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

is_pid_alive() {
  pid=$1
  is_numeric_pid "$pid" || return 1
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  if command -v ps >/dev/null 2>&1; then
    ps -p "$pid" >/dev/null 2>&1 && return 0
  fi
  return 1
}

read_lock_pid() {
  lock_path=$1
  if [ -f "$lock_path/pid" ]; then
    awk 'NR==1{print $1}' "$lock_path/pid" 2>/dev/null | tr -d '\r\n'
    return 0
  fi
  if [ -f "$lock_path" ] && [ ! -d "$lock_path" ]; then
    awk 'NR==1{print $1}' "$lock_path" 2>/dev/null | tr -d '\r\n'
  fi
}

is_lock_stale() {
  lock_path=$1
  if [ ! -e "$lock_path" ]; then
    return 1
  fi
  lock_pid=$(read_lock_pid "$lock_path")
  if [ -n "$lock_pid" ]; then
    if is_numeric_pid "$lock_pid"; then
      if is_pid_alive "$lock_pid"; then
        return 1
      fi
      is_stale_path "$lock_path" || return 1
      return 0
    fi
    is_stale_path "$lock_path" || return 1
    return 0
  fi
  is_stale_path "$lock_path"
}

write_lock_pid() {
  lock_path=$1
  printf '%s\n' "$$" > "$lock_path/pid" 2>/dev/null || :
}

acquire_lock_owned() {
  lock_path=$1
  if mkdir "$lock_path" 2>/dev/null; then
    write_lock_pid "$lock_path"
    return 0
  fi
  return 1
}

release_lock_if_owned() {
  lock_path=$1
  owner_pid=$2
  if [ ! -d "$lock_path" ]; then
    return 0
  fi
  current_pid=$(read_lock_pid "$lock_path")
  if [ -n "$current_pid" ] && [ -n "$owner_pid" ]; then
    if [ "$current_pid" = "$owner_pid" ]; then
      rm -rf "$lock_path" 2>/dev/null || :
      return 0
    fi
    return 0
  fi
  if [ -z "$current_pid" ]; then
    if [ -n "$owner_pid" ]; then
      return 0
    fi
    if is_stale_path "$lock_path"; then
      rm -rf "$lock_path" 2>/dev/null || :
    fi
  fi
}

cleanup_stale_temp_files() {
  for temp_path in "$CACHE_DIR"/stdin.*.tmp "$CACHE_DIR"/statusline.*.tmp; do
    [ -f "$temp_path" ] || continue
    is_stale_path "$temp_path" || continue
    rm -f "$temp_path" 2>/dev/null || :
  done
}

cleanup_stale_err_files() {
  for err_path in "$CACHE_DIR"/statusline.*.err; do
    [ -f "$err_path" ] || continue
    is_stale_path "$err_path" || continue
    rm -f "$err_path" 2>/dev/null || :
  done
}

cleanup_stale_render_locks() {
  for stale_lock_dir in "$CACHE_DIR"/render.*.lock; do
    [ -d "$stale_lock_dir" ] || continue
    is_lock_stale "$stale_lock_dir" || continue
    rm -rf "$stale_lock_dir" 2>/dev/null || :
  done
}

cleanup_stale_session_caches() {
  for cache_path in "$CACHE_DIR"/stdin.*.json "$CACHE_DIR"/statusline.*.txt; do
    [ -f "$cache_path" ] || continue
    is_cache_stale_path "$cache_path" || continue
    rm -f "$cache_path" 2>/dev/null || :
  done
}

cleanup_stale_temp_files
cleanup_stale_err_files
cleanup_stale_render_locks
cleanup_stale_session_caches

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

try_acquire_lock() {
  if acquire_lock_owned "$LOCK_DIR"; then
    return 0
  fi
  if [ ! -d "$LOCK_DIR" ]; then
    return 1
  fi
  is_lock_stale "$LOCK_DIR" || return 1
  rm -rf "$LOCK_DIR" 2>/dev/null || :
  acquire_lock_owned "$LOCK_DIR"
}

refresh_cache() {
  REFRESH_PID=$$
  if [ -d "$LOCK_DIR" ]; then
    printf '%s\n' "$REFRESH_PID" > "$LOCK_DIR/pid" 2>/dev/null || :
  fi

  cleanup_refresh_artifacts() {
    rm -f "$NODE_STDOUT_TMP" 2>/dev/null || :
    if [ ! -s "$NODE_STDERR_TMP" ]; then
      rm -f "$NODE_STDERR_TMP" 2>/dev/null || :
    fi
    release_lock_if_owned "$LOCK_DIR" "$REFRESH_PID"
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

  rm -f "$NODE_STDOUT_TMP" "$NODE_STDERR_TMP" 2>/dev/null || :
  release_lock_if_owned "$LOCK_DIR" "$REFRESH_PID"
  trap - EXIT HUP INT TERM
}

# Hot path: return immediately from the last successful render for this session.
if [ -s "$OUTPUT_FILE" ]; then
  cat "$OUTPUT_FILE" 2>/dev/null || printf '[OMC] Starting...\n'
  if try_acquire_lock; then
    if [ "${OMC_HUD_SYNC_REFRESH:-0}" = "1" ]; then
      refresh_cache
    else
      ( refresh_cache ) >/dev/null 2>&1 &
    fi
  fi
  exit 0
fi

if [ -s "$INPUT_FILE" ] && try_acquire_lock; then
  refresh_cache
  if [ -s "$OUTPUT_FILE" ]; then
    cat "$OUTPUT_FILE" 2>/dev/null && exit 0
  fi
fi

printf '[OMC] Starting...\n'
exit 0
