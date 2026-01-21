---
name: omc-setup
description: One-time setup for oh-my-claudecode (the ONLY command you need to learn)
user-invocable: true
---

# OMC Setup

This is the **only command you need to learn**. After running this, everything else is automatic.

## Step 1: Ask User Preference

Use the AskUserQuestion tool to prompt the user:

**Question:** "Where should I configure oh-my-claudecode?"

**Options:**
1. **Local (this project)** - Creates `.claude/CLAUDE.md` in current project directory. Best for project-specific configurations.
2. **Global (all projects)** - Creates `~/.claude/CLAUDE.md` for all Claude Code sessions. Best for consistent behavior everywhere.

## Step 2: Execute Based on Choice

### If User Chooses LOCAL:

```bash
# Create .claude directory in current project
mkdir -p .claude

# Extract old version before download
OLD_VERSION=$(grep -m1 "^# oh-my-claudecode" .claude/CLAUDE.md 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "none")

# Download fresh CLAUDE.md from GitHub
curl -fsSL "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md" -o .claude/CLAUDE.md && \
echo "Downloaded CLAUDE.md to .claude/CLAUDE.md"

# Extract new version and report
NEW_VERSION=$(grep -m1 "^# oh-my-claudecode" .claude/CLAUDE.md 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
if [ "$OLD_VERSION" = "none" ]; then
  echo "Installed CLAUDE.md: $NEW_VERSION"
elif [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  echo "CLAUDE.md unchanged: $NEW_VERSION"
else
  echo "Updated CLAUDE.md: $OLD_VERSION -> $NEW_VERSION"
fi
```

### If User Chooses GLOBAL:

```bash
# Extract old version before download
OLD_VERSION=$(grep -m1 "^# oh-my-claudecode" ~/.claude/CLAUDE.md 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "none")

# Download fresh CLAUDE.md to global config
curl -fsSL "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md" -o ~/.claude/CLAUDE.md && \
echo "Downloaded CLAUDE.md to ~/.claude/CLAUDE.md"

# Extract new version and report
NEW_VERSION=$(grep -m1 "^# oh-my-claudecode" ~/.claude/CLAUDE.md 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
if [ "$OLD_VERSION" = "none" ]; then
  echo "Installed CLAUDE.md: $NEW_VERSION"
elif [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  echo "CLAUDE.md unchanged: $NEW_VERSION"
else
  echo "Updated CLAUDE.md: $OLD_VERSION -> $NEW_VERSION"
fi
```

## Step 3: Setup HUD Statusline

The HUD shows real-time status in Claude Code's status bar. **Invoke the hud skill** to set up and configure:

Use the Skill tool to invoke: `hud` with args: `setup`

This will:
1. Install the HUD wrapper script to `~/.claude/hud/omc-hud.mjs`
2. Configure `statusLine` in `~/.claude/settings.json`
3. Report status and prompt to restart if needed

## Step 3.5: Clear Stale Plugin Cache

Clear old cached plugin versions to avoid conflicts:

```bash
# Clear stale plugin cache versions
CACHE_DIR="$HOME/.claude/plugins/cache/omc/oh-my-claudecode"
if [ -d "$CACHE_DIR" ]; then
  LATEST=$(ls -1 "$CACHE_DIR" | sort -V | tail -1)
  CLEARED=0
  for dir in "$CACHE_DIR"/*; do
    if [ "$(basename "$dir")" != "$LATEST" ]; then
      rm -rf "$dir"
      CLEARED=$((CLEARED + 1))
    fi
  done
  [ $CLEARED -gt 0 ] && echo "Cleared $CLEARED stale cache version(s)" || echo "Cache is clean"
else
  echo "No cache directory found (normal for new installs)"
fi
```

## Step 3.6: Check for Updates

Notify user if a newer version is available:

```bash
# Detect installed version
INSTALLED_VERSION=""

# Try cache directory first
if [ -d "$HOME/.claude/plugins/cache/omc/oh-my-claudecode" ]; then
  INSTALLED_VERSION=$(ls -1 "$HOME/.claude/plugins/cache/omc/oh-my-claudecode" | sort -V | tail -1)
fi

# Try .omc-version.json second
if [ -z "$INSTALLED_VERSION" ] && [ -f ".omc-version.json" ]; then
  INSTALLED_VERSION=$(grep -oE '"version":\s*"[^"]+' .omc-version.json | cut -d'"' -f4)
fi

# Try CLAUDE.md header third (local first, then global)
if [ -z "$INSTALLED_VERSION" ]; then
  if [ -f ".claude/CLAUDE.md" ]; then
    INSTALLED_VERSION=$(grep -m1 "^# oh-my-claudecode" .claude/CLAUDE.md 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sed 's/^v//')
  elif [ -f "$HOME/.claude/CLAUDE.md" ]; then
    INSTALLED_VERSION=$(grep -m1 "^# oh-my-claudecode" "$HOME/.claude/CLAUDE.md" 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sed 's/^v//')
  fi
fi

# Check npm for latest version
LATEST_VERSION=$(npm view oh-my-claude-sisyphus version 2>/dev/null)

if [ -n "$INSTALLED_VERSION" ] && [ -n "$LATEST_VERSION" ]; then
  # Simple version comparison (assumes semantic versioning)
  if [ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]; then
    echo ""
    echo "UPDATE AVAILABLE:"
    echo "  Installed: v$INSTALLED_VERSION"
    echo "  Latest:    v$LATEST_VERSION"
    echo ""
    echo "To update, run: claude /install-plugin oh-my-claudecode"
  else
    echo "You're on the latest version: v$INSTALLED_VERSION"
  fi
elif [ -n "$LATEST_VERSION" ]; then
  echo "Latest version available: v$LATEST_VERSION"
fi
```

## Step 4: Verify Plugin Installation

```bash
grep -q "oh-my-claudecode" ~/.claude/settings.json && echo "Plugin verified" || echo "Plugin NOT found - run: claude /install-plugin oh-my-claudecode"
```

## Step 5: Detect Upgrade from 2.x

Check if user has existing configuration:
```bash
# Check for existing 2.x artifacts
ls ~/.claude/commands/ralph-loop.md 2>/dev/null || ls ~/.claude/commands/ultrawork.md 2>/dev/null
```

If found, this is an upgrade from 2.x.

## Step 6: Show Welcome Message

### For New Users:

```
OMC Setup Complete!

You don't need to learn any commands. I now have intelligent behaviors that activate automatically.

WHAT HAPPENS AUTOMATICALLY:
- Complex tasks -> I parallelize and delegate to specialists
- "plan this" -> I start a planning interview
- "don't stop until done" -> I persist until verified complete
- "stop" or "cancel" -> I intelligently stop current operation

MAGIC KEYWORDS (optional power-user shortcuts):
Just include these words naturally in your request:

| Keyword | Effect | Example |
|---------|--------|---------|
| ralph | Persistence mode | "ralph: fix the auth bug" |
| ralplan | Iterative planning | "ralplan this feature" |
| ulw | Max parallelism | "ulw refactor the API" |
| plan | Planning interview | "plan the new endpoints" |

Combine them: "ralph ulw: migrate the database"

HUD STATUSLINE:
The status bar now shows OMC state. Restart Claude Code to see it.

That's it! Just use Claude Code normally.
```

### For Users Upgrading from 2.x:

```
OMC Setup Complete! (Upgraded from 2.x)

GOOD NEWS: Your existing commands still work!
- /ralph, /ultrawork, /planner, etc. all still function

WHAT'S NEW in 3.0:
You no longer NEED those commands. Everything is automatic now:
- Just say "don't stop until done" instead of /ralph
- Just say "fast" or "parallel" instead of /ultrawork
- Just say "plan this" instead of /planner
- Just say "stop" instead of /cancel-ralph

MAGIC KEYWORDS (power-user shortcuts):
| Keyword | Same as old... | Example |
|---------|----------------|---------|
| ralph | /ralph | "ralph: fix the bug" |
| ralplan | /ralplan | "ralplan this feature" |
| ulw | /ultrawork | "ulw refactor API" |
| plan | /planner | "plan the endpoints" |

HUD STATUSLINE:
The status bar now shows OMC state. Restart Claude Code to see it.

Your workflow won't break - it just got easier!
```

## Fallback

If curl fails, tell user to manually download from:
https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md
