# Phase 2: Environment Configuration

**Skip condition**: If resuming and `lastCompletedStep >= 4`, skip this entire phase.

## Step 2.1: Setup HUD Statusline

**Note**: If resuming and `lastCompletedStep >= 3`, skip to Step 2.2.

The HUD shows real-time status in Claude Code's status bar. Invoke the hud skill to set up and configure:

Use the Skill tool to invoke: `hud` with args: `setup`

This will:
1. Install the HUD wrapper script to `~/.claude/hud/omc-hud.mjs`
2. Configure `statusLine` in `~/.claude/settings.json`
3. Report status and prompt to restart if needed

After HUD setup completes, save progress:
```bash
CONFIG_TYPE=$(jq -r '.configType // "unknown"' ".omc/state/setup-state.json" 2>/dev/null || echo "unknown")
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-progress.sh" save 3 "$CONFIG_TYPE"
```

## Step 2.2: Clear Stale Plugin Cache

```bash
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude'),b=p.join(d,'plugins','cache','omc','oh-my-claudecode');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));if(v.length<=1){console.log('Cache is clean');process.exit()}v.slice(0,-1).forEach(x=>{f.rmSync(p.join(b,x),{recursive:true,force:true})});console.log('Cleared',v.length-1,'stale cache version(s)')}catch{console.log('No cache directory found (normal for new installs)')}"
```

## Step 2.3: Check for Updates

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

## Step 2.4: Set Default Execution Mode

Use the AskUserQuestion tool to prompt the user:

**Question:** "Which parallel execution mode should be your default when you say 'fast' or 'parallel'?"

**Options:**
1. **ultrawork (maximum capability)** - Uses all agent tiers including Opus for complex tasks. Best for challenging work where quality matters most. (Recommended)

Store the preference in `~/.claude/.omc-config.json`:

```bash
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

## Step 2.5: Install OMC CLI Tool

The OMC CLI (`omc` command) provides standalone monitoring and analytics commands.

First, check if the CLI is already installed:

```bash
if command -v omc &>/dev/null; then
  OMC_CLI_VERSION=$(omc --version 2>/dev/null | head -1 || echo "installed")
  echo "OMC CLI already installed: $OMC_CLI_VERSION"
  OMC_CLI_INSTALLED="true"
else
  OMC_CLI_INSTALLED="false"
fi
```

If `OMC_CLI_INSTALLED` is `"true"`, skip the rest of this step.

If `OMC_CLI_INSTALLED` is `"false"`, use AskUserQuestion:

**Question:** "Would you like to install the OMC CLI globally for standalone monitoring and analytics? (`omc`, `omc cost`, `omc sessions`)"

**Options:**
1. **Yes (Recommended)** - Install `oh-my-claude-sisyphus` via `npm install -g`
2. **No - Skip** - Skip installation (can install manually later with `npm install -g oh-my-claude-sisyphus`)

If user chooses **Yes**:

```bash
if ! command -v npm &>/dev/null; then
  echo "WARNING: npm not found. Cannot install OMC CLI automatically."
  echo "Install Node.js/npm first, then run: npm install -g oh-my-claude-sisyphus"
else
  if npm install -g oh-my-claude-sisyphus 2>&1; then
    echo "OMC CLI installed successfully."
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

**Note**: The CLI is optional. All core functionality is also available through the plugin system.

## Step 2.6: Select Task Management Tool

First, detect available task tools:

```bash
BD_VERSION=""
if command -v bd &>/dev/null; then
  BD_VERSION=$(bd --version 2>/dev/null | head -1 || echo "installed")
fi

BR_VERSION=""
if command -v br &>/dev/null; then
  BR_VERSION=$(br --version 2>/dev/null | head -1 || echo "installed")
fi

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

**Note:** The beads context instructions will be injected automatically on the next session start.

## Save Progress

```bash
CONFIG_TYPE=$(jq -r '.configType // "unknown"' ".omc/state/setup-state.json" 2>/dev/null || echo "unknown")
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-progress.sh" save 4 "$CONFIG_TYPE"
```
