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

# Cross-platform ISO date to epoch conversion
iso_to_epoch() {
  local iso_date="$1"
  local epoch=""
  # Try GNU date first (Linux)
  epoch=$(date -d "$iso_date" +%s 2>/dev/null)
  if [ $? -eq 0 ] && [ -n "$epoch" ]; then
    echo "$epoch"
    return 0
  fi
  # Try BSD/macOS date
  local clean_date=$(echo "$iso_date" | sed 's/[+-][0-9][0-9]:[0-9][0-9]$//' | sed 's/Z$//' | sed 's/T/ /')
  epoch=$(date -j -f "%Y-%m-%d %H:%M:%S" "$clean_date" +%s 2>/dev/null)
  if [ $? -eq 0 ] && [ -n "$epoch" ]; then
    echo "$epoch"
    return 0
  fi
  echo "0"
}

if [ -f "$STATE_FILE" ]; then
  # Check if state is stale (older than 24 hours)
  TIMESTAMP_RAW=$(jq -r '.timestamp // empty' "$STATE_FILE" 2>/dev/null)
  if [ -n "$TIMESTAMP_RAW" ]; then
    TIMESTAMP_EPOCH=$(iso_to_epoch "$TIMESTAMP_RAW")
    NOW_EPOCH=$(date +%s)
    STATE_AGE=$((NOW_EPOCH - TIMESTAMP_EPOCH))
  else
    STATE_AGE=999999  # Force fresh start if no timestamp
  fi
  if [ "$STATE_AGE" -gt 86400 ]; then
    echo "Previous setup state is more than 24 hours old. Starting fresh."
    rm -f "$STATE_FILE"
  else
    LAST_STEP=$(jq -r ".lastCompletedStep // 0" "$STATE_FILE" 2>/dev/null || echo "0")
    TIMESTAMP=$(jq -r .timestamp "$STATE_FILE" 2>/dev/null || echo "unknown")
    echo "Found previous setup session (Step $LAST_STEP completed at $TIMESTAMP)"
  fi
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

## Step 3.5: Install CLI Analytics Tools (Optional)

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
  # Clean up npm version if it exists to avoid duplicates
  if command -v npm &> /dev/null && npm list -g oh-my-claude-sisyphus &>/dev/null; then
    echo "Removing existing npm installation to avoid duplicates..."
    npm uninstall -g oh-my-claude-sisyphus 2>/dev/null
  fi
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

Skip this step. User can install later with `bun install -g oh-my-claude-sisyphus` or `npm install -g oh-my-claude-sisyphus`.

## Step 4: Verify Plugin Installation

```bash
grep -q "oh-my-claudecode" ~/.claude/settings.json && echo "Plugin verified" || echo "Plugin NOT found - run: claude /install-plugin oh-my-claudecode"
```

## Step 4.5: Install AST Tools (Optional)

The plugin includes AST-aware code search and transformation tools (`ast_grep_search`, `ast_grep_replace`) that require `@ast-grep/napi`.

Ask user: "Would you like to install AST tools for advanced code search? (Pattern-based AST matching across 17 languages)"

**Options:**
1. **Yes (Recommended)** - Install `@ast-grep/napi` for AST-powered search/replace
2. **No** - Skip, AST tools will show helpful error when used

### If User Chooses YES:

```bash
# Check for bun (preferred) or npm
if command -v bun &> /dev/null; then
  PKG_MANAGER="bun"
  echo "Installing @ast-grep/napi via bun..."
  # Clean up npm version if it exists to avoid duplicates
  if command -v npm &> /dev/null && npm list -g @ast-grep/napi &>/dev/null; then
    echo "Removing existing npm installation to avoid duplicates..."
    npm uninstall -g @ast-grep/napi 2>/dev/null
  fi
  bun install -g @ast-grep/napi
elif command -v npm &> /dev/null; then
  PKG_MANAGER="npm"
  echo "Installing @ast-grep/napi via npm..."
  npm install -g @ast-grep/napi
else
  echo "ERROR: Neither bun nor npm found. Please install Node.js or Bun first."
  exit 1
fi

# Verify installation
if [ "$PKG_MANAGER" = "bun" ]; then
  if bun pm ls -g 2>/dev/null | grep -q "@ast-grep/napi"; then
    echo "✓ AST tools installed successfully via bun!"
    echo "  Available tools: ast_grep_search, ast_grep_replace"
    echo "  Supports: JavaScript, TypeScript, Python, Go, Rust, Java, and 11 more languages"
  else
    echo "⚠ Installation may have failed. You can install later with: bun install -g @ast-grep/napi"
  fi
else
  if npm list -g @ast-grep/napi &>/dev/null; then
    echo "✓ AST tools installed successfully via npm!"
    echo "  Available tools: ast_grep_search, ast_grep_replace"
    echo "  Supports: JavaScript, TypeScript, Python, Go, Rust, Java, and 11 more languages"
  else
    echo "⚠ Installation may have failed. You can install later with: npm install -g @ast-grep/napi"
  fi
fi
```

### If User Chooses NO:

Skip this step. AST tools will gracefully degrade with a helpful installation message when used.

## Step 5: Offer MCP Server Configuration

MCP servers extend Claude Code with additional tools (web search, GitHub, etc.).

Ask user: "Would you like to configure MCP servers for enhanced capabilities? (Context7, Exa search, GitHub, etc.)"

If yes, invoke the mcp-setup skill:
```
/oh-my-claudecode:mcp-setup
```

If no, skip to next step.

## Step 5.5: Configure Agent Teams (Optional)

Agent teams are an experimental Claude Code feature that spawns N coordinated agents on a shared task list with inter-agent messaging. **Disabled by default** — requires enabling in `settings.json`.

Reference: https://code.claude.com/docs/en/agent-teams

Ask user: "Would you like to enable agent teams? (experimental Claude Code feature)"

**Options:**
1. **Yes, enable teams (Recommended)** - Enable the experimental feature and configure defaults
2. **No, skip** - Leave teams disabled (can enable later)

### If User Chooses YES:

#### 5.5.1: Enable in settings.json

**CRITICAL**: Must preserve existing user settings. Read `~/.claude/settings.json` first, then merge the teams env var.

```bash
SETTINGS_FILE="$HOME/.claude/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
  # Merge env var into existing settings, preserving everything else
  TEMP_FILE=$(mktemp)
  jq '.env = (.env // {} | . + {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"})' "$SETTINGS_FILE" > "$TEMP_FILE" && mv "$TEMP_FILE" "$SETTINGS_FILE"
  echo "Added CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS to existing settings.json"
else
  # Create new settings.json
  mkdir -p "$(dirname "$SETTINGS_FILE")"
  cat > "$SETTINGS_FILE" << 'SETTINGS_EOF'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
SETTINGS_EOF
  echo "Created settings.json with teams enabled"
fi
```

Prefer the Edit tool over jq when possible to preserve formatting.

#### 5.5.2: Configure Teammate Display Mode

Ask: "How should teammates be displayed?"

1. **Auto (Recommended)** - Split panes in tmux, otherwise in-process
2. **In-process** - All in main terminal, Shift+Up/Down to select
3. **Split panes (tmux)** - Each teammate in own pane, requires tmux/iTerm2

If not "Auto", add `teammateMode` to settings.json:

```bash
jq --arg mode "TEAMMATE_MODE" '. + {teammateMode: $mode}' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
```

#### 5.5.3: Configure Team Defaults

Ask three questions:

1. **Default team size?** → 3 agents (Recommended) / 5 agents (maximum) / 2 agents
2. **Default agent type?** → executor (Recommended) / build-fixer / designer
3. **Default model?** → sonnet (Recommended) / opus / haiku

Store in `~/.claude/.omc-config.json`:

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi

echo "$EXISTING" | jq \
  --argjson maxAgents MAX_AGENTS \
  --arg agentType "AGENT_TYPE" \
  --arg model "MODEL" \
  '. + {team: {maxAgents: $maxAgents, defaultAgentType: $agentType, defaultModel: $model, monitorIntervalMs: 30000, shutdownTimeoutMs: 15000}}' > "$CONFIG_FILE"
```

#### Verify settings.json

```bash
jq empty "$SETTINGS_FILE" 2>/dev/null && echo "settings.json: valid" || echo "ERROR: invalid JSON!"
jq -e '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' "$SETTINGS_FILE" > /dev/null 2>&1 && echo "Agent teams: ENABLED" || echo "WARNING: not enabled"
```

### If User Chooses NO:

Skip. Teams remain disabled. Enable later by adding to `~/.claude/settings.json`:
```json
{ "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
```

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
| team | Coordinated agents | "/team 3:executor fix errors" |

**ralph includes ultrawork:** When you activate ralph mode, it automatically includes ultrawork's parallel execution. No need to combine keywords.

TEAMS:
Spawn coordinated agents with shared task lists and real-time messaging:
- /oh-my-claudecode:team 3:executor "fix all TypeScript errors"
- /oh-my-claudecode:team 5:build-fixer "fix build errors in src/"
Teams use Claude Code native tools (TeamCreate/SendMessage/TaskCreate).

MCP SERVERS:
Run /oh-my-claudecode:mcp-setup to add tools like web search, GitHub, etc.

HUD STATUSLINE:
The status bar now shows OMC state. Restart Claude Code to see it.

CLI ANALYTICS (if installed):
- omc           - Full dashboard (stats + agents + cost)
- omc stats     - View token usage and costs
- omc agents    - See agent breakdown by cost
- omc tui       - Launch interactive TUI dashboard

AST TOOLS (if installed):
- ast_grep_search  - Pattern-based AST code search
- ast_grep_replace - AST-aware code transformations
- Supports 17 languages including TS, Python, Go, Rust

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
| team | (new!) | "/team 3:executor fix errors" |

TEAMS (NEW!):
Spawn coordinated agents with shared task lists and real-time messaging:
- /oh-my-claudecode:team 3:executor "fix all TypeScript errors"
- Uses Claude Code native tools (TeamCreate/SendMessage/TaskCreate)

HUD STATUSLINE:
The status bar now shows OMC state. Restart Claude Code to see it.

CLI ANALYTICS (if installed):
- omc           - Full dashboard (stats + agents + cost)
- omc stats     - View token usage and costs
- omc agents    - See agent breakdown by cost
- omc tui       - Launch interactive TUI dashboard

Your workflow won't break - it just got easier!
```

## Step 8: Ask About Starring Repository

First, check if `gh` CLI is available and authenticated:

```bash
gh auth status &>/dev/null
```

### If gh is available and authenticated:

Use the AskUserQuestion tool to prompt the user:

**Question:** "If you're enjoying oh-my-claudecode, would you like to support the project by starring it on GitHub?"

**Options:**
1. **Yes, star it!** - Star the repository
2. **No thanks** - Skip without further prompts
3. **Maybe later** - Skip without further prompts

If user chooses "Yes, star it!":

```bash
gh api -X PUT /user/starred/Yeachan-Heo/oh-my-claudecode 2>/dev/null && echo "Thanks for starring! ⭐" || echo "Could not star - you can star manually at https://github.com/Yeachan-Heo/oh-my-claudecode"
```

**Note:** Fail gracefully if the API call doesn't work - never block setup completion.

### If gh is NOT available or not authenticated:

Skip the AskUserQuestion and just display:

```bash
echo ""
echo "If you enjoy oh-my-claudecode, consider starring the repo:"
echo "  https://github.com/Yeachan-Heo/oh-my-claudecode"
echo ""
```

## Fallback

If curl fails, tell user to manually download from:
https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md
