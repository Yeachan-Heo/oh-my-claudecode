#!/usr/bin/env bash
# sync-version.sh — called by npm "version" lifecycle hook
# Syncs the version from package.json to all satellite files:
#   - .claude-plugin/plugin.json
#   - .claude-plugin/marketplace.json
#   - docs/CLAUDE.md (OMC:VERSION marker)
#
# Usage: automatically invoked by `npm version <bump>`
#        or manually: ./scripts/sync-version.sh [version]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"

echo "🔄 Syncing version $VERSION to satellite files..."

# 1. .claude-plugin/plugin.json
PLUGIN="$ROOT/.claude-plugin/plugin.json"
if [ -f "$PLUGIN" ]; then
  perl -i -pe "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$PLUGIN"
  echo "  ✓ plugin.json → $VERSION"
fi

# 2. .claude-plugin/marketplace.json (has 2 version fields)
MARKET="$ROOT/.claude-plugin/marketplace.json"
if [ -f "$MARKET" ]; then
  perl -i -pe "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/g" "$MARKET"
  echo "  ✓ marketplace.json → $VERSION"
fi

# 3. docs/CLAUDE.md version marker
CLAUDE_MD="$ROOT/docs/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  perl -i -pe "s/<!-- OMC:VERSION:[^ ]* -->/<!-- OMC:VERSION:$VERSION -->/" "$CLAUDE_MD"
  echo "  ✓ docs/CLAUDE.md → $VERSION"
fi

# Stage the changed files so they're included in the version commit
git add "$PLUGIN" "$MARKET" "$CLAUDE_MD" 2>/dev/null || true

echo "✅ Version sync complete: $VERSION"
