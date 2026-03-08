#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LOCAL_CLI="$SCRIPT_DIR/../bridge/cli.cjs"
FALLBACK_ADVISOR="$SCRIPT_DIR/run-provider-advisor.js"

if [[ -f "$LOCAL_CLI" ]]; then
  node "$LOCAL_CLI" ask codex "$@"
  status=$?
  if [[ $status -ne 126 && $status -ne 127 ]]; then
    exit $status
  fi

  >&2 echo "[ask-codex] DEPRECATED fallback: local OMC CLI launch failed (exit $status); falling back to run-provider-advisor.js"
elif [[ ! -f "$FALLBACK_ADVISOR" ]]; then
  >&2 echo "[ask-codex] Error: local OMC CLI and fallback advisor script are both unavailable."
  exit 1
else
  >&2 echo "[ask-codex] DEPRECATED fallback: local OMC CLI entrypoint not found; using run-provider-advisor.js"
fi

node "$FALLBACK_ADVISOR" codex "$@"
exit $?
