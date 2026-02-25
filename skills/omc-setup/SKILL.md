---
name: omc-setup
description: Setup and configure oh-my-claudecode (the ONLY command you need to learn)
---

# OMC Setup

This is the **only command you need to learn**. After running this, everything else is automatic.

Note: All `~/.claude/...` paths in this guide respect `CLAUDE_CONFIG_DIR` when that environment variable is set.

## Pre-Setup Check: Already Configured?

**CRITICAL**: Before doing anything else, check if setup has already been completed. This prevents users from having to re-run the full setup wizard after every update.

```bash
# Check if setup was already completed
CONFIG_FILE="$HOME/.claude/.omc-config.json"

if [ -f "$CONFIG_FILE" ]; then
  SETUP_COMPLETED=$(jq -r '.setupCompleted // empty' "$CONFIG_FILE" 2>/dev/null)
  SETUP_VERSION=$(jq -r '.setupVersion // empty' "$CONFIG_FILE" 2>/dev/null)

  if [ -n "$SETUP_COMPLETED" ] && [ "$SETUP_COMPLETED" != "null" ]; then
    echo "OMC setup was already completed on: $SETUP_COMPLETED"
    [ -n "$SETUP_VERSION" ] && echo "Setup version: $SETUP_VERSION"
    ALREADY_CONFIGURED="true"
  fi
fi
```

### If Already Configured (and no --force flag)

If `ALREADY_CONFIGURED` is true AND the user did NOT pass `--force`, `--local`, or `--global` flags:

Use AskUserQuestion to prompt:

**Question:** "OMC is already configured. What would you like to do?"

**Options:**
1. **Update CLAUDE.md only** - Download latest CLAUDE.md without re-running full setup
2. **Run full setup again** - Go through the complete setup wizard
3. **Cancel** - Exit without changes

**If user chooses "Update CLAUDE.md only":**
- Detect if local (.claude/CLAUDE.md) or global (~/.claude/CLAUDE.md) config exists
- If local exists, run the download/merge script from Step 2A
- If only global exists, run the download/merge script from Step 2B
- Skip all other steps
- Report success and exit

**If user chooses "Run full setup again":**
- Continue with Step 0 (Resume Detection) below

**If user chooses "Cancel":**
- Exit without any changes

### Force Flag Override

If user passes `--force` flag, skip this check and proceed directly to setup.

## Graceful Interrupt Handling

**IMPORTANT**: This setup process saves progress after each step. If interrupted (Ctrl+C or connection loss), the setup can resume from where it left off.

### State File Location
- `.omc/state/setup-state.json` - Tracks completed steps

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

### Save Progress Helper

After completing each major step, save progress:

```bash
# Save setup progress (call after each step)
# Usage: save_setup_progress STEP_NUMBER
save_setup_progress() {
  mkdir -p .omc/state
  cat > ".omc/state/setup-state.json" << EOF
{
  "lastCompletedStep": $1,
  "timestamp": "$(date -Iseconds)",
  "configType": "${CONFIG_TYPE:-unknown}"
}
EOF
}
```

### Clear State on Completion

After successful setup completion (Step 7/8), remove the state file:

```bash
rm -f ".omc/state/setup-state.json"
echo "Setup completed successfully. State cleared."
```

## Usage Modes

This skill handles three scenarios:

1. **Initial Setup (no flags)**: First-time installation wizard
2. **Local Configuration (`--local`)**: Configure project-specific settings (.claude/CLAUDE.md)
3. **Global Configuration (`--global`)**: Configure global settings (~/.claude/CLAUDE.md)

## Mode Detection

Check for flags in the user's invocation:
- If `--local` flag present → Skip Pre-Setup Check, go to Local Configuration (Step 2A)
- If `--global` flag present → Skip Pre-Setup Check, go to Global Configuration (Step 2B)
- If `--force` flag present → Skip Pre-Setup Check, run Initial Setup wizard (Step 1)
- If no flags → Run Pre-Setup Check first, then Initial Setup wizard (Step 1) if needed

## Step 1: Initial Setup Wizard (Default Behavior)

**Note**: If resuming and lastCompletedStep >= 1, skip to the appropriate step based on configType.

Use the AskUserQuestion tool to prompt the user:

**Question:** "Where should I configure oh-my-claudecode?"

**Options:**
1. **Local (this project)** - Creates `.claude/CLAUDE.md` in current project directory. Best for project-specific configurations.
2. **Global (all projects)** - Creates `~/.claude/CLAUDE.md` for all Claude Code sessions. Best for consistent behavior everywhere.

## Step 2A: Local Configuration (--local flag or user chose LOCAL)

**CRITICAL**: This ALWAYS downloads fresh CLAUDE.md from GitHub to the local project. DO NOT use the Write tool - use bash curl exclusively.

### Create Local .claude Directory

```bash
# Create .claude directory in current project
mkdir -p .claude && echo ".claude directory ready"
```

### Download Fresh CLAUDE.md

```bash
# Define target path
TARGET_PATH=".claude/CLAUDE.md"

# Extract old version before download
OLD_VERSION=$(grep -m1 "^# oh-my-claudecode" "$TARGET_PATH" 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "none")

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
curl -fsSL "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md" -o "$TEMP_OMC"

if [ ! -s "$TEMP_OMC" ]; then
  echo "ERROR: Failed to download CLAUDE.md. Aborting."
  rm -f "$TEMP_OMC"
  return 1
fi

# Strip existing markers from downloaded content (idempotency)
if grep -q '<!-- OMC:START -->' "$TEMP_OMC"; then
  # Extract content between markers (awk is portable across GNU/BSD)
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
    # Has markers: replace OMC section, keep user content
    # Use awk instead of sed for cross-platform compatibility (GNU/BSD)
    BEFORE_OMC=$(awk '/<!-- OMC:START -->/{exit} {print}' "$TARGET_PATH")
    AFTER_OMC=$(awk 'p; /<!-- OMC:END -->/{p=1}' "$TARGET_PATH")
    {
      [ -n "$BEFORE_OMC" ] && printf '%s\n' "$BEFORE_OMC"
      echo '<!-- OMC:START -->'
      cat "$TEMP_OMC"
      echo '<!-- OMC:END -->'
      [ -n "$AFTER_OMC" ] && printf '%s\n' "$AFTER_OMC"
    } > "${TARGET_PATH}.tmp"
    mv "${TARGET_PATH}.tmp" "$TARGET_PATH"
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
NEW_VERSION=$(grep -m1 "^# oh-my-claudecode" "$TARGET_PATH" 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
if [ "$OLD_VERSION" = "none" ]; then
  echo "Installed CLAUDE.md: $NEW_VERSION"
elif [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  echo "CLAUDE.md unchanged: $NEW_VERSION"
else
  echo "Updated CLAUDE.md: $OLD_VERSION -> $NEW_VERSION"
fi
```

**Note**: The downloaded CLAUDE.md includes Context Persistence instructions with `<remember>` tags for surviving conversation compaction.

**Note**: If an existing CLAUDE.md is found, it will be backed up to `.claude/CLAUDE.md.backup.YYYY-MM-DD` before downloading the new version.

**MANDATORY**: Always run this command. Do NOT skip. Do NOT use Write tool.

**FALLBACK** if curl fails:
Tell user to manually download from:
https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md

### Verify Plugin Installation

```bash
grep -q "oh-my-claudecode" ~/.claude/settings.json && echo "Plugin verified" || echo "Plugin NOT found - run: claude /install-plugin oh-my-claudecode"
```

### Confirm Local Configuration Success

After completing local configuration, save progress and report:

```bash
# Save progress - Step 2 complete (Local config)
mkdir -p .omc/state
cat > ".omc/state/setup-state.json" << EOF
{
  "lastCompletedStep": 2,
  "timestamp": "$(date -Iseconds)",
  "configType": "local"
}
EOF
```

**OMC Project Configuration Complete**
- CLAUDE.md: Updated with latest configuration from GitHub at ./.claude/CLAUDE.md
- Backup: Previous CLAUDE.md backed up to `.claude/CLAUDE.md.backup.YYYY-MM-DD` (if existed)
- Scope: **PROJECT** - applies only to this project
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 28+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

**Note**: This configuration is project-specific and won't affect other projects or global settings.

If `--local` flag was used, clear state and **STOP HERE**:
```bash
rm -f ".omc/state/setup-state.json"
```
Do not continue to HUD setup or other steps.

## Step 2B: Global Configuration (--global flag or user chose GLOBAL)

**CRITICAL**: This ALWAYS downloads fresh CLAUDE.md from GitHub to global config. DO NOT use the Write tool - use bash curl exclusively.

### Download Fresh CLAUDE.md

```bash
# Define target path
TARGET_PATH="$HOME/.claude/CLAUDE.md"

# Extract old version before download
OLD_VERSION=$(grep -m1 "^# oh-my-claudecode" "$TARGET_PATH" 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "none")

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
curl -fsSL "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md" -o "$TEMP_OMC"

if [ ! -s "$TEMP_OMC" ]; then
  echo "ERROR: Failed to download CLAUDE.md. Aborting."
  rm -f "$TEMP_OMC"
  return 1
fi

# Strip existing markers from downloaded content (idempotency)
if grep -q '<!-- OMC:START -->' "$TEMP_OMC"; then
  # Extract content between markers (awk is portable across GNU/BSD)
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
    # Has markers: replace OMC section, keep user content
    # Use awk instead of sed for cross-platform compatibility (GNU/BSD)
    BEFORE_OMC=$(awk '/<!-- OMC:START -->/{exit} {print}' "$TARGET_PATH")
    AFTER_OMC=$(awk 'p; /<!-- OMC:END -->/{p=1}' "$TARGET_PATH")
    {
      [ -n "$BEFORE_OMC" ] && printf '%s\n' "$BEFORE_OMC"
      echo '<!-- OMC:START -->'
      cat "$TEMP_OMC"
      echo '<!-- OMC:END -->'
      [ -n "$AFTER_OMC" ] && printf '%s\n' "$AFTER_OMC"
    } > "${TARGET_PATH}.tmp"
    mv "${TARGET_PATH}.tmp" "$TARGET_PATH"
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
NEW_VERSION=$(grep -m1 "^# oh-my-claudecode" "$TARGET_PATH" 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
if [ "$OLD_VERSION" = "none" ]; then
  echo "Installed CLAUDE.md: $NEW_VERSION"
elif [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  echo "CLAUDE.md unchanged: $NEW_VERSION"
else
  echo "Updated CLAUDE.md: $OLD_VERSION -> $NEW_VERSION"
fi
```

**Note**: If an existing CLAUDE.md is found, it will be backed up to `~/.claude/CLAUDE.md.backup.YYYY-MM-DD` before downloading the new version.

### Clean Up Legacy Hooks (if present)

Check if old manual hooks exist and remove them to prevent duplicates:

```bash
# Remove legacy bash hook scripts (now handled by plugin system)
rm -f ~/.claude/hooks/keyword-detector.sh
rm -f ~/.claude/hooks/stop-continuation.sh
rm -f ~/.claude/hooks/persistent-mode.sh
rm -f ~/.claude/hooks/session-start.sh
echo "Legacy hooks cleaned"
```

Check `~/.claude/settings.json` for manual hook entries. If the "hooks" key exists with UserPromptSubmit, Stop, or SessionStart entries pointing to bash scripts, inform the user:

> **Note**: Found legacy hooks in settings.json. These should be removed since the plugin now provides hooks automatically. Remove the "hooks" section from ~/.claude/settings.json to prevent duplicate hook execution.

### Verify Plugin Installation

```bash
grep -q "oh-my-claudecode" ~/.claude/settings.json && echo "Plugin verified" || echo "Plugin NOT found - run: claude /install-plugin oh-my-claudecode"
```

### Confirm Global Configuration Success

After completing global configuration, save progress and report:

```bash
# Save progress - Step 2 complete (Global config)
mkdir -p .omc/state
cat > ".omc/state/setup-state.json" << EOF
{
  "lastCompletedStep": 2,
  "timestamp": "$(date -Iseconds)",
  "configType": "global"
}
EOF
```

**OMC Global Configuration Complete**
- CLAUDE.md: Updated with latest configuration from GitHub at ~/.claude/CLAUDE.md
- Backup: Previous CLAUDE.md backed up to `~/.claude/CLAUDE.md.backup.YYYY-MM-DD` (if existed)
- Scope: **GLOBAL** - applies to all Claude Code sessions
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 28+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

**Note**: Hooks are now managed by the plugin system automatically. No manual hook installation required.

If `--global` flag was used, clear state and **STOP HERE**:
```bash
rm -f ".omc/state/setup-state.json"
```
Do not continue to HUD setup or other steps.

## Step 3: Setup HUD Statusline

**Note**: If resuming and lastCompletedStep >= 3, skip to Step 3.5.

The HUD shows real-time status in Claude Code's status bar. **Invoke the hud skill** to set up and configure:

Use the Skill tool to invoke: `hud` with args: `setup`

This will:
1. Install the HUD wrapper script to `~/.claude/hud/omc-hud.mjs`
2. Configure `statusLine` in `~/.claude/settings.json`
3. Report status and prompt to restart if needed

After HUD setup completes, save progress:
```bash
# Save progress - Step 3 complete (HUD setup)
mkdir -p .omc/state
CONFIG_TYPE=$(cat ".omc/state/setup-state.json" 2>/dev/null | grep -oE '"configType":\s*"[^"]+"' | cut -d'"' -f4 || echo "unknown")
cat > ".omc/state/setup-state.json" << EOF
{
  "lastCompletedStep": 3,
  "timestamp": "$(date -Iseconds)",
  "configType": "$CONFIG_TYPE"
}
EOF
```

## Step 3.5: Clear Stale Plugin Cache

Clear old cached plugin versions to avoid conflicts:

```bash
# Clear stale plugin cache versions (cross-platform)
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude'),b=p.join(d,'plugins','cache','omc','oh-my-claudecode');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));if(v.length<=1){console.log('Cache is clean');process.exit()}v.slice(0,-1).forEach(x=>{f.rmSync(p.join(b,x),{recursive:true,force:true})});console.log('Cleared',v.length-1,'stale cache version(s)')}catch{console.log('No cache directory found (normal for new installs)')}"
```

## Step 3.6: Check for Updates

Notify user if a newer version is available:

```bash
# Detect installed version (cross-platform)
node -e "
const p=require('path'),f=require('fs'),h=require('os').homedir();
const d=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude');
let v='';
// Try cache directory first
const b=p.join(d,'plugins','cache','omc','oh-my-claudecode');
try{const vs=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));if(vs.length)v=vs[vs.length-1]}catch{}
// Try .omc-version.json second
if(v==='')try{const j=JSON.parse(f.readFileSync('.omc-version.json','utf-8'));v=j.version||''}catch{}
// Try CLAUDE.md header third
if(v==='')for(const c of['.claude/CLAUDE.md',p.join(d,'CLAUDE.md')]){try{const m=f.readFileSync(c,'utf-8').match(/^# oh-my-claudecode.*?(v?\d+\.\d+\.\d+)/m);if(m){v=m[1].replace(/^v/,'');break}}catch{}}
console.log('Installed:',v||'(not found)');
"

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

## Step 3.7: Set Default Execution Mode

Use the AskUserQuestion tool to prompt the user:

**Question:** "Which parallel execution mode should be your default when you say 'fast' or 'parallel'?"

**Options:**
1. **ultrawork (maximum capability)** - Uses all agent tiers including Opus for complex tasks. Best for challenging work where quality matters most. (Recommended)

Store the preference in `~/.claude/.omc-config.json`:

```bash
# Read existing config or create empty object
CONFIG_FILE="$HOME/.claude/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi

# Set defaultExecutionMode (replace USER_CHOICE with "ultrawork" or "")
echo "$EXISTING" | jq --arg mode "USER_CHOICE" '. + {defaultExecutionMode: $mode, configuredAt: (now | todate)}' > "$CONFIG_FILE"
echo "Default execution mode set to: USER_CHOICE"
```

**Note**: This preference ONLY affects generic keywords ("fast", "parallel"). Explicit keywords ("ulw") always override this preference.


## Step 3.8: Install OMC CLI Tool

The OMC CLI (`omc` command) provides standalone token analytics and management commands (`omc stats`, `omc agents`, `omc tui`).

First, check if the CLI is already installed:

```bash
# Check if omc CLI is already available
if command -v omc &>/dev/null; then
  OMC_CLI_VERSION=$(omc --version 2>/dev/null | head -1 || echo "installed")
  echo "OMC CLI already installed: $OMC_CLI_VERSION"
  OMC_CLI_INSTALLED="true"
else
  OMC_CLI_INSTALLED="false"
fi
```

If `OMC_CLI_INSTALLED` is `"true"`, skip the rest of this step.

If `OMC_CLI_INSTALLED` is `"false"`, use the AskUserQuestion tool to prompt the user:

**Question:** "Would you like to install the OMC CLI globally for standalone analytics? (`omc stats`, `omc agents`, `omc tui`)"

**Options:**
1. **Yes (Recommended)** - Install `oh-my-claude-sisyphus` via `npm install -g`
2. **No - Skip** - Skip installation (can install manually later with `npm install -g oh-my-claude-sisyphus`)

If user chooses **Yes**:

```bash
# Check if npm is available
if ! command -v npm &>/dev/null; then
  echo "WARNING: npm not found. Cannot install OMC CLI automatically."
  echo "Install Node.js/npm first, then run: npm install -g oh-my-claude-sisyphus"
else
  # Install the CLI globally
  if npm install -g oh-my-claude-sisyphus 2>&1; then
    echo "OMC CLI installed successfully."
    # Verify installation
    if command -v omc &>/dev/null; then
      OMC_CLI_VERSION=$(omc --version 2>/dev/null | head -1 || echo "installed")
      echo "Verified: omc $OMC_CLI_VERSION"
    else
      echo "Installed but 'omc' not on PATH. You may need to restart your shell."
    fi
  else
    echo "WARNING: Failed to install OMC CLI (permission issue or network error)."
    echo "You can install manually later: npm install -g oh-my-claude-sisyphus"
    echo "Or with sudo: sudo npm install -g oh-my-claude-sisyphus"
  fi
fi
```

If user chooses **No - Skip**, continue to the next step without installing.

**Note**: The CLI is optional. All core functionality is also available through the plugin system (`/oh-my-claudecode:omc-help`, `/oh-my-claudecode:omc-doctor`). The CLI adds standalone terminal commands for analytics outside of Claude Code sessions.

## Step 3.8.5: Select Task Management Tool

First, detect available task tools:

```bash
# Detect beads (bd)
BD_VERSION=""
if command -v bd &>/dev/null; then
  BD_VERSION=$(bd --version 2>/dev/null | head -1 || echo "installed")
fi

# Detect beads-rust (br)
BR_VERSION=""
if command -v br &>/dev/null; then
  BR_VERSION=$(br --version 2>/dev/null | head -1 || echo "installed")
fi

# Report findings
if [ -n "$BD_VERSION" ]; then
  echo "Found beads (bd): $BD_VERSION"
fi
if [ -n "$BR_VERSION" ]; then
  echo "Found beads-rust (br): $BR_VERSION"
fi
if [ -z "$BD_VERSION" ] && [ -z "$BR_VERSION" ]; then
  echo "No external task tools found. Using built-in Tasks."
fi
```

If **neither** beads nor beads-rust is detected, skip this step (default to built-in).

If beads or beads-rust is detected, use AskUserQuestion:

**Question:** "Which task management tool should I use for tracking work?"

**Options:**
1. **Built-in Tasks (default)** - Use Claude Code's native TaskCreate/TodoWrite. Tasks are session-only.
2. **Beads (bd)** - Git-backed persistent tasks. Survives across sessions. [Only if detected]
3. **Beads-Rust (br)** - Lightweight Rust port of beads. [Only if detected]

(Only show options 2/3 if the corresponding tool is detected)

Store the preference:

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi

# USER_CHOICE is "builtin", "beads", or "beads-rust" based on user selection
echo "$EXISTING" | jq --arg tool "USER_CHOICE" '. + {taskTool: $tool, taskToolConfig: {injectInstructions: true, useMcp: false}}' > "$CONFIG_FILE"
echo "Task tool set to: USER_CHOICE"
```

**Note:** The beads context instructions will be injected automatically on the next session start. No restart is needed for config to take effect.

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

## Step 5.5: Configure Agent Teams (Optional)

**Note**: If resuming and lastCompletedStep >= 5.5, skip to Step 6.

Agent teams are an experimental Claude Code feature that lets you spawn N coordinated agents working on a shared task list with inter-agent messaging. **Teams are disabled by default** and require enabling via `settings.json`.

Reference: https://code.claude.com/docs/en/agent-teams

Use the AskUserQuestion tool to prompt:

**Question:** "Would you like to enable agent teams? Teams let you spawn coordinated agents (e.g., `/team 3:executor 'fix all errors'`). This is an experimental Claude Code feature."

**Options:**
1. **Yes, enable teams (Recommended)** - Enable the experimental feature and configure defaults
2. **No, skip** - Leave teams disabled (can enable later)

### If User Chooses YES:

#### Step 5.5.1: Enable Agent Teams in settings.json

**CRITICAL**: Agent teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` to be set in `~/.claude/settings.json`. This must be done carefully to preserve existing user settings.

First, read the current settings.json:

```bash
SETTINGS_FILE="$HOME/.claude/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
  echo "Current settings.json found"
  cat "$SETTINGS_FILE"
else
  echo "No settings.json found - will create one"
fi
```

Then use the Read tool to read `~/.claude/settings.json` (if it exists). Use the Edit tool to merge the teams configuration while preserving ALL existing settings.

**If settings.json exists and has an `env` key**, merge the new env var into it:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Use jq to safely merge without overwriting existing settings:

```bash
SETTINGS_FILE="$HOME/.claude/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
  # Merge env var into existing settings, preserving everything else
  TEMP_FILE=$(mktemp)
  jq '.env = (.env // {} | . + {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"})' "$SETTINGS_FILE" > "$TEMP_FILE" && mv "$TEMP_FILE" "$SETTINGS_FILE"
  echo "Added CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS to existing settings.json"
else
  # Create new settings.json with just the teams env var
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

**IMPORTANT**: The Edit tool is preferred for modifying settings.json when possible, since it preserves formatting and comments. The jq approach above is the fallback for when the file needs structural merging.

#### Step 5.5.2: Configure Teammate Display Mode

Use the AskUserQuestion tool:

**Question:** "How should teammates be displayed?"

**Options:**
1. **Auto (Recommended)** - Uses split panes if in tmux, otherwise in-process. Best for most users.
2. **In-process** - All teammates in your main terminal. Use Shift+Up/Down to select. Works everywhere.
3. **Split panes (tmux)** - Each teammate in its own pane. Requires tmux or iTerm2.

If user chooses anything other than "Auto", add `teammateMode` to settings.json:

```bash
SETTINGS_FILE="$HOME/.claude/settings.json"

# TEAMMATE_MODE is "in-process" or "tmux" based on user choice
# Skip this if user chose "Auto" (that's the default)
jq --arg mode "TEAMMATE_MODE" '. + {teammateMode: $mode}' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
echo "Teammate display mode set to: TEAMMATE_MODE"
```

#### Step 5.5.3: Configure Team Defaults in omc-config

Use the AskUserQuestion tool with multiple questions:

**Question 1:** "How many agents should teams spawn by default?"

**Options:**
1. **3 agents (Recommended)** - Good balance of speed and resource usage
2. **5 agents (maximum)** - Maximum parallelism for large tasks
3. **2 agents** - Conservative, for smaller projects

**Question 2:** "Which agent type should teammates use by default?"

**Options:**
1. **executor (Recommended)** - General-purpose code implementation agent
2. **build-fixer** - Specialized for build/type error fixing
3. **designer** - Specialized for UI/frontend work

Store the team configuration in `~/.claude/.omc-config.json`:

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi

# Replace MAX_AGENTS, AGENT_TYPE with user choices
echo "$EXISTING" | jq \
  --argjson maxAgents MAX_AGENTS \
  --arg agentType "AGENT_TYPE" \
  '. + {team: {maxAgents: $maxAgents, defaultAgentType: $agentType, monitorIntervalMs: 30000, shutdownTimeoutMs: 15000}}' > "$CONFIG_FILE"

echo "Team configuration saved:"
echo "  Max agents: MAX_AGENTS"
echo "  Default agent: AGENT_TYPE"
echo "  Model: teammates inherit your session model"
```

**Note:** Teammates do not have a separate model default. Each teammate is a full Claude Code session that inherits your configured model. Subagents spawned by teammates can use any model tier.

#### Verify settings.json Integrity

After all modifications, verify settings.json is valid JSON and contains the expected keys:

```bash
SETTINGS_FILE="$HOME/.claude/settings.json"

# Verify JSON is valid
if jq empty "$SETTINGS_FILE" 2>/dev/null; then
  echo "settings.json: valid JSON"
else
  echo "ERROR: settings.json is invalid JSON! Restoring from backup..."
  # The backup from Step 2 should still exist
  exit 1
fi

# Verify teams env var is present
if jq -e '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' "$SETTINGS_FILE" > /dev/null 2>&1; then
  echo "Agent teams: ENABLED"
else
  echo "WARNING: Agent teams env var not found in settings.json"
fi

# Show final settings.json for user review
echo ""
echo "Final settings.json:"
jq '.' "$SETTINGS_FILE"
```

### If User Chooses NO:

Skip this step. Agent teams will remain disabled. User can enable later by adding to `~/.claude/settings.json`:
```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Or by running `/oh-my-claudecode:omc-setup --force` and choosing to enable teams.

### Save Progress

```bash
# Save progress - Step 5.5 complete (Teams configured)
mkdir -p .omc/state
CONFIG_TYPE=$(cat ".omc/state/setup-state.json" 2>/dev/null | grep -oE '"configType":\s*"[^"]+"' | cut -d'"' -f4 || echo "unknown")
cat > ".omc/state/setup-state.json" << EOF
{
  "lastCompletedStep": 5.5,
  "timestamp": "$(date -Iseconds)",
  "configType": "$CONFIG_TYPE"
}
EOF
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

**Before prompting, check if the repository is already starred:**

```bash
gh api user/starred/Yeachan-Heo/oh-my-claudecode &>/dev/null
```

**If already starred (exit code 0):**
- Skip the prompt entirely
- Continue to next step silently

**If NOT starred (exit code non-zero):**

Use the AskUserQuestion tool to prompt the user:

**Question:** "If you're enjoying oh-my-claudecode, would you like to support the project by starring it on GitHub?"

**Options:**
1. **Yes, star it!** - Star the repository
2. **No thanks** - Skip without further prompts
3. **Maybe later** - Skip without further prompts

If user chooses "Yes, star it!":

```bash
gh api -X PUT /user/starred/Yeachan-Heo/oh-my-claudecode 2>/dev/null && echo "Thanks for starring! ⭐" || true
```

**Note:** Fail silently if the API call doesn't work - never block setup completion.

### If gh is NOT available or not authenticated:

```bash
echo ""
echo "If you enjoy oh-my-claudecode, consider starring the repo:"
echo "  https://github.com/Yeachan-Heo/oh-my-claudecode"
echo ""
```

### Clear Setup State and Mark Completion

After Step 8 completes (regardless of star choice), clear the temporary state and mark setup as completed:

```bash
# Setup complete - clear temporary state file
rm -f ".omc/state/setup-state.json"

# Mark setup as completed in persistent config (prevents re-running full setup on updates)
CONFIG_FILE="$HOME/.claude/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

# Get current OMC version from CLAUDE.md
OMC_VERSION=""
if [ -f ".claude/CLAUDE.md" ]; then
  OMC_VERSION=$(grep -m1 "^# oh-my-claudecode" .claude/CLAUDE.md 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
elif [ -f "$HOME/.claude/CLAUDE.md" ]; then
  OMC_VERSION=$(grep -m1 "^# oh-my-claudecode" "$HOME/.claude/CLAUDE.md" 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
fi

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi

# Add setupCompleted timestamp and version
echo "$EXISTING" | jq --arg ts "$(date -Iseconds)" --arg ver "$OMC_VERSION" \
  '. + {setupCompleted: $ts, setupVersion: $ver}' > "$CONFIG_FILE"

echo "Setup completed successfully!"
echo "Note: Future updates will only refresh CLAUDE.md, not the full setup wizard."
```

## Keeping Up to Date

After installing oh-my-claudecode updates (via npm or plugin update):

**Automatic**: Just run `/oh-my-claudecode:omc-setup` - it will detect you've already configured and offer a quick "Update CLAUDE.md only" option that skips the full wizard.

**Manual options**:
- `/oh-my-claudecode:omc-setup --local` to update project config only
- `/oh-my-claudecode:omc-setup --global` to update global config only
- `/oh-my-claudecode:omc-setup --force` to re-run the full wizard (reconfigure preferences)

This ensures you have the newest features and agent configurations without the token cost of repeating the full setup.

## Help Text

When user runs `/oh-my-claudecode:omc-setup --help` or just `--help`, display:

```
OMC Setup - Configure oh-my-claudecode

USAGE:
  /oh-my-claudecode:omc-setup           Run initial setup wizard (or update if already configured)
  /oh-my-claudecode:omc-setup --local   Configure local project (.claude/CLAUDE.md)
  /oh-my-claudecode:omc-setup --global  Configure global settings (~/.claude/CLAUDE.md)
  /oh-my-claudecode:omc-setup --force   Force full setup wizard even if already configured
  /oh-my-claudecode:omc-setup --help    Show this help

MODES:
  Initial Setup (no flags)
    - Interactive wizard for first-time setup
    - Configures CLAUDE.md (local or global)
    - Sets up HUD statusline
    - Checks for updates
    - Offers MCP server configuration
    - Configures team mode defaults (agent count, type, model)
    - If already configured, offers quick update option

  Local Configuration (--local)
    - Downloads fresh CLAUDE.md to ./.claude/
    - Backs up existing CLAUDE.md to .claude/CLAUDE.md.backup.YYYY-MM-DD
    - Project-specific settings
    - Use this to update project config after OMC upgrades

  Global Configuration (--global)
    - Downloads fresh CLAUDE.md to ~/.claude/
    - Backs up existing CLAUDE.md to ~/.claude/CLAUDE.md.backup.YYYY-MM-DD
    - Applies to all Claude Code sessions
    - Cleans up legacy hooks
    - Use this to update global config after OMC upgrades

  Force Full Setup (--force)
    - Bypasses the "already configured" check
    - Runs the complete setup wizard from scratch
    - Use when you want to reconfigure preferences

EXAMPLES:
  /oh-my-claudecode:omc-setup           # First time setup (or update CLAUDE.md if configured)
  /oh-my-claudecode:omc-setup --local   # Update this project
  /oh-my-claudecode:omc-setup --global  # Update all projects
  /oh-my-claudecode:omc-setup --force   # Re-run full setup wizard

For more info: https://github.com/Yeachan-Heo/oh-my-claudecode
```

## Optional Rule Templates

OMC includes rule templates you can copy to your project's `.claude/rules/` directory for automatic context injection:

| Template | Purpose |
|----------|---------|
| `coding-style.md` | Code style, immutability, file organization |
| `testing.md` | TDD workflow, 80% coverage target |
| `security.md` | Secret management, input validation |
| `performance.md` | Model selection, context management |
| `git-workflow.md` | Commit conventions, PR workflow |
| `karpathy-guidelines.md` | Coding discipline — think before coding, simplicity, surgical changes |

Copy with:
```bash
mkdir -p .claude/rules
cp "${CLAUDE_PLUGIN_ROOT}/templates/rules/"*.md .claude/rules/
```

See `templates/rules/README.md` for details.
