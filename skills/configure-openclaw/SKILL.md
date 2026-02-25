---
name: configure-openclaw
description: Configure OpenClaw gateway integration for waking external automations and AI agents on hook events
triggers:
  - "configure openclaw"
  - "setup openclaw"
  - "openclaw gateway"
  - "openclaw setup"
---

# Configure OpenClaw

Set up OpenClaw so OMC can wake external gateways — triggering automations, workflows, or AI agents — when hook events fire during Claude sessions.

OpenClaw is NOT a notification system. It sends structured instruction payloads to programmable HTTPS endpoints. This makes it ideal for triggering n8n workflows, custom AI agents, webhook automations, or any HTTPS-capable system.

---

## How This Skill Works

This is an interactive, natural-language configuration skill. Walk the user through setup by asking questions with AskUserQuestion. Write the result to `~/.claude/omc_config.openclaw.json`.

---

## Step 1: Detect Existing Configuration

```bash
CONFIG_FILE="${OMC_OPENCLAW_CONFIG:-$HOME/.claude/omc_config.openclaw.json}"

if [ -f "$CONFIG_FILE" ]; then
  IS_ENABLED=$(jq -r '.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  GATEWAY_COUNT=$(jq -r '.gateways | keys | length' "$CONFIG_FILE" 2>/dev/null)
  HOOK_COUNT=$(jq -r '[.hooks | to_entries[] | select(.value.enabled == true)] | length' "$CONFIG_FILE" 2>/dev/null)

  if [ "$IS_ENABLED" = "true" ]; then
    echo "EXISTING_CONFIG=true"
    echo "GATEWAY_COUNT=$GATEWAY_COUNT"
    echo "HOOK_COUNT=$HOOK_COUNT"
  else
    echo "EXISTING_CONFIG=false"
  fi
else
  echo "NO_CONFIG_FILE"
fi
```

If existing config is found, show the user what's currently configured and ask if they want to update or reconfigure.

---

## Step 2: Collect Gateway URL

Use AskUserQuestion:

**Question:** "What is your OpenClaw gateway URL? (Must be HTTPS, e.g. https://my-gateway.example.com/wake)"

The user will type their URL in the "Other" field.

**Validate** the URL:
- Must start with `https://`
- Must be a valid URL
- If invalid, explain the requirement and ask again

---

## Step 3: Collect Auth Header (Optional)

Use AskUserQuestion:

**Question:** "Does your gateway require an Authorization header?"

**Options:**
1. **Yes, Bearer token** - I'll provide a Bearer token (e.g., `Bearer sk-...`)
2. **Yes, custom header value** - I'll type the full header value
3. **No auth required** - The gateway is open or uses a different auth method

If user selects option 1 or 2, ask:

**Question:** "Paste your Authorization header value (e.g., `Bearer sk-mytoken123`)"

The user will type the value in the "Other" field.

---

## Step 4: Configure Hook Events

Use AskUserQuestion with multiSelect:

**Question:** "Which hook events should trigger your OpenClaw gateway?"

**Options (multiSelect: true):**
1. **session-start** - When a new Claude session begins. Variables: `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}`
2. **session-end** - When a session ends. Variables: `{{contextSummary}}`, `{{reason}}`, `{{sessionId}}`
3. **stop** - When Claude stops (idle/completion). Variables: `{{sessionId}}`, `{{projectName}}`
4. **pre-tool-use** - Before each tool call (high frequency). Variables: `{{toolName}}`, `{{sessionId}}`
5. **post-tool-use** - After each tool call (high frequency). Variables: `{{toolName}}`, `{{sessionId}}`
6. **keyword-detector** - On every prompt submission. Variables: `{{prompt}}`, `{{sessionId}}`
7. **ask-user-question** - When Claude needs user input. Variables: `{{question}}`, `{{sessionId}}`

Default selection: session-start, session-end, stop.

**Note:** pre-tool-use, post-tool-use, and keyword-detector fire very frequently. Only enable them if your gateway can handle the volume.

---

## Step 5: Collect Instruction Templates

For each selected event, ask the user for an instruction template. Show the available template variables for that event type.

Use AskUserQuestion for each event:

**Example for session-start:**

**Question:** "Instruction template for `session-start` events. Available variables: `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}`, `{{timestamp}}`"

**Options:**
1. **Use default** - "Session started for project {{projectName}}"
2. **Custom** - Enter my own instruction text

**Example for session-end:**

**Question:** "Instruction template for `session-end` events. Available variables: `{{sessionId}}`, `{{projectName}}`, `{{contextSummary}}`, `{{reason}}`, `{{timestamp}}`"

**Options:**
1. **Use default** - "Session ended. Summary: {{contextSummary}}"
2. **Custom** - Enter my own instruction text

**Example for stop:**

**Question:** "Instruction template for `stop` events. Available variables: `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}`, `{{timestamp}}`"

**Options:**
1. **Use default** - "Session stopping for project {{projectName}}"
2. **Custom** - Enter my own instruction text

**Example for pre-tool-use:**

**Question:** "Instruction template for `pre-tool-use` events. Available variables: `{{toolName}}`, `{{sessionId}}`, `{{projectName}}`, `{{timestamp}}`"

**Options:**
1. **Use default** - "Tool {{toolName}} about to be used"
2. **Custom** - Enter my own instruction text

**Example for post-tool-use:**

**Question:** "Instruction template for `post-tool-use` events. Available variables: `{{toolName}}`, `{{sessionId}}`, `{{projectName}}`, `{{timestamp}}`"

**Options:**
1. **Use default** - "Tool {{toolName}} completed"
2. **Custom** - Enter my own instruction text

**Example for keyword-detector:**

**Question:** "Instruction template for `keyword-detector` events. Available variables: `{{prompt}}`, `{{sessionId}}`, `{{projectName}}`, `{{timestamp}}`"

**Options:**
1. **Use default** - "Keyword detected: {{prompt}}"
2. **Custom** - Enter my own instruction text

**Example for ask-user-question:**

**Question:** "Instruction template for `ask-user-question` events. Available variables: `{{question}}`, `{{sessionId}}`, `{{projectName}}`, `{{timestamp}}`"

**Options:**
1. **Use default** - "User input requested: {{question}}"
2. **Custom** - Enter my own instruction text

---

## Step 6: Write Configuration

Build and write the config to `~/.claude/omc_config.openclaw.json`:

```bash
CONFIG_FILE="${OMC_OPENCLAW_CONFIG:-$HOME/.claude/omc_config.openclaw.json}"
mkdir -p "$(dirname "$CONFIG_FILE")"

# GATEWAY_URL, AUTH_HEADER, and per-event instructions are collected from user
# SELECTED_EVENTS is the list of enabled hook events
# Build the JSON using jq

# Example: session-start and session-end selected, bearer auth
jq -n \
  --arg gateway_url "$GATEWAY_URL" \
  --arg auth_header "$AUTH_HEADER" \
  --arg session_start_instruction "$SESSION_START_INSTRUCTION" \
  --arg session_end_instruction "$SESSION_END_INSTRUCTION" \
  --arg stop_instruction "$STOP_INSTRUCTION" \
  '{
    enabled: true,
    gateways: {
      "my-gateway": {
        url: $gateway_url,
        headers: (if $auth_header != "" then {"Authorization": $auth_header} else {} end),
        method: "POST",
        timeout: 10000
      }
    },
    hooks: {
      "session-start": {gateway: "my-gateway", instruction: $session_start_instruction, enabled: true},
      "session-end": {gateway: "my-gateway", instruction: $session_end_instruction, enabled: true},
      "stop": {gateway: "my-gateway", instruction: $stop_instruction, enabled: true}
    }
  }' > "$CONFIG_FILE"
```

Adjust the hooks object to include only the events the user selected, with their chosen instructions.

---

## Step 7: Test the Gateway

After writing config, offer to send a test wake call:

Use AskUserQuestion:

**Question:** "Send a test wake call to your gateway to verify the connection?"

**Options:**
1. **Yes, test now (Recommended)** - Send a test HTTP POST to the gateway
2. **No, I'll test later** - Skip testing

If testing:

```bash
GATEWAY_URL="USER_PROVIDED_URL"
AUTH_HEADER="USER_PROVIDED_AUTH_HEADER"  # may be empty

# Build auth header arg
AUTH_ARG=""
if [ -n "$AUTH_HEADER" ]; then
  AUTH_ARG="-H \"Authorization: $AUTH_HEADER\""
fi

RESPONSE=$(eval curl -s -w "\n%{http_code}" \
  -H "Content-Type: application/json" \
  $AUTH_ARG \
  -d '{"event":"session-start","instruction":"OpenClaw test wake from OMC configure wizard","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","context":{}}' \
  "$GATEWAY_URL")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -1)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "202" ] || [ "$HTTP_CODE" = "204" ]; then
  echo "Test wake succeeded (HTTP $HTTP_CODE)!"
else
  echo "Test wake failed (HTTP $HTTP_CODE):"
  echo "$BODY"
fi
```

Report success or failure. Common issues:
- **401 Unauthorized**: Auth header is missing or incorrect
- **403 Forbidden**: Token does not have permission
- **404 Not Found**: Gateway URL path is incorrect
- **SSL error**: URL must be HTTPS with a valid certificate
- **Connection refused**: Gateway is not running or URL is wrong

---

## Step 8: Confirm

Display the final configuration summary:

```
OpenClaw Gateway Configured!

  Gateway:  https://my-gateway.example.com/wake
  Auth:     Bearer *** (configured)
  Events:   session-start, session-end, stop

Config saved to: ~/.claude/omc_config.openclaw.json

To activate OpenClaw, use one of:
  omc --openclaw                  (per-session flag)
  export OMC_OPENCLAW=1           (environment variable)

Debug logging:
  export OMC_OPENCLAW_DEBUG=1     (logs wake results to stderr)

Custom config path:
  export OMC_OPENCLAW_CONFIG=/path/to/config.json

To reconfigure: /oh-my-claudecode:configure-openclaw
```

---

## Template Variables Reference

| Event | Available Variables |
|-------|-------------------|
| `session-start` | `{{sessionId}}`, `{{projectPath}}`, `{{projectName}}`, `{{timestamp}}`, `{{event}}` |
| `session-end` | `{{sessionId}}`, `{{projectPath}}`, `{{projectName}}`, `{{contextSummary}}`, `{{reason}}`, `{{timestamp}}`, `{{event}}` |
| `pre-tool-use` | `{{sessionId}}`, `{{projectPath}}`, `{{projectName}}`, `{{toolName}}`, `{{timestamp}}`, `{{event}}` |
| `post-tool-use` | `{{sessionId}}`, `{{projectPath}}`, `{{projectName}}`, `{{toolName}}`, `{{timestamp}}`, `{{event}}` |
| `stop` | `{{sessionId}}`, `{{projectPath}}`, `{{projectName}}`, `{{timestamp}}`, `{{event}}` |
| `keyword-detector` | `{{sessionId}}`, `{{projectPath}}`, `{{projectName}}`, `{{prompt}}`, `{{timestamp}}`, `{{event}}` |
| `ask-user-question` | `{{sessionId}}`, `{{projectPath}}`, `{{projectName}}`, `{{question}}`, `{{timestamp}}`, `{{event}}` |

Unresolved variables (e.g., `{{unknown}}`) are left as-is in the instruction text.

---

## Environment Variable Alternative

Users can skip this wizard entirely by setting env vars and writing the config manually:

```bash
# Enable OpenClaw
export OMC_OPENCLAW=1

# Optional: override config file path
export OMC_OPENCLAW_CONFIG="$HOME/.claude/omc_config.openclaw.json"

# Optional: enable debug logging
export OMC_OPENCLAW_DEBUG=1
```

The config file path defaults to `~/.claude/omc_config.openclaw.json`. Use `OMC_OPENCLAW_CONFIG` to override.
