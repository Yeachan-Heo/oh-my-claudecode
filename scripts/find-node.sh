#!/bin/sh
# OMC Node.js Finder (find-node.sh)
#
# Locates the Node.js binary and executes it with the provided arguments.
# Designed for nvm/fnm users where `node` is not on PATH in non-interactive
# shells (e.g. Claude Code hook invocations). Fixes issue #892.
#
# Priority:
#   1. nodeBinary stored in ~/.claude/.omc-config.json (set at setup time)
#   2. `which node` (node is on PATH)
#   3. nvm versioned paths  (~/.nvm/versions/node/*/bin/node)
#   4. fnm versioned paths  (~/.fnm/node-versions/*/installation/bin/node)
#   5. Homebrew / system paths (/opt/homebrew/bin/node, /usr/local/bin/node)
#
# Exits 0 on failure so it never blocks Claude Code hook processing.

NODE_BIN=""

case "$0" in
  */*)
    SCRIPT_DIR="${0%/*}"
    ;;
  *)
    SCRIPT_DIR='.'
    ;;
esac

SCRIPT_DIR="$(cd "$SCRIPT_DIR" && pwd)"
. "$SCRIPT_DIR/lib/config-dir.sh"

# ---------------------------------------------------------------------------
# 1. Read stored node path from OMC config
# ---------------------------------------------------------------------------
CLAUDE_DIR="$(resolve_claude_config_dir)"
CONFIG_FILE="$CLAUDE_DIR/.omc-config.json"
if [ -f "$CONFIG_FILE" ]; then
  # POSIX-safe extraction without requiring jq
  _stored=$(grep -o '"nodeBinary" *: *"[^"]*"' "$CONFIG_FILE" 2>/dev/null \
    | head -1 \
    | sed 's/.*"nodeBinary" *: *"//;s/".*//')
  if [ -n "$_stored" ] && [ -x "$_stored" ]; then
    NODE_BIN="$_stored"
  fi
fi

# ---------------------------------------------------------------------------
# 2. which node
# ---------------------------------------------------------------------------
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
fi

# ---------------------------------------------------------------------------
# 3. nvm versioned paths: iterate to find the latest installed version
# ---------------------------------------------------------------------------
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  # Pick the highest installed version. Lexicographic glob order is wrong
  # for node version dirs — e.g. v10.x sorts BEFORE v8.x by byte comparison,
  # so the old "last iter wins" heuristic picked v9.x when v18.x was also
  # installed. `sort -rV` gives version-aware ordering; take the first
  # executable.
  NODE_BIN=$(
    # shellcheck disable=SC2231
    printf '%s\n' "$HOME/.nvm/versions/node"/*/bin/node | sort -rV | \
      while IFS= read -r _p; do
        [ -x "$_p" ] && { printf '%s' "$_p"; exit 0; }
      done
  )
fi

# ---------------------------------------------------------------------------
# 4. fnm versioned paths (Linux and macOS default locations)
# ---------------------------------------------------------------------------
if [ -z "$NODE_BIN" ]; then
  for _fnm_base in \
    "$HOME/.fnm/node-versions" \
    "$HOME/Library/Application Support/fnm/node-versions" \
    "$HOME/.local/share/fnm/node-versions"; do
    if [ -d "$_fnm_base" ]; then
      # Version-sort matches the nvm handling above (avoids picking v9.x
      # over v18.x from lexicographic glob order).
      NODE_BIN=$(
        # shellcheck disable=SC2231
        printf '%s\n' "$_fnm_base"/*/installation/bin/node | sort -rV | \
          while IFS= read -r _p; do
            [ -x "$_p" ] && { printf '%s' "$_p"; exit 0; }
          done
      )
      [ -n "$NODE_BIN" ] && break
    fi
  done
fi

# ---------------------------------------------------------------------------
# 5. Common Homebrew / system paths
# ---------------------------------------------------------------------------
if [ -z "$NODE_BIN" ]; then
  for _path in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$_path" ]; then
      NODE_BIN="$_path"
      break
    fi
  done
fi

# ---------------------------------------------------------------------------
# Invoke node with all provided arguments
# ---------------------------------------------------------------------------
if [ -z "$NODE_BIN" ]; then
  printf '[OMC] Error: Could not find node binary. Run /oh-my-claudecode:omc-setup to fix.\n' >&2
  exit 0  # exit 0 so this hook does not block Claude Code
fi

exec "$NODE_BIN" "$@"
