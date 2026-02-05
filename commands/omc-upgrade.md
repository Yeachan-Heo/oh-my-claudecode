---
description: Upgrade oh-my-claudecode plugin to the latest version
---

# OMC Upgrade

## Task: Upgrade Plugin to Latest Version

This command fixes the Claude Code plugin resolver issue where clearing cache doesn't fetch the latest version.

### Step 1: Check Current vs Latest Version

```bash
# Get current installed version
CURRENT=$(ls ~/.claude/plugins/cache/omc/oh-my-claudecode/ 2>/dev/null | sort -V | tail -1)
echo "Current installed: ${CURRENT:-none}"

# Get latest version from npm registry
LATEST=$(npm view oh-my-claude-sisyphus version 2>/dev/null)
echo "Latest available: $LATEST"
```

If CURRENT equals LATEST, inform user they're already on the latest version and ask if they want to force reinstall.

### Step 2: Download Latest Package

```bash
# Create temp directory
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# Download the latest package
npm pack oh-my-claude-sisyphus@latest

# Get the downloaded filename
TARBALL=$(ls oh-my-claude-sisyphus-*.tgz)
echo "Downloaded: $TARBALL"
```

### Step 3: Install to Plugin Cache

```bash
# Get version from tarball name (e.g., oh-my-claude-sisyphus-3.10.4.tgz -> 3.10.4)
VERSION=$(echo "$TARBALL" | sed 's/oh-my-claude-sisyphus-\(.*\)\.tgz/\1/')
PLUGIN_DIR="$HOME/.claude/plugins/cache/omc/oh-my-claudecode/$VERSION"

# Create plugin directory
mkdir -p "$PLUGIN_DIR"

# Extract package
tar -xzf "$TARBALL" -C "$PLUGIN_DIR" --strip-components=1

echo "Installed to: $PLUGIN_DIR"
```

### Step 4: Install Production Dependencies

The npm package ships with pre-built `dist/` files, so no build step is needed.
Only install production runtime dependencies (skip devDependencies and prepare script):

```bash
cd "$PLUGIN_DIR"

# Install production dependencies only, skip prepare/build scripts
npm install --production --ignore-scripts

echo "Dependencies installed"
```

### Step 5: Clean Up Old Versions

```bash
# Remove old versions from cache (keep only latest)
CACHE_DIR="$HOME/.claude/plugins/cache/omc/oh-my-claudecode"
cd "$CACHE_DIR"

# List all versions except the one we just installed
for old_version in $(ls | grep -v "^${VERSION}$"); do
  echo "Removing old version: $old_version"
  rm -rf "$old_version"
done

# Clean up temp directory
rm -rf "$TEMP_DIR"
```

### Step 6: Verify Installation

```bash
# Check the installed version has built dist
if [ -f "$PLUGIN_DIR/dist/hud/index.js" ]; then
  echo "SUCCESS: Plugin upgraded to version $VERSION"
  echo ""
  echo "Please restart Claude Code to use the new version."
else
  echo "ERROR: Build verification failed - dist/hud/index.js not found"
fi
```

---

## Complete Upgrade Script

For convenience, here's the full script that can be run:

```bash
#!/bin/bash
set -e

echo "OMC Upgrade - Upgrading oh-my-claudecode plugin..."
echo ""

# Check latest version
LATEST=$(npm view oh-my-claude-sisyphus version 2>/dev/null)
if [ -z "$LATEST" ]; then
  echo "ERROR: Could not fetch latest version from npm"
  exit 1
fi

CURRENT=$(ls ~/.claude/plugins/cache/omc/oh-my-claudecode/ 2>/dev/null | sort -V | tail -1)
echo "Current: ${CURRENT:-none}"
echo "Latest:  $LATEST"

if [ "$CURRENT" = "$LATEST" ]; then
  echo ""
  echo "Already on latest version. Use --force to reinstall."
  exit 0
fi

echo ""
echo "Upgrading from ${CURRENT:-none} to $LATEST..."

# Create temp directory and download
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"
npm pack oh-my-claude-sisyphus@"$LATEST"
TARBALL=$(ls oh-my-claude-sisyphus-*.tgz)

# Install to plugin cache
PLUGIN_DIR="$HOME/.claude/plugins/cache/omc/oh-my-claudecode/$LATEST"
mkdir -p "$PLUGIN_DIR"
tar -xzf "$TARBALL" -C "$PLUGIN_DIR" --strip-components=1

# Install production deps (dist/ is pre-built in npm package)
cd "$PLUGIN_DIR"
npm install --production --ignore-scripts 2>/dev/null

# Clean old versions
CACHE_DIR="$HOME/.claude/plugins/cache/omc/oh-my-claudecode"
for old in $(ls "$CACHE_DIR" | grep -v "^${LATEST}$"); do
  rm -rf "$CACHE_DIR/$old"
done

# Cleanup temp
rm -rf "$TEMP_DIR"

# Verify
if [ -f "$PLUGIN_DIR/dist/hud/index.js" ]; then
  echo ""
  echo "SUCCESS: Upgraded to version $LATEST"
  echo ""
  echo "Restart Claude Code to use the new version."
else
  echo "ERROR: Build failed"
  exit 1
fi
```

---

## Flags

- `--force`: Force reinstall even if already on latest version
- `--check`: Only check for updates, don't install

---

## Output

After successful upgrade:

```
OMC Upgrade - Upgrading oh-my-claudecode plugin...

Current: 3.9.3
Latest:  3.10.4

Upgrading from 3.9.3 to 3.10.4...

SUCCESS: Upgraded to version 3.10.4

Restart Claude Code to use the new version.
```
