#!/usr/bin/env bash
# setup-progress.sh — thin shim that delegates to `omc setup --state-*`.
#
# The original 141-line implementation has moved to TypeScript at
# src/setup/state.ts; this shim preserves the positional argument contract
# so out-of-tree callers keep working.
#
# Usage:
#   setup-progress.sh save <step_number> <config_type>
#   setup-progress.sh clear
#   setup-progress.sh resume
#   setup-progress.sh complete <version>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/resolve-omc-cli.sh
. "${SCRIPT_DIR}/lib/resolve-omc-cli.sh"

CLI="$(resolve_omc_cli)" || exit 1

# shellcheck disable=SC2086
case "${1:-}" in
  save)
    exec $CLI setup --state-save "${2:?step number required}" --state-config-type "${3:-unknown}"
    ;;
  clear)
    exec $CLI setup --state-clear
    ;;
  resume)
    exec $CLI setup --state-resume
    ;;
  complete)
    exec $CLI setup --state-complete "${2:-unknown}"
    ;;
  *)
    echo "Usage: setup-progress.sh {save <step> <config_type>|clear|resume|complete <version>}" >&2
    exit 1
    ;;
esac
