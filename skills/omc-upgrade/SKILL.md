---
name: omc-upgrade
description: Upgrade oh-my-claudecode plugin to the latest version (fixes Claude Code plugin resolver caching issue)
---

# OMC Upgrade Skill

## Purpose

Fixes the plugin upgrade issue where clearing cache + restart doesn't fetch the latest version (Issue #411).

Claude Code's plugin resolver sometimes caches old versions. This skill bypasses the resolver by:

1. Downloading the package directly from npm
2. Installing to the plugin cache manually
3. Building the plugin
4. Cleaning up old versions

## When to Use

- User says "upgrade omc", "update plugin", "get latest version"
- User reports being stuck on an old version after clearing cache
- User wants to force reinstall the plugin
- `/oh-my-claudecode:omc-upgrade` is invoked

## Execution Steps

### Step 1: Check Versions

First, check the current installed version vs latest available:

```bash
# Current installed version
CURRENT=$(ls ~/.claude/plugins/cache/omc/oh-my-claudecode/ 2>/dev/null | sort -V | tail -1)
echo "Current: ${CURRENT:-not installed}"

# Latest from npm
LATEST=$(npm view oh-my-claude-sisyphus version 2>/dev/null)
echo "Latest: $LATEST"
```

Report to user:

- If CURRENT equals LATEST: "You're on the latest version. Use --force to reinstall."
- If CURRENT is empty: "No version installed. Proceeding with fresh install."
- Otherwise: "Update available: {CURRENT} -> {LATEST}"

### Step 2: Download Package

```bash
# Create temp directory
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# Download latest package from npm
npm pack oh-my-claude-sisyphus@latest

# Get tarball name
TARBALL=$(ls oh-my-claude-sisyphus-*.tgz)
echo "Downloaded: $TARBALL"
```

### Step 3: Extract to Plugin Cache

```bash
# Extract version from tarball name
VERSION=$(echo "$TARBALL" | sed 's/oh-my-claude-sisyphus-\(.*\)\.tgz/\1/')
PLUGIN_DIR="$HOME/.claude/plugins/cache/omc/oh-my-claudecode/$VERSION"

# Create directory and extract
mkdir -p "$PLUGIN_DIR"
tar -xzf "$TARBALL" -C "$PLUGIN_DIR" --strip-components=1

echo "Extracted to: $PLUGIN_DIR"
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
# Remove all versions except the newly installed one
CACHE_DIR="$HOME/.claude/plugins/cache/omc/oh-my-claudecode"

for old_version in $(ls "$CACHE_DIR" 2>/dev/null | grep -v "^${VERSION}$"); do
  echo "Removing old version: $old_version"
  rm -rf "$CACHE_DIR/$old_version"
done

# Clean temp directory
rm -rf "$TEMP_DIR"
```

### Step 6: Verify and Report

```bash
# Verify build artifacts exist
if [ -f "$PLUGIN_DIR/dist/hud/index.js" ]; then
  echo ""
  echo "SUCCESS: Upgraded to version $VERSION"
  echo ""
  echo "Please restart Claude Code to use the new version."
else
  echo "ERROR: Build verification failed"
  exit 1
fi
```

## Flags

| Flag      | Description                                       |
| --------- | ------------------------------------------------- |
| `--force` | Force reinstall even if already on latest version |
| `--check` | Only check for updates, don't install             |

## Example Usage

```
/oh-my-claudecode:omc-upgrade           # Upgrade to latest
/oh-my-claudecode:omc-upgrade --check   # Check for updates only
/oh-my-claudecode:omc-upgrade --force   # Force reinstall
```

## Troubleshooting

### npm pack fails

If `npm pack` fails, it might be a network issue. Try:

```bash
npm cache clean --force
npm pack oh-my-claude-sisyphus@latest
```

### Build fails

If `npm run build` fails, check Node.js version:

```bash
node --version  # Should be 18+
```

### Permission errors

If permission denied errors occur:

```bash
# Check ownership
ls -la ~/.claude/plugins/cache/omc/

# Fix if needed (run as your user, not root)
sudo chown -R $(whoami) ~/.claude/plugins/
```

## Output Example

Successful upgrade:

```
OMC Upgrade
===========

Current: 3.9.3
Latest:  3.10.4

Upgrading from 3.9.3 to 3.10.4...

Downloading oh-my-claude-sisyphus@3.10.4...
Extracting to plugin cache...
Installing dependencies...
Building plugin...
Removing old version: 3.9.3

SUCCESS: Upgraded to version 3.10.4

Please restart Claude Code to use the new version.
```

## Related

- Issue #411: Plugin upgrade is painful
- `/oh-my-claudecode:doctor` - Diagnose installation issues
- `/oh-my-claudecode:omc-setup` - Initial setup wizard
