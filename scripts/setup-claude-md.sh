#!/usr/bin/env bash
# setup-claude-md.sh - Unified CLAUDE.md download/merge script
# Usage: setup-claude-md.sh <local|global>
#
# Handles: version extraction, backup, download, marker stripping, merge, version reporting.
# For global mode, also cleans up legacy hooks.

set -euo pipefail

MODE="${1:?Usage: setup-claude-md.sh <local|global>}"
DOWNLOAD_URL="https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md"

# Determine target path
if [ "$MODE" = "local" ]; then
  mkdir -p .claude
  TARGET_PATH=".claude/CLAUDE.md"
elif [ "$MODE" = "global" ]; then
  TARGET_PATH="$HOME/.claude/CLAUDE.md"
else
  echo "ERROR: Invalid mode '$MODE'. Use 'local' or 'global'." >&2
  exit 1
fi

# Extract old version before download
OLD_VERSION=$(grep -m1 'OMC:VERSION:' "$TARGET_PATH" 2>/dev/null | sed -E 's/.*OMC:VERSION:([^ ]+).*/\1/' || true)
if [ -z "$OLD_VERSION" ]; then
  OLD_VERSION=$(omc --version 2>/dev/null | head -1 || true)
fi
if [ -z "$OLD_VERSION" ]; then
  OLD_VERSION="none"
fi

# Backup existing
if [ -f "$TARGET_PATH" ]; then
  BACKUP_DATE=$(date +%Y-%m-%d_%H%M%S)
  BACKUP_PATH="${TARGET_PATH}.backup.${BACKUP_DATE}"
  cp "$TARGET_PATH" "$BACKUP_PATH"
  echo "Backed up existing CLAUDE.md to $BACKUP_PATH"
fi

# Download fresh OMC content to temp file
TEMP_OMC=$(mktemp /tmp/omc-claude-XXXXXX.md)
trap 'rm -f "$TEMP_OMC"' EXIT
curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_OMC"

if [ ! -s "$TEMP_OMC" ]; then
  echo "ERROR: Failed to download CLAUDE.md. Aborting."
  echo "FALLBACK: Manually download from: $DOWNLOAD_URL"
  rm -f "$TEMP_OMC"
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
  {
    echo '<!-- OMC:START -->'
    cat "$TEMP_OMC"
    echo '<!-- OMC:END -->'
  } > "$TARGET_PATH"
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
  else
    # No markers: wrap new content in markers, append old content as user section
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
fi

# Extract new version and report
NEW_VERSION=$(grep -m1 'OMC:VERSION:' "$TARGET_PATH" 2>/dev/null | sed -E 's/.*OMC:VERSION:([^ ]+).*/\1/' || true)
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
  rm -f ~/.claude/hooks/keyword-detector.sh
  rm -f ~/.claude/hooks/stop-continuation.sh
  rm -f ~/.claude/hooks/persistent-mode.sh
  rm -f ~/.claude/hooks/session-start.sh
  echo "Legacy hooks cleaned"

  # Check for manual hook entries in settings.json
  SETTINGS_FILE="$HOME/.claude/settings.json"
  if [ -f "$SETTINGS_FILE" ]; then
    if jq -e '.hooks' "$SETTINGS_FILE" > /dev/null 2>&1; then
      echo ""
      echo "NOTE: Found legacy hooks in settings.json. These should be removed since"
      echo "the plugin now provides hooks automatically. Remove the \"hooks\" section"
      echo "from ~/.claude/settings.json to prevent duplicate hook execution."
    fi
  fi
fi

# Verify plugin installation
grep -q "oh-my-claudecode" ~/.claude/settings.json && echo "Plugin verified" || echo "Plugin NOT found - run: claude /install-plugin oh-my-claudecode"
