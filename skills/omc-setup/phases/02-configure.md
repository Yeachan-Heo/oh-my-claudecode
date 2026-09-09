# Phase 2: Environment Configuration

**Skip condition**: If resuming and `lastCompletedStep >= 4`, skip Steps 2.0–2.3 and begin at Step 2.4 so retired setup values are always cleared before the phase exits.

## Resume Boundary

Capture the original progress marker once when Phase 2 starts. A resumed run that enters at Step 2.4 must not repeat the completed Steps 2.5/2.6 prompts or overwrite a higher progress marker:

```bash
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to resume setup safely. Existing setup state was not modified."
  exit 1
fi
if ! RESUME_LAST_COMPLETED_STEP=$(jq -r '.lastCompletedStep // 0' ".omc/state/setup-state.json" 2>/dev/null); then
  echo "ERROR: Setup state is invalid JSON. Existing setup state was not modified."
  exit 1
fi
if [ "$RESUME_LAST_COMPLETED_STEP" -ge 4 ] 2>/dev/null; then
  RESUMED_PHASE_TWO_BOUNDARY="true"
else
  RESUMED_PHASE_TWO_BOUNDARY="false"
fi
```

## Step 2.0: Check Ralph Runtime Prerequisites

Ralph is an agent-driven persistence loop with no external language dependency. Its only hard prerequisites are the Node runtime that already runs OMC's hooks and a writable config directory for `.omc/state/` state files. Verify both without blocking the rest of setup:

```bash
node --version || echo "ERROR: Node is required for OMC hooks and Ralph state persistence."
mkdir -p "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" 2>/dev/null
touch "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.omc-write-probe" 2>/dev/null && rm -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.omc-write-probe" \
  || echo "WARNING: Config dir is not writable; Ralph state persistence will fail until it is."
```

## Step 2.1: Setup HUD Statusline

**Note**: If resuming and `lastCompletedStep >= 3`, skip to Step 2.2.

The HUD shows real-time status in Claude Code's status bar. Delegate all HUD/statusLine setup to the `hud` skill:

Use the Skill tool to invoke: `hud` with args: `setup`

Do not generate, normalize, or patch `statusLine` paths inline in this phase. This is especially important on Windows, where backslash path handling must stay inside the `hud` skill.

This will:
1. Install the HUD wrapper script to `~/.claude/hud/omc-hud.mjs`
2. Configure `statusLine` in `~/.claude/settings.json`
3. Report status and prompt to restart if needed

After HUD setup completes, save progress:
```bash
CONFIG_TYPE=$(jq -r '.configType // "unknown"' ".omc/state/setup-state.json" 2>/dev/null || echo "unknown")
bash "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.sh" save 3 "$CONFIG_TYPE"
```

## Step 2.2: Repair Stale Plugin Cache References

After a marketplace update, Claude Code may still have old OMC cache paths in the running session or plugin registry. Repair those references before any cache cleanup so setup does not repeatedly emit stale plugin directory errors.

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/repair-plugin-cache.mjs"
```

## Step 2.3: Check for Updates

Notify user if a newer version is available:

```bash
# Detect installed version (cross-platform)
node -e "
const p=require('path'),f=require('fs'),h=require('os').homedir();
const raw=process.env.CLAUDE_CONFIG_DIR?.trim();
const d=raw==null||raw===''? p.join(h,'.claude'):raw==='~'?h:raw.startsWith('~/')||raw.startsWith('~\\\\')?p.join(h,raw.slice(2)):raw;
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

## Step 2.4: Clear Retired Setup Values

The `ultrawork` workflow was removed in 5.0.0 and the `defaultExecutionMode` config key is no longer read by any runtime surface. Upgrades from 4.x may still carry a dead persisted value in `.omc-config.json`. Clear it so the config matches the current contract:

```bash
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$CONFIG_DIR" in
  "~") CONFIG_DIR="$HOME" ;;
  "~/"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~/}" ;;
  "~\\"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~\\}" ;;
esac
CONFIG_FILE="$CONFIG_DIR/.omc-config.json"

if [ -f "$CONFIG_FILE" ] && grep -q '"defaultExecutionMode"' "$CONFIG_FILE" 2>/dev/null; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "WARNING: jq is required to clear the retired defaultExecutionMode key from $CONFIG_FILE."
    echo "The stale value is harmless (no runtime reads it), but install jq and rerun setup to clean it."
  else
    TEMP_FILE=$(mktemp "${CONFIG_FILE}.tmp.XXXXXX")
    trap 'rm -f "$TEMP_FILE"' EXIT
    if jq 'del(.defaultExecutionMode)' "$CONFIG_FILE" > "$TEMP_FILE" \
      && mv "$TEMP_FILE" "$CONFIG_FILE"; then
      echo "Cleared retired defaultExecutionMode key (ultrawork was removed in 5.0.0)"
    else
      echo "WARNING: Failed to clear retired defaultExecutionMode. Existing config was not modified."
      rm -f "$TEMP_FILE"
    fi
    trap - EXIT
  fi
fi
```

**Note:** Never write a new `defaultExecutionMode` value. Generic keywords no longer route through a configured execution mode; invoke `/oh-my-claudecode:execute` or `/oh-my-claudecode:team` directly instead.

**Resume-only boundary:** If `RESUMED_PHASE_TWO_BOUNDARY` is `true`, stop Phase 2 after this cleanup. Do not execute Steps 2.5 or 2.6, do not prompt for task-tool or team settings again, and do not save a new progress value. Return to the setup orchestrator with the original `RESUME_LAST_COMPLETED_STEP` unchanged.

## Step 2.5: Install OMC CLI Tool

The OMC CLI (`omc` command) provides standalone helper commands such as `omc hud`, `omc teleport`, and `omc team ...`.

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

**Question:** "Would you like to install the OMC CLI globally for standalone helper commands? (`omc`, `omc hud`, `omc teleport`)"

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
1. **Built-in Tasks (default)** - Use Claude Code's native TodoWrite or available task-list surface. Tasks are session-only.
2. **Beads (bd)** - Git-backed persistent tasks. Survives across sessions. [Only if detected]
3. **Beads-Rust (br)** - Lightweight Rust port of beads. [Only if detected]

(Only show options 2/3 if the corresponding tool is detected)

Store the preference:

```bash
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$CONFIG_DIR" in
  "~") CONFIG_DIR="$HOME" ;;
  "~/"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~/}" ;;
  "~\\"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~\\}" ;;
esac
CONFIG_FILE="$CONFIG_DIR/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to update $CONFIG_FILE safely."
  echo "Install jq and rerun setup. Existing config was not modified."
  exit 1
fi

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi

# USER_CHOICE is "builtin", "beads", or "beads-rust" based on user selection
TEMP_FILE=$(mktemp "${CONFIG_FILE}.tmp.XXXXXX")
trap 'rm -f "$TEMP_FILE"' EXIT
if printf '%s\n' "$EXISTING" | jq --arg tool "USER_CHOICE" '. + {taskTool: $tool, taskToolConfig: {injectInstructions: true, useMcp: false}}' > "$TEMP_FILE" \
  && mv "$TEMP_FILE" "$CONFIG_FILE"; then
  :
else
  echo "ERROR: Failed to update $CONFIG_FILE. Existing config was not modified."
  rm -f "$TEMP_FILE"
  exit 1
fi
trap - EXIT
echo "Task tool set to: USER_CHOICE"
```

**Note:** The beads context instructions will be injected automatically on the next session start.

## Save Progress

```bash
CONFIG_TYPE=$(jq -r '.configType // "unknown"' ".omc/state/setup-state.json" 2>/dev/null || echo "unknown")
if [ "${RESUMED_PHASE_TWO_BOUNDARY:-false}" != "true" ]; then
  bash "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.sh" save 4 "$CONFIG_TYPE"
else
  echo "Resumed Phase 2: preserving lastCompletedStep=$RESUME_LAST_COMPLETED_STEP"
fi
```
