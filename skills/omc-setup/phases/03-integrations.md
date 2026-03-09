# Phase 3: Integration Setup

**Skip condition**: If resuming and `lastCompletedStep >= 6`, skip this entire phase.

## Step 3.1: Verify Plugin Installation

```bash
grep -q "oh-my-claudecode" ~/.claude/settings.json && echo "Plugin verified" || echo "Plugin NOT found - run: claude /install-plugin oh-my-claudecode"
```

## Step 3.2: Offer MCP Server Configuration

MCP servers extend Claude Code with additional tools (web search, GitHub, etc.).

Use AskUserQuestion: "Would you like to configure MCP servers for enhanced capabilities? (Context7, Exa search, GitHub, etc.)"

If yes, invoke the mcp-setup skill:
```
/oh-my-claudecode:mcp-setup
```

If no, skip to next step.

## Step 3.3: Configure Agent Teams (Optional)

Agent teams are an experimental Claude Code feature that lets you spawn N coordinated agents working on a shared task list with inter-agent messaging. **Teams are disabled by default** and require enabling via `settings.json`.

Reference: https://code.claude.com/docs/en/agent-teams

Use AskUserQuestion:

**Question:** "Would you like to enable agent teams? Teams let you spawn coordinated agents (e.g., `/team 3:executor 'fix all errors'`). This is an experimental Claude Code feature."

**Options:**
1. **Yes, enable teams (Recommended)** - Enable the experimental feature and configure defaults
2. **No, skip** - Leave teams disabled (can enable later)

### If User Chooses YES:

#### 3.3.1: Enable Agent Teams in settings.json

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

Use jq to safely merge without overwriting existing settings:

```bash
SETTINGS_FILE="$HOME/.claude/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
  TEMP_FILE=$(mktemp)
  jq '.env = (.env // {} | . + {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"})' "$SETTINGS_FILE" > "$TEMP_FILE" && mv "$TEMP_FILE" "$SETTINGS_FILE"
  echo "Added CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS to existing settings.json"
else
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

#### 3.3.2: Configure Teammate Display Mode

Use AskUserQuestion:

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

#### 3.3.3: Configure Team Defaults in omc-config

Use AskUserQuestion with multiple questions:

**Question 1:** "How many agents should teams spawn by default?"

**Options:**
1. **3 agents (Recommended)** - Good balance of speed and resource usage
2. **5 agents (maximum)** - Maximum parallelism for large tasks
3. **2 agents** - Conservative, for smaller projects

**Question 2:** "Which agent type should teammates use by default?"

**Options:**
1. **executor (Recommended)** - General-purpose code implementation agent
2. **debugger** - Specialized for build/type error fixing and debugging
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

if jq empty "$SETTINGS_FILE" 2>/dev/null; then
  echo "settings.json: valid JSON"
else
  echo "ERROR: settings.json is invalid JSON! Restoring from backup..."
  exit 1
fi

if jq -e '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' "$SETTINGS_FILE" > /dev/null 2>&1; then
  echo "Agent teams: ENABLED"
else
  echo "WARNING: Agent teams env var not found in settings.json"
fi

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

## Save Progress

```bash
CONFIG_TYPE=$(jq -r '.configType // "unknown"' ".omc/state/setup-state.json" 2>/dev/null || echo "unknown")
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-progress.sh" save 6 "$CONFIG_TYPE"
```
