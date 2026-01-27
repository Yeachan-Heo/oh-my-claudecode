---
description: One-time setup for oh-my-claudecode (the ONLY command you need to learn)
---

# OMC Setup

This is the **only command you need to learn**. After running this, everything else is automatic.

## Graceful Interrupt Handling

**IMPORTANT**: This setup process saves progress after each step. If interrupted (Ctrl+C or connection loss), the setup can resume from where it left off.

### Resume Detection (Step 0)

Before starting any step, check for existing state:

```bash
# Check for existing setup state
STATE_FILE=".omc/state/setup-state.json"
if [ -f "$STATE_FILE" ]; then
  LAST_STEP=$(cat "$STATE_FILE" | grep -oE '"lastCompletedStep":\s*[0-9]+' | grep -oE '[0-9]+' || echo "0")
  TIMESTAMP=$(cat "$STATE_FILE" | grep -oE '"timestamp":\s*"[^"]+"' | cut -d'"' -f4 || echo "unknown")
  echo "Found previous setup session (Step $LAST_STEP completed at $TIMESTAMP)"
fi
```

If state exists, use AskUserQuestion to prompt:

**Question:** "Found a previous setup session. Would you like to resume or start fresh?"

**Options:**
1. **Resume from step $LAST_STEP** - Continue where you left off
2. **Start fresh** - Begin from the beginning (clears saved state)

If user chooses "Start fresh":
```bash
rm -f ".omc/state/setup-state.json"
echo "Previous state cleared. Starting fresh setup."
```

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

# Download fresh CLAUDE.md from GitHub
curl -fsSL "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md" -o .claude/CLAUDE.md && \
echo "Downloaded CLAUDE.md to .claude/CLAUDE.md"
```

### If User Chooses GLOBAL:

```bash
# Download fresh CLAUDE.md to global config
curl -fsSL "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md" -o ~/.claude/CLAUDE.md && \
echo "Downloaded CLAUDE.md to ~/.claude/CLAUDE.md"
```

## Step 3: Setup HUD Statusline

The HUD shows real-time status in Claude Code's status bar. **Invoke the hud skill** to set up and configure:

Use the Skill tool to invoke: `hud` with args: `setup`

This will:
1. Install the HUD wrapper script to `~/.claude/hud/omc-hud.mjs`
2. Configure `statusLine` in `~/.claude/settings.json`
3. Report status and prompt to restart if needed

## Step 3.5: Verify Plugin Build

The HUD requires the plugin to be built (dist/ directory). The dist/ folder is NOT included in git - it's generated when the plugin is installed via npm.

Check if the plugin is installed and built:

```bash
# Find the installed plugin version
PLUGIN_DIR="$HOME/.claude/plugins/cache/omc/oh-my-claudecode"
if [ -d "$PLUGIN_DIR" ]; then
  PLUGIN_VERSION=$(ls "$PLUGIN_DIR" 2>/dev/null | sort -V | tail -1)
  if [ -n "$PLUGIN_VERSION" ]; then
    # Check if dist/hud/index.js exists
    if [ ! -f "$PLUGIN_DIR/$PLUGIN_VERSION/dist/hud/index.js" ]; then
      echo "Plugin not built - building now..."
      cd "$PLUGIN_DIR/$PLUGIN_VERSION" && npm install
      if [ -f "dist/hud/index.js" ]; then
        echo "Build successful - HUD is ready"
      else
        echo "Build failed - HUD may not work correctly"
      fi
    else
      echo "Plugin already built - HUD is ready"
    fi
  else
    echo "Plugin version not found"
  fi
else
  echo "Plugin not installed - install with: claude /install-plugin oh-my-claudecode"
fi
```

**Note:** The `npm install` command triggers the `prepare` script which runs `npm run build`, creating the dist/ directory with all compiled HUD files.

## Step 3.6: Install CLI Analytics Tools (Optional)

The OMC CLI provides standalone token analytics commands (`omc stats`, `omc agents`, `omc backfill`, `omc tui`).

Ask user: "Would you like to install the OMC CLI for standalone analytics? (Recommended for tracking token usage and costs)"

**Options:**
1. **Yes (Recommended)** - Install CLI tools globally for `omc stats`, `omc agents`, etc.
2. **No** - Skip CLI installation, use only plugin skills

### If User Chooses YES:

```bash
# Check for bun (preferred) or npm
if command -v bun &> /dev/null; then
  echo "Installing OMC CLI via bun..."
  bun install -g oh-my-claude-sisyphus
elif command -v npm &> /dev/null; then
  echo "Installing OMC CLI via npm..."
  npm install -g oh-my-claude-sisyphus
else
  echo "ERROR: Neither bun nor npm found. Please install Node.js or Bun first."
  exit 1
fi

# Verify installation
if command -v omc &> /dev/null; then
  echo "✓ OMC CLI installed successfully!"
  echo "  Try: omc stats, omc agents, omc backfill"
else
  echo "⚠ CLI installed but 'omc' not in PATH."
  echo "  You may need to restart your terminal or add npm/bun global bin to PATH."
fi
```

### If User Chooses NO:

Skip this step. User can install later with `npm install -g oh-my-claude-sisyphus`.

## Step 4: Verify Plugin Installation

```bash
grep -q "oh-my-claudecode" ~/.claude/settings.json && echo "Plugin verified" || echo "Plugin NOT found - run: claude /install-plugin oh-my-claudecode"
```

## Step 5: Offer MCP Server Configuration

MCP servers extend Claude Code with additional tools (web search, GitHub, etc.).

Ask user: "Would you like to configure MCP servers for enhanced capabilities? (Context7, Exa search, GitHub, etc.)"

If yes, invoke the mcp-setup skill:
```
/oh-my-claudecode:mcp-setup
```

If no, skip to next step.

## Step 6: Detect Upgrade from 2.x

Check if user has existing configuration:
```bash
# Check for existing 2.x artifacts
ls ~/.claude/commands/ralph-loop.md 2>/dev/null || ls ~/.claude/commands/ultrawork.md 2>/dev/null
```

If found, this is an upgrade from 2.x.

## Step 7: Show Welcome Message

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

MCP SERVERS:
Run /oh-my-claudecode:mcp-setup to add tools like web search, GitHub, etc.

HUD STATUSLINE:
The status bar now shows OMC state. Restart Claude Code to see it.

CLI ANALYTICS (if installed):
- omc           - Full dashboard (stats + agents + cost)
- omc stats     - View token usage and costs
- omc agents    - See agent breakdown by cost
- omc tui       - Launch interactive TUI dashboard

That's it! Just use Claude Code normally.
```

### For Users Upgrading from 2.x:

```
OMC Setup Complete! (Upgraded from 2.x)

GOOD NEWS: Your existing commands still work!
- /ralph, /ultrawork, /plan, etc. all still function

WHAT'S NEW in 3.0:
You no longer NEED those commands. Everything is automatic now:
- Just say "don't stop until done" instead of /ralph
- Just say "fast" or "parallel" instead of /ultrawork
- Just say "plan this" instead of /plan
- Just say "stop" instead of /cancel

MAGIC KEYWORDS (power-user shortcuts):
| Keyword | Same as old... | Example |
|---------|----------------|---------|
| ralph | /ralph | "ralph: fix the bug" |
| ralplan | /ralplan | "ralplan this feature" |
| ulw | /ultrawork | "ulw refactor API" |
| plan | /plan | "plan the endpoints" |

HUD STATUSLINE:
The status bar now shows OMC state. Restart Claude Code to see it.

CLI ANALYTICS (if installed):
- omc           - Full dashboard (stats + agents + cost)
- omc stats     - View token usage and costs
- omc agents    - See agent breakdown by cost
- omc tui       - Launch interactive TUI dashboard

Your workflow won't break - it just got easier!
```

## Fallback

If curl fails, tell user to manually download from:
https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md
