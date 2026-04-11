#!/usr/bin/env bash
# setup-claude-md.sh — thin shim that delegates to `omc setup --claude-md-only`.
#
# The original 422-line implementation has moved to TypeScript at
# src/setup/claude-md.ts; this shim preserves the positional argument
# contract so out-of-tree callers keep working.
#
# Usage: setup-claude-md.sh <local|global> [overwrite|preserve]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/resolve-omc-cli.sh
. "${SCRIPT_DIR}/lib/resolve-omc-cli.sh"

CLI="$(resolve_omc_cli)" || exit 1

MODE="${1:?Usage: setup-claude-md.sh <local|global> [overwrite|preserve]}"
STYLE="${2:-overwrite}"

case "$MODE" in
  local)   TARGET_FLAG="--local" ;;
  global)  TARGET_FLAG="--global" ;;
  *) echo "ERROR: Invalid mode '$MODE'. Use 'local' or 'global'." >&2; exit 1 ;;
esac

case "$STYLE" in
  overwrite) STYLE_FLAG="--overwrite" ;;
  preserve)  STYLE_FLAG="--preserve" ;;
  *) echo "ERROR: Invalid install style '$STYLE'. Use 'overwrite' or 'preserve'." >&2; exit 1 ;;
esac

# shellcheck disable=SC2086
exec $CLI setup --claude-md-only "$TARGET_FLAG" "$STYLE_FLAG"
