#!/usr/bin/env bash
# setup-claude-md.sh - install CLAUDE.md through the plugin-local coordinator
# Usage: setup-claude-md.sh <local|global> [overwrite|preserve]

set -euo pipefail

MODE="${1:?Usage: setup-claude-md.sh <local|global> [overwrite|preserve]}"
INSTALL_STYLE="${2:-overwrite}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
. "$SCRIPT_DIR/lib/config-dir.sh"

# Resolve the current cached plugin rather than trusting a root captured when
# Claude Code started. A candidate is usable only when it contains the complete
# coordinator handshake surface; setup must never fall back to shell merging.
resolve_active_plugin_root() {
  is_valid_plugin_root() {
    local candidate="$1"
    [ -d "$candidate" ] \
      && [ -f "${candidate}/scripts/setup-claude-md.sh" ] \
      && [ -f "${candidate}/scripts/lib/config-dir.sh" ] \
      && [ -f "${candidate}/docs/CLAUDE.md" ] \
      && [ -f "${candidate}/bridge/claude-md-coordinator.cjs" ] \
      && [ -s "${candidate}/skills/omc-reference/SKILL.md" ]
  }

  select_latest_semver() {
    node -e '
      const fs = require("node:fs");
      const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]+)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]+))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
      const parse = value => {
        const match = value.match(semver);
        const pre = match?.[4]?.split(".") ?? [];
        return match && !pre.some(identifier => /^\d+$/.test(identifier) && !/^(0|[1-9]\d*)$/.test(identifier))
          ? { value, core: match.slice(1, 4).map(Number), pre }
          : null;
      };
      const compare = (left, right) => {
        for (let index = 0; index < 3; index += 1) if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
        if (!left.pre.length || !right.pre.length) return left.pre.length ? -1 : right.pre.length ? 1 : 0;
        for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
          if (left.pre[index] === undefined) return -1;
          if (right.pre[index] === undefined) return 1;
          if (left.pre[index] === right.pre[index]) continue;
          const numericLeft = /^\d+$/.test(left.pre[index]);
          const numericRight = /^\d+$/.test(right.pre[index]);
          if (numericLeft && numericRight) return Number(left.pre[index]) - Number(right.pre[index]);
          if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
          return left.pre[index] < right.pre[index] ? -1 : 1;
        }
        return 0;
      };
      const versions = fs.readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean).map(parse).filter(Boolean);
      versions.sort(compare);
      if (versions.length) process.stdout.write(`${versions.at(-1).value}\n`);
    '
  }

  list_cache_versions() {
    local base="$1"
    [ -d "$base" ] || return 0
    local entry
    for entry in "$base"/*; do
      entry="${entry##*/}"
      printf '%s\n' "$entry"
    done
  }

  local config_dir installed_plugins cache_base active_path latest newest
  config_dir="$(resolve_claude_config_dir)"
  installed_plugins="${config_dir}/plugins/installed_plugins.json"
  cache_base="$(dirname "$SCRIPT_PLUGIN_ROOT")"

  latest=$(list_cache_versions "$cache_base" | while IFS= read -r version; do
    is_valid_plugin_root "${cache_base}/${version}" && printf '%s\n' "$version"
  done | select_latest_semver)

  if [ -f "$installed_plugins" ] && command -v jq >/dev/null 2>&1; then
    active_path=$(jq -r '(.plugins // .) | to_entries[] | select(.key | startswith("oh-my-claudecode")) | .value[0].installPath // empty' "$installed_plugins" 2>/dev/null || true)
    if [ -n "$active_path" ] && is_valid_plugin_root "$active_path"; then
      newest=$(printf '%s\n%s\n' "$(basename "$active_path")" "$latest" | select_latest_semver)
      if [ -n "$latest" ] && [ "$newest" = "$latest" ]; then
        printf '%s\n' "${cache_base}/${latest}"
      else
        printf '%s\n' "$active_path"
      fi
      return 0
    fi
  fi

  if [ -n "$latest" ]; then
    printf '%s\n' "${cache_base}/${latest}"
  elif is_valid_plugin_root "$SCRIPT_PLUGIN_ROOT"; then
    printf '%s\n' "$SCRIPT_PLUGIN_ROOT"
  else
    return 1
  fi
}

ensure_local_omc_git_exclude() {
  local exclude_path
  if ! exclude_path=$(git rev-parse --git-path info/exclude 2>/dev/null); then
    echo "Skipped OMC git exclude setup (not a git repository)"
    return 0
  fi
  mkdir -p "$(dirname "$exclude_path")"
  if [ -f "$exclude_path" ] && grep -Fq '# BEGIN OMC local artifacts' "$exclude_path"; then
    if grep -Fxq '.omx/' "$exclude_path"; then
      echo "OMC git exclude already configured"
      return 0
    fi
    [ ! -s "$exclude_path" ] || printf '\n' >> "$exclude_path"
    printf '.omx/\n' >> "$exclude_path"
    echo "Updated OMC git exclude for local OMX artifacts"
    return 0
  fi
  [ ! -f "$exclude_path" ] || [ ! -s "$exclude_path" ] || printf '\n' >> "$exclude_path"
  cat >> "$exclude_path" <<'EOF'
# BEGIN OMC local artifacts
!.omc/
.omc/*
!.omc/skills/
!.omc/skills/**
.omx/
# END OMC local artifacts
EOF
  echo "Configured git exclude for local OMC/OMX artifacts (preserving .omc/skills/)"
}

install_omc_reference_skill() {
  local source="$1"
  [ -s "$source" ] || { echo "Skipped omc-reference skill install (canonical skill source unavailable)"; return 0; }
  mkdir -p "$(dirname "$SKILL_TARGET_PATH")"
  cp "$source" "$SKILL_TARGET_PATH"
  echo "Installed omc-reference skill to $SKILL_TARGET_PATH"
}

if [ "$MODE" != "local" ] && [ "$MODE" != "global" ]; then
  echo "ERROR: Invalid mode '$MODE'. Use 'local' or 'global'." >&2
  exit 1
fi
if [ "$INSTALL_STYLE" != "overwrite" ] && [ "$INSTALL_STYLE" != "preserve" ]; then
  echo "ERROR: Invalid install style '$INSTALL_STYLE'. Use 'overwrite' or 'preserve'." >&2
  exit 1
fi

if ! ACTIVE_PLUGIN_ROOT="$(resolve_active_plugin_root)"; then
  echo "ERROR: Active plugin root lacks the required coordinator artifact and canonical source; refusing setup." >&2
  exit 1
fi
if [ "$ACTIVE_PLUGIN_ROOT" != "$SCRIPT_PLUGIN_ROOT" ]; then
  exec bash "${ACTIVE_PLUGIN_ROOT}/scripts/setup-claude-md.sh" "$MODE" "$INSTALL_STYLE"
fi
COORDINATOR="${ACTIVE_PLUGIN_ROOT}/bridge/claude-md-coordinator.cjs"
CANONICAL_CLAUDE_MD="${ACTIVE_PLUGIN_ROOT}/docs/CLAUDE.md"
CANONICAL_OMC_REFERENCE_SKILL="${ACTIVE_PLUGIN_ROOT}/skills/omc-reference/SKILL.md"
if [ ! -f "$COORDINATOR" ] || [ ! -f "$CANONICAL_CLAUDE_MD" ] || [ ! -s "$CANONICAL_OMC_REFERENCE_SKILL" ]; then
  echo "ERROR: Coordinator artifact or canonical source is unavailable; refusing setup." >&2
  exit 1
fi

CONFIG_DIR="$(resolve_claude_config_dir)"
if [ "$MODE" = "local" ]; then
  CONFIG_ROOT="$(pwd)/.claude"
  SKILL_TARGET_PATH="${CONFIG_ROOT}/skills/omc-reference/SKILL.md"
  COORDINATOR_MODE="local"
else
  CONFIG_ROOT="$CONFIG_DIR"
  SKILL_TARGET_PATH="${CONFIG_ROOT}/skills/omc-reference/SKILL.md"
  if [ "$INSTALL_STYLE" = "preserve" ]; then COORDINATOR_MODE="global-preserve"; else COORDINATOR_MODE="global-overwrite"; fi
fi
# The coordinator owns the build handshake. Independently hashing the canonical
# source binds its authority to the exact bytes this invocation will request.
set +e
HANDSHAKE=$(node "$COORDINATOR" --handshake)
HANDSHAKE_STATUS=$?
set -e
if [ "$HANDSHAKE_STATUS" -ne 0 ]; then
  echo "ERROR: Coordinator handshake is unavailable; refusing setup." >&2
  exit "$HANDSHAKE_STATUS"
fi
if ! HANDSHAKE=$(node - "$HANDSHAKE" "$CANONICAL_CLAUDE_MD" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [raw, source] = process.argv.slice(2);
try {
  const handshake = JSON.parse(raw);
  if (!handshake || typeof handshake !== 'object' || handshake.schemaVersion !== 1 || typeof handshake.engineVersion !== 'string' || !handshake.engineVersion || typeof handshake.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(handshake.sourceSha256)) {
    throw new Error('invalid coordinator handshake response');
  }
  const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (sourceSha256 !== handshake.sourceSha256) throw new Error('canonical source hash does not match coordinator handshake');
  process.stdout.write(JSON.stringify({ engineVersion: handshake.engineVersion, sourceSha256 }));
} catch (error) { process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
NODE
); then
  echo "ERROR: Coordinator handshake validation failed; refusing setup." >&2
  exit 1
fi
mkdir -p "$CONFIG_ROOT"

REQUEST=$(node - "$HANDSHAKE" "$COORDINATOR_MODE" "$CONFIG_ROOT" "$ACTIVE_PLUGIN_ROOT" "$CANONICAL_CLAUDE_MD" <<'NODE'
const [handshakeJson, mode, configRoot, pluginRoot, sourcePath] = process.argv.slice(2);
const handshake = JSON.parse(handshakeJson);
process.stdout.write(JSON.stringify({ schemaVersion: 1, engineVersion: handshake.engineVersion, mode, configRoot, pluginRoot, sourcePath, sourceSha256: handshake.sourceSha256, sourceVersion: handshake.engineVersion }));
NODE
)

set +e
RESPONSE=$(printf '%s' "$REQUEST" | node "$COORDINATOR")
COORDINATOR_STATUS=$?
node - "$RESPONSE" "$COORDINATOR_STATUS" <<'NODE'
const [raw, status] = process.argv.slice(2);
try {
  const response = JSON.parse(raw);
  const exitCode = Number(status);
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean' || response.exitCode !== exitCode || response.ok !== (exitCode === 0)) {
    throw new Error('malformed coordinator response, ok/exit disagreement, or exit-code mismatch');
  }
  const print = (label, values) => Array.isArray(values) && values.forEach(value => console.log(`${label}: ${typeof value === 'string' ? value : value.path}`));
  print('Coordinator backup', response.backups);
  print('Coordinator mutated path', response.mutatedPaths);
  if (!response.ok) {
    console.error(`Coordinator failure: ${response.error || 'unspecified failure'}`);
    if (response.failedPath) console.error(`Coordinator failure path: ${response.failedPath}`);
    if (Array.isArray(response.rollback)) response.rollback.forEach(item => console.error(`Coordinator rollback path: ${item.path} (${item.ok ? 'restored' : `failed: ${item.error || 'unspecified failure'}`})`));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
NODE
VALIDATOR_STATUS=$?
set -e
if [ "$VALIDATOR_STATUS" -ne 0 ]; then
  exit "$VALIDATOR_STATUS"
fi

install_omc_reference_skill "$CANONICAL_OMC_REFERENCE_SKILL"
if [ "$MODE" = "local" ]; then ensure_local_omc_git_exclude; fi

if [ "$MODE" = "global" ]; then
  for legacy_hook in keyword-detector.sh stop-continuation.sh persistent-mode.sh session-start.sh; do
    legacy_hook_path="$CONFIG_DIR/hooks/$legacy_hook"
    if [ -f "$legacy_hook_path" ]; then
      echo "NOTE: Preserved unverified legacy hook at $legacy_hook_path; only coordinator-verified configuration is mutated."
    fi
  done
  SETTINGS_FILE="$CONFIG_DIR/settings.json"
  if [ -f "$SETTINGS_FILE" ] && jq -e 'any(.. | objects | .command? | strings; test("(^|[^[:alnum:]_-])(keyword-detector|stop-continuation|persistent-mode|session-start)(\\.(sh|mjs|cjs|js))?([^[:alnum:]_-]|$)"))' "$SETTINGS_FILE" >/dev/null 2>&1; then
    echo "NOTE: Found legacy OMC hook entries in settings.json. Remove only the legacy OMC hook entries from $SETTINGS_FILE; third-party hook entries can remain."
  fi
fi

if [ -f "$CONFIG_DIR/settings.json" ] && grep -q 'oh-my-claudecode' "$CONFIG_DIR/settings.json"; then
  echo "Plugin verified"
else
  echo "Plugin NOT found - run: claude /install-plugin oh-my-claudecode"
fi
