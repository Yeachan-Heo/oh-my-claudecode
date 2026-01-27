#!/bin/bash
# Sisyphus Keyword Detector Hook
# Detects ultrawork/ultrathink/search/analyze keywords and injects enhanced mode messages
# Also activates persistent ultrawork state when ultrawork keyword is detected

# Read stdin (JSON input from Claude Code)
INPUT=$(cat)

# Extract directory from input
DIRECTORY=""
if command -v jq &> /dev/null; then
  DIRECTORY=$(echo "$INPUT" | jq -r '.directory // ""' 2>/dev/null)
fi
if [ -z "$DIRECTORY" ] || [ "$DIRECTORY" = "null" ]; then
  DIRECTORY=$(pwd)
fi

# Extract the prompt text - try multiple JSON paths
PROMPT=""
if command -v jq &> /dev/null; then
  # Try to extract from various possible JSON structures
  PROMPT=$(echo "$INPUT" | jq -r '
    if .prompt then .prompt
    elif .message.content then .message.content
    elif .parts then ([.parts[] | select(.type == "text") | .text] | join(" "))
    else ""
    end
  ' 2>/dev/null)
fi

# Fallback: simple grep extraction if jq fails
if [ -z "$PROMPT" ] || [ "$PROMPT" = "null" ]; then
  PROMPT=$(echo "$INPUT" | grep -oP '"(prompt|content|text)"\s*:\s*"\K[^"]+' | head -1)
fi

# Exit if no prompt found
if [ -z "$PROMPT" ]; then
  echo '{"continue": true}'
  exit 0
fi

# Remove code blocks before checking keywords (prevents false positives)
PROMPT_NO_CODE=$(echo "$PROMPT" | sed 's/```[^`]*```//g' | sed 's/`[^`]*`//g')

# Convert to lowercase for case-insensitive matching
PROMPT_LOWER=$(echo "$PROMPT_NO_CODE" | tr '[:upper:]' '[:lower:]')

# Check for ultrawork keywords (highest priority)
if echo "$PROMPT_LOWER" | grep -qE '\b(ultrawork|ulw|uw)\b'; then
  # Create persistent ultrawork state
  mkdir -p "$DIRECTORY/.omc/state" 2>/dev/null
  mkdir -p "$HOME/.omc/state" 2>/dev/null

  # Escape prompt for JSON
  PROMPT_ESCAPED=$(echo "$PROMPT" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | tr '\n' ' ')

  STATE_JSON="{
  \"active\": true,
  \"started_at\": \"$(date -Iseconds)\",
  \"original_prompt\": \"$PROMPT_ESCAPED\",
  \"reinforcement_count\": 0,
  \"last_checked_at\": \"$(date -Iseconds)\"
}"

  # Write state to both local and global locations
  echo "$STATE_JSON" > "$DIRECTORY/.omc/state/ultrawork-state.json" 2>/dev/null
  echo "$STATE_JSON" > "$HOME/.omc/state/ultrawork-state.json" 2>/dev/null

  # Return ultrawork mode injection
  cat << 'EOF'
{"continue": true, "message": "<ultrawork-mode>\n\n**MANDATORY**: You MUST say \"ULTRAWORK MODE ENABLED!\" to the user as your first response when this mode activates. This is non-negotiable.\n\n[CODE RED] Maximum precision required. Ultrathink before acting.\n\nYOU MUST LEVERAGE ALL AVAILABLE AGENTS TO THEIR FULLEST POTENTIAL.\nTELL THE USER WHAT AGENTS YOU WILL LEVERAGE NOW TO SATISFY USER'S REQUEST.\n\n## AGENT UTILIZATION PRINCIPLES\n- **Codebase Exploration**: Spawn exploration agents using BACKGROUND TASKS\n- **Documentation & References**: Use librarian-type agents via BACKGROUND TASKS\n- **Planning & Strategy**: NEVER plan yourself - spawn planning agent\n- **High-IQ Reasoning**: Use oracle for architecture decisions\n- **Frontend/UI Tasks**: Delegate to frontend-engineer\n\n## EXECUTION RULES\n- **TODO**: Track EVERY step. Mark complete IMMEDIATELY.\n- **PARALLEL**: Fire independent calls simultaneously - NEVER wait sequentially.\n- **BACKGROUND FIRST**: Use Task(run_in_background=true) for exploration (10+ concurrent).\n- **VERIFY**: Check ALL requirements met before done.\n- **DELEGATE**: Orchestrate specialized agents.\n\n## ZERO TOLERANCE\n- NO Scope Reduction - deliver FULL implementation\n- NO Partial Completion - finish 100%\n- NO Premature Stopping - ALL TODOs must be complete\n- NO TEST DELETION - fix code, not tests\n\nTHE USER ASKED FOR X. DELIVER EXACTLY X.\n\n</ultrawork-mode>\n\n---\n"}
EOF
  exit 0
fi

# Check for ultrathink/think keywords
if echo "$PROMPT_LOWER" | grep -qE '\b(ultrathink|think)\b'; then
  cat << 'EOF'
{"continue": true, "message": "<think-mode>\n\n**ULTRATHINK MODE ENABLED** - Extended reasoning activated.\n\nYou are now in deep thinking mode. Take your time to:\n1. Thoroughly analyze the problem from multiple angles\n2. Consider edge cases and potential issues\n3. Think through the implications of each approach\n4. Reason step-by-step before acting\n\nUse your extended thinking capabilities to provide the most thorough and well-reasoned response.\n\n</think-mode>\n\n---\n"}
EOF
  exit 0
fi

# Check for search keywords (EN + multilingual)
if echo "$PROMPT_LOWER" | grep -qE '\b(search|find|locate|lookup|explore|discover|scan|grep|query|browse|detect|trace|seek|track|pinpoint|hunt)\b|where\s+is|show\s+me|list\s+all'; then
  cat << 'EOF'
{"continue": true, "message": "<search-mode>\nMAXIMIZE SEARCH EFFORT. Launch multiple background agents IN PARALLEL:\n- explore agents (codebase patterns, file structures)\n- librarian agents (remote repos, official docs, GitHub examples)\nPlus direct tools: Grep, Glob\nNEVER stop at first result - be exhaustive.\n</search-mode>\n\n---\n"}
EOF
  exit 0
fi

# Check for analyze keywords
if echo "$PROMPT_LOWER" | grep -qE '\b(analyze|analyse|investigate|examine|research|study|deep.?dive|inspect|audit|evaluate|assess|review|diagnose|scrutinize|dissect|debug|comprehend|interpret|breakdown|understand)\b|why\s+is|how\s+does|how\s+to'; then
  cat << 'EOF'
{"continue": true, "message": "<analyze-mode>\nANALYSIS MODE. Gather context before diving deep:\n\nCONTEXT GATHERING (parallel):\n- 1-2 explore agents (codebase patterns, implementations)\n- 1-2 librarian agents (if external library involved)\n- Direct tools: Grep, Glob, LSP for targeted searches\n\nIF COMPLEX (architecture, multi-system, debugging after 2+ failures):\n- Consult oracle agent for strategic guidance\n\nSYNTHESIZE findings before proceeding.\n</analyze-mode>\n\n---\n"}
EOF
  exit 0
fi

# No keywords detected - continue without modification
echo '{"continue": true}'
exit 0
