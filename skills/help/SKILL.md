---
name: help
description: Guide on using oh-my-claudecode plugin
---

# How OMC Works

**You don't need to learn any commands!** OMC enhances Claude Code with intelligent behaviors that activate automatically.

## What Happens Automatically

| When You... | I Automatically... |
|-------------|-------------------|
| Give me a complex task | Parallelize and delegate to specialist agents |
| Ask me to plan something | Start a planning interview |
| Need something done completely | Persist until verified complete |
| Work on UI/frontend | Activate design sensibility |
| Say "stop" or "cancel" | Intelligently stop current operation |

## Magic Keywords (Optional Shortcuts)

You can include these words naturally in your request for explicit control:

| Keyword | Effect | Example |
|---------|--------|---------|
| **ralph** | Persistence mode | "ralph: fix all the bugs" |
| **ralplan** | Iterative planning | "ralplan this feature" |
| **ulw** | Max parallelism | "ulw refactor the API" |
| **plan** | Planning interview | "plan the new endpoints" |

**ralph includes ultrawork:** When you activate ralph mode, it automatically includes ultrawork's parallel execution. No need to combine keywords.

## Stopping Things

Just say:
- "stop"
- "cancel"
- "abort"

I'll figure out what to stop based on context.

## First Time Setup

If you haven't configured OMC yet:

```
/oh-my-claudecode:omc-setup
```

This is the **only command** you need to know. It downloads the configuration and you're done.

## For 2.x Users

Your old commands still work! `/ralph`, `/ultrawork`, `/plan`, etc. all function exactly as before.

But now you don't NEED them - everything is automatic.

---

## Usage Analysis

Analyze your oh-my-claudecode usage and get tailored recommendations to improve your workflow.

> Note: This replaces the former `/oh-my-claudecode:learn-about-omc` skill.

### What It Does

1. Reads token tracking from `~/.omc/state/token-tracking.jsonl`
2. Reads session history from `.omc/state/session-history.json`
3. Analyzes agent usage patterns
4. Identifies underutilized features
5. Recommends configuration changes

### Step 1: Gather Data

```bash
# Check for token tracking data
TOKEN_FILE="$HOME/.omc/state/token-tracking.jsonl"
SESSION_FILE=".omc/state/session-history.json"
CONFIG_FILE="$HOME/.claude/.omc-config.json"

echo "Analyzing OMC Usage..."
echo ""

# Check what data is available
HAS_TOKENS=false
HAS_SESSIONS=false
HAS_CONFIG=false

if [[ -f "$TOKEN_FILE" ]]; then
  HAS_TOKENS=true
  TOKEN_COUNT=$(wc -l < "$TOKEN_FILE")
  echo "Token records found: $TOKEN_COUNT"
fi

if [[ -f "$SESSION_FILE" ]]; then
  HAS_SESSIONS=true
  SESSION_COUNT=$(cat "$SESSION_FILE" | jq '.sessions | length' 2>/dev/null || echo "0")
  echo "Sessions found: $SESSION_COUNT"
fi

if [[ -f "$CONFIG_FILE" ]]; then
  HAS_CONFIG=true
  DEFAULT_MODE=$(cat "$CONFIG_FILE" | jq -r '.defaultExecutionMode // "not set"')
  echo "Default execution mode: $DEFAULT_MODE"
fi
```

### Step 2: Analyze Agent Usage (if token data exists)

```bash
if [[ "$HAS_TOKENS" == "true" ]]; then
  echo ""
  echo "TOP AGENTS BY USAGE:"
  cat "$TOKEN_FILE" | jq -r '.agentName // "main"' | sort | uniq -c | sort -rn | head -10

  echo ""
  echo "MODEL DISTRIBUTION:"
  cat "$TOKEN_FILE" | jq -r '.modelName' | sort | uniq -c | sort -rn
fi
```

### Step 3: Generate Recommendations

Based on patterns found, output recommendations:

**If high Opus usage (>40%) and no ecomode:**
- "Consider using ecomode for routine tasks to save tokens"

**If no pipeline usage:**
- "Try /pipeline for code review workflows"

**If no security-reviewer usage:**
- "Use security-reviewer after auth/API changes"

**If defaultExecutionMode not set:**
- "Set defaultExecutionMode in /omc-setup for consistent behavior"

### Step 4: Output Report

Format a summary with:
- Token summary (total, by model)
- Top agents used
- Underutilized features
- Personalized recommendations

### Example Output

```
📊 Your OMC Usage Analysis

TOKEN SUMMARY:
- Total records: 1,234
- By Model: opus 45%, sonnet 40%, haiku 15%

TOP AGENTS:
1. executor (234 uses)
2. architect (89 uses)
3. explore (67 uses)

UNDERUTILIZED FEATURES:
- ecomode: 0 uses (could save ~30% on routine tasks)
- pipeline: 0 uses (great for review workflows)

RECOMMENDATIONS:
1. Set defaultExecutionMode: "ecomode" to save tokens
2. Try /pipeline review for PR reviews
3. Use explore agent before architect to save context
```

### Graceful Degradation

If no data found:

```
📊 Limited Usage Data Available

No token tracking found. To enable tracking:
1. Ensure ~/.omc/state/ directory exists
2. Run any OMC command to start tracking

Tip: Run /omc-setup to configure OMC properly.
```

## Need More Help?

- **README**: https://github.com/Yeachan-Heo/oh-my-claudecode
- **Issues**: https://github.com/Yeachan-Heo/oh-my-claudecode/issues

---

*Version: 4.1.0*
