---
name: learn-about-omc
description: Analyze your OMC usage patterns and get personalized recommendations
---

## Cross-Platform Compatibility

**IMPORTANT (Windows Git Bash)**: Bash scripts in this template that contain `$(...)` command substitution MUST be executed using a temp file approach to avoid escaping issues:
1. Use the **Write tool** to save the script content to a temporary file in the current directory (e.g., `./omc-learn.sh`)
2. Use the **Bash tool** to execute: `bash ./omc-learn.sh`
3. Clean up: `rm -f ./omc-learn.sh`

Do NOT paste scripts containing `$(...)` directly into the Bash tool command parameter.

# Learn About OMC

Analyzes your oh-my-claudecode usage and provides tailored recommendations to improve your workflow.

## What It Does

1. Reads token tracking from `~/.omc/state/token-tracking.jsonl`
2. Reads session history from `.omc/state/session-history.json`
3. Analyzes agent usage patterns
4. Identifies underutilized features
5. Recommends configuration changes

## Implementation

### Step 1: Gather Data

```bash
# Check for token tracking data
TOKEN_FILE="$HOME/.omc/state/token-tracking.jsonl"
SESSION_FILE=".omc/state/session-history.json"
CONFIG_FILE="$HOME/.claude/.omc-config.json"

echo "📊 Analyzing OMC Usage..."
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

Format a nice summary with:
- Token summary (total, by model)
- Top agents used
- Underutilized features
- Personalized recommendations

### Graceful Degradation

If no data found:
```
📊 Limited Usage Data Available

No token tracking found. To enable tracking:
1. Ensure ~/.omc/state/ directory exists
2. Run any OMC command to start tracking

Tip: Run /omc-setup to configure OMC properly.
```

## Example Output

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
