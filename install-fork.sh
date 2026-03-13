#!/bin/bash
set -euo pipefail
FORK_DIR="$HOME/.claude/plugins/cache/omc/oh-my-claudecode-rhizo"

# Clone or update
if [ -d "$FORK_DIR" ]; then
  echo "Updating existing fork..."
  cd "$FORK_DIR"
  git stash --quiet 2>/dev/null || true
  git pull --ff-only
else
  echo "Cloning hardened fork..."
  git clone https://github.com/rhizo-co/oh-my-claudecode.git "$FORK_DIR"
  cd "$FORK_DIR"
fi

# Remove stale node_modules symlink from upstream if present
if [ -L "$FORK_DIR/node_modules" ]; then
  rm "$FORK_DIR/node_modules"
fi

# Build
echo "Installing dependencies and building..."
pnpm install && pnpm build

# Patch installed_plugins.json to point to the fork
PLUGINS_FILE="$HOME/.claude/plugins/installed_plugins.json"
if [ -f "$PLUGINS_FILE" ]; then
  python3 -c "
import json, pathlib
p = pathlib.Path('$PLUGINS_FILE')
d = json.loads(p.read_text())
entries = d.get('plugins', {}).get('oh-my-claudecode@omc', [])
for e in entries:
    e['installPath'] = '$FORK_DIR'
    e['version'] = 'rhizo-hardened'
p.write_text(json.dumps(d, indent=2))
print('Patched', len(entries), 'plugin entries')
"
else
  echo "Warning: $PLUGINS_FILE not found."
  echo "Install oh-my-claudecode from the marketplace first, then re-run this script."
  echo "  /plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode"
  echo "  /plugin install oh-my-claudecode"
  exit 1
fi

echo ""
echo "Done. Restart Claude Code to use the hardened fork."
