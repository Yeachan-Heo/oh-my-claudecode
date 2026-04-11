#!/usr/bin/env bash
# setup-claude-md.sh - Unified CLAUDE.md download/merge script
# Usage: setup-claude-md.sh <local|global> [overwrite|preserve]
#
# Handles: version extraction, backup, download, marker stripping, merge, version reporting.
# For global mode, defaults to overwrite; preserve mode keeps the user's base
# CLAUDE.md and writes OMC content to a companion file for `omc` launch.

set -euo pipefail

MODE="${1:?Usage: setup-claude-md.sh <local|global> [overwrite|preserve]}"
INSTALL_STYLE="${2:-overwrite}"
DOWNLOAD_URL="https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
. "$SCRIPT_DIR/lib/config-dir.sh"

# Resolve active plugin root from installed_plugins.json.
# Handles stale CLAUDE_PLUGIN_ROOT when a session was started before a plugin
# update (e.g. 4.8.2 session invoking setup after updating to 4.9.0).
# Same pattern as run.cjs resolveTarget() fallback.
resolve_active_plugin_root() {
  is_valid_plugin_root() {
    local candidate="$1"
    [ -d "$candidate" ] && [ -f "${candidate}/docs/CLAUDE.md" ]
  }

  list_cache_versions() {
    local base="$1"
    ls -1 "$base" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
  }

  local config_dir
  config_dir="$(resolve_claude_config_dir)"
  local installed_plugins="${config_dir}/plugins/installed_plugins.json"
  local cache_base
  cache_base="$(dirname "$SCRIPT_PLUGIN_ROOT")"

  if [ -f "$installed_plugins" ] && command -v jq >/dev/null 2>&1; then
    local active_path
    active_path=$(jq -r '
      (.plugins // .)
      | to_entries[]
      | select(.key | startswith("oh-my-claudecode"))
      | .value[0].installPath // empty
    ' "$installed_plugins" 2>/dev/null)

    if [ -n "$active_path" ] && is_valid_plugin_root "$active_path"; then
      # Guard against stale installed_plugins.json after plugin update:
      # if cache contains a newer valid version, prefer it.
      if [ -d "$cache_base" ]; then
        local active_version latest_cache_version preferred_version
        active_version="$(basename "$active_path")"
        latest_cache_version=$(list_cache_versions "$cache_base" | while IFS= read -r v; do
          if is_valid_plugin_root "${cache_base}/${v}"; then
            echo "$v"
          fi
        done | sort -t. -k1,1nr -k2,2nr -k3,3nr | head -1)

        if [ -n "$latest_cache_version" ] && [ -d "${cache_base}/${latest_cache_version}" ]; then
          preferred_version=$(printf '%s\n%s\n' "$active_version" "$latest_cache_version" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | sort -t. -k1,1nr -k2,2nr -k3,3nr | head -1)
          if [ "$preferred_version" = "$latest_cache_version" ] && [ "$latest_cache_version" != "$active_version" ]; then
            echo "${cache_base}/${latest_cache_version}"
            return 0
          fi
        fi
      fi

      echo "$active_path"
      return 0
    fi
  fi

  # Fallback: scan sibling version directories for the latest (mirrors run.cjs)
  if [ -d "$cache_base" ]; then
    local latest
    latest=$(list_cache_versions "$cache_base" | while IFS= read -r v; do
      if is_valid_plugin_root "${cache_base}/${v}"; then
        echo "$v"
      fi
    done | sort -t. -k1,1nr -k2,2nr -k3,3nr | head -1)
    if [ -n "$latest" ] && is_valid_plugin_root "${cache_base}/${latest}"; then
      echo "${cache_base}/${latest}"
      return 0
    fi
  fi

  echo "$SCRIPT_PLUGIN_ROOT"
}

ACTIVE_PLUGIN_ROOT="$(resolve_active_plugin_root)"
CANONICAL_CLAUDE_MD="${ACTIVE_PLUGIN_ROOT}/docs/CLAUDE.md"
CANONICAL_OMC_REFERENCE_SKILL="${ACTIVE_PLUGIN_ROOT}/skills/omc-reference/SKILL.md"

ensure_local_omc_git_exclude() {
  local exclude_path

  if ! exclude_path=$(git rev-parse --git-path info/exclude 2>/dev/null); then
    echo "Skipped OMC git exclude setup (not a git repository)"
    return 0
  fi

  mkdir -p "$(dirname "$exclude_path")"

  local block_start="# BEGIN OMC local artifacts"

  if [ -f "$exclude_path" ] && grep -Fq "$block_start" "$exclude_path"; then
    echo "OMC git exclude already configured"
    return 0
  fi

  if [ -f "$exclude_path" ] && [ -s "$exclude_path" ]; then
    printf '\n' >> "$exclude_path"
  fi

  cat >> "$exclude_path" <<'EOF'
# BEGIN OMC local artifacts
.omc/*
!.omc/skills/
!.omc/skills/**
# END OMC local artifacts
EOF

  echo "Configured git exclude for local .omc artifacts (preserving .omc/skills/)"
}

# Determine target path
CONFIG_DIR="$(resolve_claude_config_dir)"
if [ "$MODE" = "local" ]; then
  mkdir -p .claude/skills/omc-reference
  TARGET_PATH=".claude/CLAUDE.md"
  SKILL_TARGET_PATH=".claude/skills/omc-reference/SKILL.md"
elif [ "$MODE" = "global" ]; then
  mkdir -p "$CONFIG_DIR/skills/omc-reference"
  TARGET_PATH="$CONFIG_DIR/CLAUDE.md"
  SKILL_TARGET_PATH="$CONFIG_DIR/skills/omc-reference/SKILL.md"
else
  echo "ERROR: Invalid mode '$MODE'. Use 'local' or 'global'." >&2
  exit 1
fi

if [ "$INSTALL_STYLE" != "overwrite" ] && [ "$INSTALL_STYLE" != "preserve" ]; then
  echo "ERROR: Invalid install style '$INSTALL_STYLE'. Use 'overwrite' or 'preserve'." >&2
  exit 1
fi


install_omc_reference_skill() {
  local source_label=""
  local temp_skill
  temp_skill=$(mktemp /tmp/omc-reference-skill-XXXXXX.md)

  if [ -f "$CANONICAL_OMC_REFERENCE_SKILL" ]; then
    cp "$CANONICAL_OMC_REFERENCE_SKILL" "$temp_skill"
    source_label="$CANONICAL_OMC_REFERENCE_SKILL"
  elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/skills/omc-reference/SKILL.md" ]; then
    cp "${CLAUDE_PLUGIN_ROOT}/skills/omc-reference/SKILL.md" "$temp_skill"
    source_label="${CLAUDE_PLUGIN_ROOT}/skills/omc-reference/SKILL.md"
  else
    rm -f "$temp_skill"
    echo "Skipped omc-reference skill install (canonical skill source unavailable)"
    return 0
  fi

  if [ ! -s "$temp_skill" ]; then
    rm -f "$temp_skill"
    echo "Skipped omc-reference skill install (empty canonical skill source: $source_label)"
    return 0
  fi

  mkdir -p "$(dirname "$SKILL_TARGET_PATH")"
  cp "$temp_skill" "$SKILL_TARGET_PATH"
  rm -f "$temp_skill"
  echo "Installed omc-reference skill to $SKILL_TARGET_PATH"
}

# Extract old version before download
OLD_VERSION=$(grep -m1 'OMC:VERSION:' "$TARGET_PATH" 2>/dev/null | sed -E 's/.*OMC:VERSION:([^ ]+).*/\1/' || true)
if [ -z "$OLD_VERSION" ]; then
  OLD_VERSION=$(omc --version 2>/dev/null | head -1 || true)
fi
if [ -z "$OLD_VERSION" ]; then
  OLD_VERSION="none"
fi

# Backup existing
BACKUP_DATE=""
if [ -f "$TARGET_PATH" ]; then
  BACKUP_DATE=$(date +%Y-%m-%d_%H%M%S)
  BACKUP_PATH="${TARGET_PATH}.backup.${BACKUP_DATE}"
  cp "$TARGET_PATH" "$BACKUP_PATH"
  echo "Backed up existing CLAUDE.md to $BACKUP_PATH"
fi

# Load canonical OMC content to temp file
TEMP_OMC=$(mktemp /tmp/omc-claude-XXXXXX.md)
trap 'rm -f "$TEMP_OMC"' EXIT

OMC_IMPORT_START='<!-- OMC:IMPORT:START -->'
OMC_IMPORT_END='<!-- OMC:IMPORT:END -->'
COMPANION_FILENAME='CLAUDE-omc.md'

write_wrapped_omc_file() {
  local destination="$1"
  mkdir -p "$(dirname "$destination")"
  {
    echo '<!-- OMC:START -->'
    cat "$TEMP_OMC"
    echo '<!-- OMC:END -->'
  } > "$destination"
}

ensure_managed_companion_import() {
  local target_path="$1"
  local companion_name="$2"
  local import_block
  import_block=$(cat <<EOF
$OMC_IMPORT_START
@${companion_name}
$OMC_IMPORT_END
EOF
)

  if grep -Fq "$OMC_IMPORT_START" "$target_path"; then
    perl -0pe 's/^<!-- OMC:IMPORT:START -->\R[\s\S]*?^<!-- OMC:IMPORT:END -->(?:\R)?//msg' "$target_path" > "${target_path}.importless"
    mv "${target_path}.importless" "$target_path"
  fi

  if [ -s "$target_path" ]; then
    printf '\n\n%s\n' "$import_block" >> "$target_path"
  else
    printf '%s\n' "$import_block" > "$target_path"
  fi
}

ensure_not_symlink_path() {
  local target_path="$1"
  local label="$2"

  if [ -L "$target_path" ]; then
    echo "ERROR: Refusing to write $label because the destination is a symlink: $target_path" >&2
    exit 1
  fi
}

VALIDATION_PATH="$TARGET_PATH"

SOURCE_LABEL=""
if [ -f "$CANONICAL_CLAUDE_MD" ]; then
  cp "$CANONICAL_CLAUDE_MD" "$TEMP_OMC"
  SOURCE_LABEL="$CANONICAL_CLAUDE_MD"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/docs/CLAUDE.md" ]; then
  cp "${CLAUDE_PLUGIN_ROOT}/docs/CLAUDE.md" "$TEMP_OMC"
  SOURCE_LABEL="${CLAUDE_PLUGIN_ROOT}/docs/CLAUDE.md"
else
  curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_OMC"
  SOURCE_LABEL="$DOWNLOAD_URL"
fi

if [ ! -s "$TEMP_OMC" ]; then
  echo "ERROR: Failed to download CLAUDE.md. Aborting."
  echo "FALLBACK: Manually download from: $DOWNLOAD_URL"
  rm -f "$TEMP_OMC"
  exit 1
fi

if ! grep -q '<!-- OMC:START -->' "$TEMP_OMC" || ! grep -q '<!-- OMC:END -->' "$TEMP_OMC"; then
  echo "ERROR: Canonical CLAUDE.md source is missing required OMC markers: $SOURCE_LABEL" >&2
  echo "Refusing to install a summarized or malformed CLAUDE.md." >&2
  exit 1
fi

# Strip existing markers from downloaded content (idempotency)
# Use awk for cross-platform compatibility (GNU/BSD)
if grep -q '<!-- OMC:START -->' "$TEMP_OMC"; then
  awk '/<!-- OMC:END -->/{p=0} p; /<!-- OMC:START -->/{p=1}' "$TEMP_OMC" > "${TEMP_OMC}.clean"
  mv "${TEMP_OMC}.clean" "$TEMP_OMC"
fi

if [ ! -f "$TARGET_PATH" ]; then
  # Fresh install: wrap in markers
  write_wrapped_omc_file "$TARGET_PATH"
  rm -f "$TEMP_OMC"
  echo "Installed CLAUDE.md (fresh)"
else
  # Merge: preserve user content outside OMC markers
  if grep -q '<!-- OMC:START -->' "$TARGET_PATH"; then
    # Has markers: remove ALL complete OMC blocks, preserve only real user text
    # Use perl -0 for a global multiline regex replace (portable across GNU/BSD environments)
    perl -0pe 's/^<!-- OMC:START -->\R[\s\S]*?^<!-- OMC:END -->(?:\R)?//msg; s/^<!-- User customizations(?: \([^)]+\))? -->\R?//mg; s/\A(?:[ \t]*\R)+//; s/(?:\R[ \t]*)+\z//;' \
      "$TARGET_PATH" > "${TARGET_PATH}.preserved"

    if grep -Eq '^<!-- OMC:(START|END) -->$' "${TARGET_PATH}.preserved"; then
      # Corrupted/unmatched markers remain: preserve the whole original file for manual recovery
      OLD_CONTENT=$(cat "$TARGET_PATH")
      {
        echo '<!-- OMC:START -->'
        cat "$TEMP_OMC"
        echo '<!-- OMC:END -->'
        echo ""
        echo "<!-- User customizations (recovered from corrupted markers) -->"
        printf '%s\n' "$OLD_CONTENT"
      } > "${TARGET_PATH}.tmp"
    else
      PRESERVED_CONTENT=$(cat "${TARGET_PATH}.preserved")
      {
        echo '<!-- OMC:START -->'
        cat "$TEMP_OMC"
        echo '<!-- OMC:END -->'
        if printf '%s' "$PRESERVED_CONTENT" | grep -q '[^[:space:]]'; then
          echo ""
          echo "<!-- User customizations -->"
          printf '%s\n' "$PRESERVED_CONTENT"
        fi
      } > "${TARGET_PATH}.tmp"
    fi

    mv "${TARGET_PATH}.tmp" "$TARGET_PATH"
    rm -f "${TARGET_PATH}.preserved"
    echo "Updated OMC section (user customizations preserved)"
  elif [ "$MODE" = "global" ] && [ "$INSTALL_STYLE" = "preserve" ]; then
    COMPANION_TARGET_PATH="$CONFIG_DIR/$COMPANION_FILENAME"
    ensure_not_symlink_path "$COMPANION_TARGET_PATH" "OMC companion CLAUDE.md"
    ensure_not_symlink_path "$TARGET_PATH" "base CLAUDE.md import block"
    if [ -f "$COMPANION_TARGET_PATH" ] && [ -n "$BACKUP_DATE" ]; then
      cp "$COMPANION_TARGET_PATH" "${COMPANION_TARGET_PATH}.backup.${BACKUP_DATE}"
      echo "Backed up existing companion CLAUDE.md to ${COMPANION_TARGET_PATH}.backup.${BACKUP_DATE}"
    fi
    write_wrapped_omc_file "$COMPANION_TARGET_PATH"
    ensure_managed_companion_import "$TARGET_PATH" "$COMPANION_FILENAME"
    VALIDATION_PATH="$COMPANION_TARGET_PATH"
    echo "Installed OMC companion file and preserved existing CLAUDE.md"
  else
    # No markers: wrap new content in markers, append old content as user section
    # Strip any preserve-mode import block left by a prior preserve install
    if grep -Fq "$OMC_IMPORT_START" "$TARGET_PATH"; then
      perl -0pe 's/^<!-- OMC:IMPORT:START -->\R[\s\S]*?^<!-- OMC:IMPORT:END -->(?:\R)?//msg' "$TARGET_PATH" > "${TARGET_PATH}.importless"
      mv "${TARGET_PATH}.importless" "$TARGET_PATH"
    fi
    OLD_CONTENT=$(cat "$TARGET_PATH")
    {
      echo '<!-- OMC:START -->'
      cat "$TEMP_OMC"
      echo '<!-- OMC:END -->'
      echo ""
      echo "<!-- User customizations (migrated from previous CLAUDE.md) -->"
      printf '%s\n' "$OLD_CONTENT"
    } > "${TARGET_PATH}.tmp"
    mv "${TARGET_PATH}.tmp" "$TARGET_PATH"
    echo "Migrated existing CLAUDE.md (added OMC markers, preserved old content)"
  fi
  rm -f "$TEMP_OMC"

  # Clean up orphaned companion file from a prior preserve-mode install.
  # If left behind, prepareOmcLaunchConfigDir reads stale companion content
  # instead of the freshly-updated CLAUDE.md during omc launches.
  if [ "$MODE" = "global" ] && [ "$INSTALL_STYLE" = "overwrite" ]; then
    COMPANION_TARGET_PATH="$CONFIG_DIR/$COMPANION_FILENAME"
    if [ -f "$COMPANION_TARGET_PATH" ]; then
      if [ -n "$BACKUP_DATE" ]; then
        cp "$COMPANION_TARGET_PATH" "${COMPANION_TARGET_PATH}.backup.${BACKUP_DATE}"
      fi
      rm -f "$COMPANION_TARGET_PATH"
      echo "Removed orphaned companion file from prior preserve-mode install"
    fi
  fi
fi

if ! grep -q '<!-- OMC:START -->' "$VALIDATION_PATH" || ! grep -q '<!-- OMC:END -->' "$VALIDATION_PATH"; then
  echo "ERROR: Installed CLAUDE.md is missing required OMC markers: $VALIDATION_PATH" >&2
  exit 1
fi

install_omc_reference_skill

if [ "$MODE" = "local" ]; then
  ensure_local_omc_git_exclude
fi

# Extract new version and report
NEW_VERSION=$(grep -m1 'OMC:VERSION:' "$VALIDATION_PATH" 2>/dev/null | sed -E 's/.*OMC:VERSION:([^ ]+).*/\1/' || true)
if [ -z "$NEW_VERSION" ]; then
  NEW_VERSION=$(omc --version 2>/dev/null | head -1 || true)
fi
if [ -z "$NEW_VERSION" ]; then
  NEW_VERSION="unknown"
fi
if [ "$OLD_VERSION" = "none" ]; then
  echo "Installed CLAUDE.md: $NEW_VERSION"
elif [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  echo "CLAUDE.md unchanged: $NEW_VERSION"
else
  echo "Updated CLAUDE.md: $OLD_VERSION -> $NEW_VERSION"
fi

# Legacy hooks cleanup (global mode only)
if [ "$MODE" = "global" ]; then
  rm -f "$CONFIG_DIR/hooks/keyword-detector.sh"
  rm -f "$CONFIG_DIR/hooks/stop-continuation.sh"
  rm -f "$CONFIG_DIR/hooks/persistent-mode.sh"
  rm -f "$CONFIG_DIR/hooks/session-start.sh"
  echo "Legacy hooks cleaned"

  # Check for manual hook entries in settings.json
  SETTINGS_FILE="$CONFIG_DIR/settings.json"
  if [ -f "$SETTINGS_FILE" ]; then
    if jq -e '.hooks' "$SETTINGS_FILE" > /dev/null 2>&1; then
      echo ""
      echo "NOTE: Found legacy hooks in settings.json. These should be removed since"
      echo "the plugin now provides hooks automatically. Remove the \"hooks\" section"
      echo "from $SETTINGS_FILE to prevent duplicate hook execution."
    fi
  fi
fi

# Verify plugin installation
if [ -f "$CONFIG_DIR/settings.json" ] && grep -q "oh-my-claudecode" "$CONFIG_DIR/settings.json"; then
  echo "Plugin verified"
else
  echo "Plugin NOT found - run: claude /install-plugin oh-my-claudecode"
fi
