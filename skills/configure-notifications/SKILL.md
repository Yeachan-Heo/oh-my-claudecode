---
name: configure-notifications
description: Configure notification integrations (Telegram, Discord, Slack) via natural language
triggers:
  - "configure notifications"
  - "setup notifications"
  - "configure telegram"
  - "setup telegram"
  - "telegram bot"
  - "configure discord"
  - "setup discord"
  - "discord webhook"
  - "configure slack"
  - "setup slack"
  - "slack webhook"
---

# Configure Notifications

Set up OMC notification integrations so you're alerted when sessions end, need input, or complete background tasks.

## Routing

Detect which provider the user wants based on their request or argument:
- If the trigger or argument contains "telegram" → follow the **Telegram** section
- If the trigger or argument contains "discord" → follow the **Discord** section
- If the trigger or argument contains "slack" → follow the **Slack** section
- If no provider is specified, use AskUserQuestion:

**Question:** "Which notification service would you like to configure?"

**Options:**
1. **Telegram** - Bot token + chat ID. Works on mobile and desktop.
2. **Discord** - Webhook or bot token + channel ID.
3. **Slack** - Incoming webhook URL.

---

## Telegram Setup

Set up Telegram notifications so OMC can message you when sessions end, need input, or complete background tasks.

### How This Skill Works

This is an interactive, natural-language configuration skill. Walk the user through setup by asking questions with AskUserQuestion. Write the result to `~/.claude/.omc-config.json`.

### Step 1: Detect Existing Configuration

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"

if [ -f "$CONFIG_FILE" ]; then
  HAS_TELEGRAM=$(jq -r '.notifications.telegram.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  CHAT_ID=$(jq -r '.notifications.telegram.chatId // empty' "$CONFIG_FILE" 2>/dev/null)
  PARSE_MODE=$(jq -r '.notifications.telegram.parseMode // "Markdown"' "$CONFIG_FILE" 2>/dev/null)

  if [ "$HAS_TELEGRAM" = "true" ]; then
    echo "EXISTING_CONFIG=true"
    echo "CHAT_ID=$CHAT_ID"
    echo "PARSE_MODE=$PARSE_MODE"
  else
    echo "EXISTING_CONFIG=false"
  fi
else
  echo "NO_CONFIG_FILE"
fi
```

If existing config is found, show the user what's currently configured and ask if they want to update or reconfigure.

### Step 2: Create a Telegram Bot

Guide the user through creating a bot if they don't have one:

```
To set up Telegram notifications, you need a Telegram bot token and your chat ID.

CREATE A BOT (if you don't have one):
1. Open Telegram and search for @BotFather
2. Send /newbot
3. Choose a name (e.g., "My OMC Notifier")
4. Choose a username (e.g., "my_omc_bot")
5. BotFather will give you a token like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz

GET YOUR CHAT ID:
1. Start a chat with your new bot (send /start)
2. Visit: https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
3. Look for "chat":{"id":YOUR_CHAT_ID}
   - Personal chat IDs are positive numbers (e.g., 123456789)
   - Group chat IDs are negative numbers (e.g., -1001234567890)
```

### Step 3: Collect Bot Token

Use AskUserQuestion:

**Question:** "Paste your Telegram bot token (from @BotFather)"

The user will type their token in the "Other" field.

**Validate** the token:
- Must match pattern: `digits:alphanumeric` (e.g., `123456789:ABCdefGHI...`)
- If invalid, explain the format and ask again

### Step 4: Collect Chat ID

Use AskUserQuestion:

**Question:** "Paste your Telegram chat ID (the number from getUpdates API)"

The user will type their chat ID in the "Other" field.

**Validate** the chat ID:
- Must be a number (positive for personal, negative for groups)
- If invalid, offer to help them find it:

```bash
# Help user find their chat ID
BOT_TOKEN="USER_PROVIDED_TOKEN"
echo "Fetching recent messages to find your chat ID..."
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates" | jq '.result[-1].message.chat.id // .result[-1].message.from.id // "No messages found - send /start to your bot first"'
```

### Step 5: Choose Parse Mode

Use AskUserQuestion:

**Question:** "Which message format do you prefer?"

**Options:**
1. **Markdown (Recommended)** - Bold, italic, code blocks with Markdown syntax
2. **HTML** - Bold, italic, code with HTML tags

### Step 6: Configure Events

Use AskUserQuestion with multiSelect:

**Question:** "Which events should trigger Telegram notifications?"

**Options (multiSelect: true):**
1. **Session end (Recommended)** - When a Claude session finishes
2. **Input needed** - When Claude is waiting for your response (great for long-running tasks)
3. **Session start** - When a new session begins
4. **Session continuing** - When a persistent mode keeps the session alive

Default selection: session-end + ask-user-question.

### Step 7: Write Configuration

Read the existing config, merge the new Telegram settings, and write back:

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi

# BOT_TOKEN, CHAT_ID, PARSE_MODE are collected from user
echo "$EXISTING" | jq \
  --arg token "$BOT_TOKEN" \
  --arg chatId "$CHAT_ID" \
  --arg parseMode "$PARSE_MODE" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications.telegram = {
     enabled: true,
     botToken: $token,
     chatId: $chatId,
     parseMode: $parseMode
   }' > "$CONFIG_FILE"
```

#### Add event-specific config if user didn't select all events:

For each event NOT selected, disable it:

```bash
# Example: disable session-start if not selected
echo "$(cat "$CONFIG_FILE")" | jq \
  '.notifications.events = (.notifications.events // {}) |
   .notifications.events["session-start"] = {enabled: false}' > "$CONFIG_FILE"
```

### Step 8: Test the Configuration

After writing config, offer to send a test notification:

Use AskUserQuestion:

**Question:** "Send a test notification to verify the setup?"

**Options:**
1. **Yes, test now (Recommended)** - Send a test message to your Telegram chat
2. **No, I'll test later** - Skip testing

#### If testing:

```bash
BOT_TOKEN="USER_PROVIDED_TOKEN"
CHAT_ID="USER_PROVIDED_CHAT_ID"
PARSE_MODE="Markdown"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "parse_mode=${PARSE_MODE}" \
  -d "text=OMC test notification - Telegram is configured!")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "Test notification sent successfully!"
else
  echo "Failed (HTTP $HTTP_CODE):"
  echo "$BODY" | jq -r '.description // "Unknown error"' 2>/dev/null || echo "$BODY"
fi
```

Report success or failure. Common issues:
- **401 Unauthorized**: Bot token is invalid
- **400 Bad Request: chat not found**: Chat ID is wrong, or user hasn't sent `/start` to the bot
- **Network error**: Check connectivity to api.telegram.org

### Step 9: Confirm

Display the final configuration summary:

```
Telegram Notifications Configured!

  Bot:        @your_bot_username
  Chat ID:    123456789
  Format:     Markdown
  Events:     session-end, ask-user-question

Config saved to: ~/.claude/.omc-config.json

You can also set these via environment variables:
  OMC_TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
  OMC_TELEGRAM_CHAT_ID=123456789

To reconfigure: /oh-my-claudecode:configure-notifications telegram
To configure Discord: /oh-my-claudecode:configure-notifications discord
To configure Slack: /oh-my-claudecode:configure-notifications slack
```

### Environment Variable Alternative

Users can skip this wizard entirely by setting env vars in their shell profile:

```bash
export OMC_TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
export OMC_TELEGRAM_CHAT_ID="123456789"
```

Env vars are auto-detected by the notification system without needing `.omc-config.json`.

---

## Discord Setup

Set up Discord notifications so OMC can ping you when sessions end, need input, or complete background tasks.

### How This Skill Works

This is an interactive, natural-language configuration skill. Walk the user through setup by asking questions with AskUserQuestion. Write the result to `~/.claude/.omc-config.json`.

### Step 1: Detect Existing Configuration

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"

if [ -f "$CONFIG_FILE" ]; then
  # Check for existing discord config
  HAS_DISCORD=$(jq -r '.notifications.discord.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  HAS_DISCORD_BOT=$(jq -r '.notifications["discord-bot"].enabled // false' "$CONFIG_FILE" 2>/dev/null)
  WEBHOOK_URL=$(jq -r '.notifications.discord.webhookUrl // empty' "$CONFIG_FILE" 2>/dev/null)
  MENTION=$(jq -r '.notifications.discord.mention // empty' "$CONFIG_FILE" 2>/dev/null)

  if [ "$HAS_DISCORD" = "true" ] || [ "$HAS_DISCORD_BOT" = "true" ]; then
    echo "EXISTING_CONFIG=true"
    echo "WEBHOOK_CONFIGURED=$HAS_DISCORD"
    echo "BOT_CONFIGURED=$HAS_DISCORD_BOT"
    [ -n "$WEBHOOK_URL" ] && echo "WEBHOOK_URL=$WEBHOOK_URL"
    [ -n "$MENTION" ] && echo "MENTION=$MENTION"
  else
    echo "EXISTING_CONFIG=false"
  fi
else
  echo "NO_CONFIG_FILE"
fi
```

If existing config is found, show the user what's currently configured and ask if they want to update or reconfigure.

### Step 2: Choose Discord Method

Use AskUserQuestion:

**Question:** "How would you like to send Discord notifications?"

**Options:**
1. **Webhook (Recommended)** - Create a webhook in your Discord channel. Simple, no bot needed. Just paste the URL.
2. **Bot API** - Use a Discord bot token + channel ID. More flexible, requires a bot application.

### Step 3A: Webhook Setup

If user chose Webhook:

Use AskUserQuestion:

**Question:** "Paste your Discord webhook URL. To create one: Server Settings > Integrations > Webhooks > New Webhook > Copy URL"

The user will type their webhook URL in the "Other" field.

**Validate** the URL:
- Must start with `https://discord.com/api/webhooks/` or `https://discordapp.com/api/webhooks/`
- If invalid, explain the format and ask again

### Step 3B: Bot API Setup

If user chose Bot API:

Ask two questions:

1. **"Paste your Discord bot token"** - From discord.com/developers > Your App > Bot > Token
2. **"Paste the channel ID"** - Right-click channel > Copy Channel ID (requires Developer Mode)

### Step 4: Configure Mention (User Ping)

Use AskUserQuestion:

**Question:** "Would you like notifications to mention (ping) someone?"

**Options:**
1. **Yes, mention a user** - Tag a specific user by their Discord user ID
2. **Yes, mention a role** - Tag a role by its role ID
3. **No mentions** - Just post the message without pinging anyone

#### If user wants to mention a user:

Ask: "What is the Discord user ID to mention? (Right-click user > Copy User ID, requires Developer Mode)"

The mention format is: `<@USER_ID>` (e.g., `<@1465264645320474637>`)

#### If user wants to mention a role:

Ask: "What is the Discord role ID to mention? (Server Settings > Roles > right-click role > Copy Role ID)"

The mention format is: `<@&ROLE_ID>` (e.g., `<@&123456789>`)

### Step 5: Configure Events

Use AskUserQuestion with multiSelect:

**Question:** "Which events should trigger Discord notifications?"

**Options (multiSelect: true):**
1. **Session end (Recommended)** - When a Claude session finishes
2. **Input needed** - When Claude is waiting for your response (great for long-running tasks)
3. **Session start** - When a new session begins
4. **Session continuing** - When a persistent mode keeps the session alive

Default selection: session-end + ask-user-question.

### Step 6: Optional Username Override

Use AskUserQuestion:

**Question:** "Custom bot display name? (Shows as the webhook sender name in Discord)"

**Options:**
1. **OMC (default)** - Display as "OMC"
2. **Claude Code** - Display as "Claude Code"
3. **Custom** - Enter a custom name

### Step 7: Write Configuration

Read the existing config, merge the new Discord settings, and write back:

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi
```

#### For Webhook method:

Build the notifications object with the collected values and merge into `.omc-config.json` using jq:

```bash
# WEBHOOK_URL, MENTION, USERNAME are collected from user
# EVENTS is the list of enabled events

echo "$EXISTING" | jq \
  --arg url "$WEBHOOK_URL" \
  --arg mention "$MENTION" \
  --arg username "$USERNAME" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications.discord = {
     enabled: true,
     webhookUrl: $url,
     mention: (if $mention == "" then null else $mention end),
     username: (if $username == "" then null else $username end)
   }' > "$CONFIG_FILE"
```

#### For Bot API method:

```bash
echo "$EXISTING" | jq \
  --arg token "$BOT_TOKEN" \
  --arg channel "$CHANNEL_ID" \
  --arg mention "$MENTION" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications["discord-bot"] = {
     enabled: true,
     botToken: $token,
     channelId: $channel,
     mention: (if $mention == "" then null else $mention end)
   }' > "$CONFIG_FILE"
```

#### Add event-specific config if user didn't select all events:

For each event NOT selected, disable it:

```bash
# Example: disable session-start if not selected
echo "$(cat "$CONFIG_FILE")" | jq \
  '.notifications.events = (.notifications.events // {}) |
   .notifications.events["session-start"] = {enabled: false}' > "$CONFIG_FILE"
```

### Step 8: Test the Configuration

After writing config, offer to send a test notification:

Use AskUserQuestion:

**Question:** "Send a test notification to verify the setup?"

**Options:**
1. **Yes, test now (Recommended)** - Send a test message to your Discord channel
2. **No, I'll test later** - Skip testing

#### If testing:

```bash
# For webhook:
curl -s -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"${MENTION:+$MENTION\\n}OMC test notification - Discord is configured!\"}" \
  "$WEBHOOK_URL"
```

Report success or failure. If it fails, help the user debug (check URL, permissions, etc.).

### Step 9: Confirm

Display the final configuration summary:

```
Discord Notifications Configured!

  Method:   Webhook / Bot API
  Mention:  <@1465264645320474637> (or "none")
  Events:   session-end, ask-user-question
  Username: OMC

Config saved to: ~/.claude/.omc-config.json

You can also set these via environment variables:
  OMC_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
  OMC_DISCORD_MENTION=<@1465264645320474637>

To reconfigure: /oh-my-claudecode:configure-notifications discord
To configure Telegram: /oh-my-claudecode:configure-notifications telegram
To configure Slack: /oh-my-claudecode:configure-notifications slack
```

### Environment Variable Alternative

Users can skip this wizard entirely by setting env vars in their shell profile:

**Webhook method:**
```bash
export OMC_DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
export OMC_DISCORD_MENTION="<@1465264645320474637>"  # optional
```

**Bot API method:**
```bash
export OMC_DISCORD_NOTIFIER_BOT_TOKEN="your-bot-token"
export OMC_DISCORD_NOTIFIER_CHANNEL="your-channel-id"
export OMC_DISCORD_MENTION="<@1465264645320474637>"  # optional
```

Env vars are auto-detected by the notification system without needing `.omc-config.json`.

---

## Slack Setup

Set up Slack notifications so OMC can message you when sessions end, need input, or complete background tasks.

### How This Skill Works

This is an interactive, natural-language configuration skill. Walk the user through setup by asking questions with AskUserQuestion. Write the result to `~/.claude/.omc-config.json`.

### Step 1: Detect Existing Configuration

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"

if [ -f "$CONFIG_FILE" ]; then
  HAS_SLACK=$(jq -r '.notifications.slack.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  WEBHOOK_URL=$(jq -r '.notifications.slack.webhookUrl // empty' "$CONFIG_FILE" 2>/dev/null)
  MENTION=$(jq -r '.notifications.slack.mention // empty' "$CONFIG_FILE" 2>/dev/null)
  CHANNEL=$(jq -r '.notifications.slack.channel // empty' "$CONFIG_FILE" 2>/dev/null)

  if [ "$HAS_SLACK" = "true" ]; then
    echo "EXISTING_CONFIG=true"
    [ -n "$WEBHOOK_URL" ] && echo "WEBHOOK_URL=$WEBHOOK_URL"
    [ -n "$MENTION" ] && echo "MENTION=$MENTION"
    [ -n "$CHANNEL" ] && echo "CHANNEL=$CHANNEL"
  else
    echo "EXISTING_CONFIG=false"
  fi
else
  echo "NO_CONFIG_FILE"
fi
```

If existing config is found, show the user what's currently configured and ask if they want to update or reconfigure.

### Step 2: Create a Slack Incoming Webhook

Guide the user through creating a webhook if they don't have one:

```
To set up Slack notifications, you need a Slack incoming webhook URL.

CREATE A WEBHOOK:
1. Go to https://api.slack.com/apps
2. Click "Create New App" > "From scratch"
3. Name your app (e.g., "OMC Notifier") and select your workspace
4. Go to "Incoming Webhooks" in the left sidebar
5. Toggle "Activate Incoming Webhooks" to ON
6. Click "Add New Webhook to Workspace"
7. Select the channel where notifications should be posted
8. Copy the webhook URL (starts with https://hooks.slack.com/services/...)
```

### Step 3: Collect Webhook URL

Use AskUserQuestion:

**Question:** "Paste your Slack incoming webhook URL (starts with https://hooks.slack.com/services/...)"

The user will type their webhook URL in the "Other" field.

**Validate** the URL:
- Must start with `https://hooks.slack.com/services/`
- If invalid, explain the format and ask again

### Step 4: Configure Mention (User/Group Ping)

Use AskUserQuestion:

**Question:** "Would you like notifications to mention (ping) someone?"

**Options:**
1. **Yes, mention a user** - Tag a specific user by their Slack member ID
2. **Yes, mention a channel** - Use @channel to notify everyone in the channel
3. **Yes, mention @here** - Notify only active members in the channel
4. **No mentions** - Just post the message without pinging anyone

#### If user wants to mention a user:

Ask: "What is the Slack member ID to mention? (Click on a user's profile > More (⋯) > Copy member ID)"

The mention format is: `<@MEMBER_ID>` (e.g., `<@U1234567890>`)

#### If user wants @channel:

The mention format is: `<!channel>`

#### If user wants @here:

The mention format is: `<!here>`

### Step 5: Configure Events

Use AskUserQuestion with multiSelect:

**Question:** "Which events should trigger Slack notifications?"

**Options (multiSelect: true):**
1. **Session end (Recommended)** - When a Claude session finishes
2. **Input needed** - When Claude is waiting for your response (great for long-running tasks)
3. **Session start** - When a new session begins
4. **Session continuing** - When a persistent mode keeps the session alive

Default selection: session-end + ask-user-question.

### Step 6: Optional Channel Override

Use AskUserQuestion:

**Question:** "Override the default notification channel? (The webhook already has a default channel)"

**Options:**
1. **Use webhook default (Recommended)** - Post to the channel selected during webhook setup
2. **Override channel** - Specify a different channel (e.g., #alerts)

If override, ask for the channel name (e.g., `#alerts`).

### Step 7: Optional Username Override

Use AskUserQuestion:

**Question:** "Custom bot display name? (Shows as the webhook sender name in Slack)"

**Options:**
1. **OMC (default)** - Display as "OMC"
2. **Claude Code** - Display as "Claude Code"
3. **Custom** - Enter a custom name

### Step 8: Write Configuration

Read the existing config, merge the new Slack settings, and write back:

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi

# WEBHOOK_URL, MENTION, USERNAME, CHANNEL are collected from user
echo "$EXISTING" | jq \
  --arg url "$WEBHOOK_URL" \
  --arg mention "$MENTION" \
  --arg username "$USERNAME" \
  --arg channel "$CHANNEL" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications.slack = {
     enabled: true,
     webhookUrl: $url,
     mention: (if $mention == "" then null else $mention end),
     username: (if $username == "" then null else $username end),
     channel: (if $channel == "" then null else $channel end)
   }' > "$CONFIG_FILE"
```

#### Add event-specific config if user didn't select all events:

For each event NOT selected, disable it:

```bash
# Example: disable session-start if not selected
echo "$(cat "$CONFIG_FILE")" | jq \
  '.notifications.events = (.notifications.events // {}) |
   .notifications.events["session-start"] = {enabled: false}' > "$CONFIG_FILE"
```

### Step 9: Test the Configuration

After writing config, offer to send a test notification:

Use AskUserQuestion:

**Question:** "Send a test notification to verify the setup?"

**Options:**
1. **Yes, test now (Recommended)** - Send a test message to your Slack channel
2. **No, I'll test later** - Skip testing

#### If testing:

```bash
# For webhook:
MENTION_PREFIX=""
if [ -n "$MENTION" ]; then
  MENTION_PREFIX="${MENTION}\n"
fi

curl -s -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"${MENTION_PREFIX}OMC test notification - Slack is configured!\"}" \
  "$WEBHOOK_URL"
```

Report success or failure. Common issues:
- **403 Forbidden**: Webhook URL is invalid or revoked
- **404 Not Found**: Webhook URL is incorrect
- **channel_not_found**: Channel override is invalid
- **Network error**: Check connectivity to hooks.slack.com

### Step 10: Confirm

Display the final configuration summary:

```
Slack Notifications Configured!

  Webhook:  https://hooks.slack.com/services/T00/B00/xxx...
  Mention:  <@U1234567890> (or "none")
  Channel:  #alerts (or "webhook default")
  Events:   session-end, ask-user-question
  Username: OMC

Config saved to: ~/.claude/.omc-config.json

You can also set these via environment variables:
  OMC_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
  OMC_SLACK_MENTION=<@U1234567890>

To reconfigure: /oh-my-claudecode:configure-notifications slack
To configure Discord: /oh-my-claudecode:configure-notifications discord
To configure Telegram: /oh-my-claudecode:configure-notifications telegram
```

### Environment Variable Alternative

Users can skip this wizard entirely by setting env vars in their shell profile:

```bash
export OMC_SLACK_WEBHOOK_URL="https://hooks.slack.com/services/T00/B00/xxx"
export OMC_SLACK_MENTION="<@U1234567890>"  # optional
```

Env vars are auto-detected by the notification system without needing `.omc-config.json`.

### Slack Mention Formats

| Type | Format | Example |
|------|--------|---------|
| User | `<@MEMBER_ID>` | `<@U1234567890>` |
| Channel | `<!channel>` | `<!channel>` |
| Here | `<!here>` | `<!here>` |
| Everyone | `<!everyone>` | `<!everyone>` |
| User Group | `<!subteam^GROUP_ID>` | `<!subteam^S1234567890>` |

---

## Platform Activation Flags

All notification platforms require activation via CLI flags per session:

- `omc --telegram` — Activates Telegram notifications (sets `OMC_TELEGRAM=1`)
- `omc --discord` — Activates Discord notifications (sets `OMC_DISCORD=1`)
- `omc --slack` — Activates Slack notifications (sets `OMC_SLACK=1`)
- `omc --webhook` — Activates webhook notifications (sets `OMC_WEBHOOK=1`)
- `omc --openclaw` — Activates OpenClaw gateway integration (sets `OMC_OPENCLAW=1`)

Without these flags, configured platforms remain dormant. This prevents unwanted notifications during development while keeping configuration persistent.

**Examples:**
- `omc --telegram --discord` — Telegram + Discord active
- `omc --telegram --slack --webhook` — Telegram + Slack + Webhook active
- `omc --telegram --openclaw` — Telegram + OpenClaw active
- `omc` — No notifications sent (all platforms require explicit activation)

---

## Hook Event Templates

Customize notification messages per event and per platform using `omc_config.hook.json`.

### Routing

If the trigger or argument contains "hook", "template", or "customize messages" → follow this section.

### Step 1: Detect Existing Hook Config

Check if `~/.claude/omc_config.hook.json` exists. If it does, show the current configuration. If not, explain what it does.

```
Hook event templates let you customize the notification messages sent to each platform.
You can set different messages for Discord vs Telegram vs Slack, and control which
events fire on which platform.

Config file: ~/.claude/omc_config.hook.json
```

### Step 2: Choose Event to Configure

Use AskUserQuestion:

**Question:** "Which event would you like to configure templates for?"

**Options:**
1. **session-end** - When a Claude session finishes (most common)
2. **ask-user-question** - When Claude is waiting for input
3. **session-idle** - When Claude finishes and waits for input
4. **session-start** - When a new session begins

### Step 3: Show Available Variables

Display the template variables available for the chosen event:

```
Available template variables:

RAW FIELDS:
  {{sessionId}}      - Session identifier
  {{timestamp}}      - ISO timestamp
  {{tmuxSession}}    - tmux session name
  {{projectPath}}    - Full project directory path
  {{projectName}}    - Project directory basename
  {{reason}}         - Stop/end reason
  {{activeMode}}     - Active OMC mode name
  {{question}}       - Question text (ask-user-question only)
  {{agentName}}      - Agent name (agent-call only)
  {{agentType}}      - Agent type (agent-call only)

COMPUTED (smart formatting):
  {{duration}}       - Human-readable duration (e.g., "5m 23s")
  {{time}}           - Locale time string
  {{modesDisplay}}   - Comma-separated modes or empty
  {{iterationDisplay}} - "3/10" format or empty
  {{agentDisplay}}   - "2/5 completed" or empty
  {{projectDisplay}} - Project name with fallbacks
  {{footer}}         - tmux + project info line
  {{tmuxTailBlock}}  - Recent output in code fence or empty
  {{reasonDisplay}}  - Reason with "unknown" fallback

CONDITIONALS:
  {{#if variableName}}content shown when truthy{{/if}}
```

### Step 4: Collect Template

Use AskUserQuestion:

**Question:** "Enter the message template for this event (use {{variables}} for dynamic content)"

**Options:**
1. **Use default template** - Keep the built-in message format
2. **Simple summary** - Short one-line format
3. **Custom** - Enter your own template

If "Simple summary", use a pre-built compact template:
- session-end: `{{projectDisplay}} session ended ({{duration}}) — {{reasonDisplay}}`
- ask-user-question: `Input needed on {{projectDisplay}}: {{question}}`
- session-idle: `{{projectDisplay}} is idle. {{#if reason}}Reason: {{reason}}{{/if}}`
- session-start: `Session started: {{projectDisplay}} at {{time}}`

### Step 5: Per-Platform Overrides

Use AskUserQuestion:

**Question:** "Do you want different messages for specific platforms?"

**Options:**
1. **No, same for all (Recommended)** - Use the same template everywhere
2. **Yes, customize per platform** - Set different templates for Discord, Telegram, Slack

If per-platform: ask for each enabled platform's template separately.

### Step 6: Write Configuration

Read or create `~/.claude/omc_config.hook.json` and merge the new settings:

```json
{
  "version": 1,
  "enabled": true,
  "events": {
    "<event-name>": {
      "enabled": true,
      "template": "<user-provided-template>",
      "platforms": {
        "discord": { "template": "<discord-specific>" },
        "telegram": { "template": "<telegram-specific>" }
      }
    }
  }
}
```

### Step 7: Validate and Test

Validate the template using `validateTemplate()` to check for unknown variables. If any are found, warn the user and offer to correct.

Offer to send a test notification with the new template.

### Example Config

```json
{
  "version": 1,
  "enabled": true,
  "events": {
    "session-end": {
      "enabled": true,
      "template": "Session {{sessionId}} ended after {{duration}}. Reason: {{reasonDisplay}}",
      "platforms": {
        "discord": {
          "template": "**Session Complete** | `{{projectDisplay}}` | {{duration}} | {{reasonDisplay}}"
        },
        "telegram": {
          "template": "Done: {{projectDisplay}} ({{duration}})\n{{#if contextSummary}}Summary: {{contextSummary}}{{/if}}"
        }
      }
    },
    "ask-user-question": {
      "enabled": true,
      "template": "{{#if question}}{{question}}{{/if}}\nWaiting for input on {{projectDisplay}}"
    }
  }
}
```

---

## Related

- `/oh-my-claudecode:configure-openclaw` — Configure OpenClaw gateway integration

---

## Custom Integration (OpenClaw, n8n, CLI, etc.)

Configure custom webhooks and CLI commands for services beyond the native Discord/Telegram/Slack integrations.

### Routing

If the user says "custom integration", "openclaw", "n8n", "webhook", "cli command", or similar → follow this section.

### Migration from OpenClaw

If `~/.claude/omc_config.openclaw.json` exists, detect and offer migration:

**Step 1: Detect Legacy Config**
```bash
LEGACY_CONFIG="$HOME/.claude/omc_config.openclaw.json"
if [ -f "$LEGACY_CONFIG" ]; then
  echo "LEGACY_FOUND=true"
  # Check if already migrated
  if jq -e '.customIntegrations.integrations[] | select(.preset == "openclaw")' "$CONFIG_FILE" >/dev/null 2>&1; then
    echo "ALREADY_MIGRATED=true"
  else
    echo "ALREADY_MIGRATED=false"
  fi
else
  echo "LEGACY_FOUND=false"
fi
```

**Step 2: Offer Migration**
If legacy found and not migrated:

**Question:** "Existing OpenClaw configuration detected. Would you like to migrate it to the new format?"

**Options:**
1. **Yes, migrate now** - Convert legacy config to custom integration
2. **No, configure fresh** - Skip migration and start new
3. **Show me the legacy config first** - Display current OpenClaw settings

If migrate:
- Read `omc_config.openclaw.json`
- Transform to custom integration format
- Save to `.omc-config.json`
- Backup legacy to `omc_config.openclaw.json.bak`
- Show success message

### Custom Integration Wizard

**Step 1: Select Integration Type**

**Question:** "Which type of custom integration would you like to configure?"

**Options:**
1. **OpenClaw Gateway** - Wake external automations and AI agents
2. **n8n Webhook** - Trigger n8n workflows
3. **ClawdBot** - Send notifications to ClawdBot
4. **Generic Webhook** - Custom HTTPS webhook
5. **Generic CLI Command** - Execute shell command on events

### OpenClaw/n8n/ClawdBot Preset Flow

**Step 2: Gateway URL**

**Question:** "What is your gateway/webhook URL?"

**Validation:**
- Must be HTTPS (except localhost for development)
- Must be valid URL format

**Step 3: Authentication (Optional)**

**Question:** "Does your gateway require authentication?"

**Options:**
1. **Bearer token** - Authorization: Bearer <token>
2. **Custom header** - Name and value
3. **No authentication**

If Bearer: ask for token
If Custom: ask for header name and value

**Step 4: Events**

Use AskUserQuestion with multiSelect:

**Question:** "Which events should trigger this integration?"

**Options (with defaults from preset):**
- session-start
- session-end
- session-stop
- session-idle
- ask-user-question

Default for OpenClaw: session-start, session-end, stop
Default for n8n: session-end, ask-user-question

**Step 5: Test**

**Question:** "Send a test notification to verify the configuration?"

**Options:**
1. **Yes, test now** - Send test webhook
2. **No, skip test**

If test:
```bash
# For webhook integrations
curl -X POST \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER:+"-H \"$AUTH_HEADER\""} \
  -d '{"event":"test","instruction":"OMC test notification","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' \
  "$WEBHOOK_URL"
```

Show result (HTTP status, any error).

**Step 6: Write Configuration**

Merge into `.omc-config.json`:

```json
{
  "notifications": { /* existing native configs */ },
  "customIntegrations": {
    "enabled": true,
    "integrations": [
      {
        "id": "my-openclaw",
        "type": "webhook",
        "preset": "openclaw",
        "enabled": true,
        "config": {
          "url": "https://my-gateway.example.com/wake",
          "method": "POST",
          "headers": {
            "Content-Type": "application/json",
            "Authorization": "Bearer ..."
          },
          "bodyTemplate": "{\\"event\\":\\"{{event}}\\",\\"instruction\\":\\"Session {{sessionId}} {{event}}\\",\\"timestamp\\":\\"{{timestamp}}\\"}",
          "timeout": 10000
        },
        "events": ["session-start", "session-end"]
      }
    ]
  }
}
```

### Generic Webhook Flow

**Step 2: URL**
Ask for webhook URL (HTTPS required).

**Step 3: Method**
Ask for HTTP method (GET, POST, PUT, PATCH, DELETE). Default: POST.

**Step 4: Headers**
Ask for headers in "Name: Value" format, one per line. Default: Content-Type: application/json

**Step 5: Body Template**
Show available template variables and ask for body template (JSON or other format).

Default:
```json
{
  "event": "{{event}}",
  "sessionId": "{{sessionId}}",
  "projectName": "{{projectName}}",
  "timestamp": "{{timestamp}}"
}
```

**Step 6: Timeout**
Ask for timeout in milliseconds (1000-60000). Default: 10000.

**Step 7: Events**
Multi-select events.

**Step 8: Test and Save**
Same as preset flow.

### Generic CLI Command Flow

**Step 2: Command**

**Question:** "What command should be executed? (single executable, no arguments)"

**Example:** `curl`, `/usr/local/bin/my-script`, `notify-send`

**Validation:**
- No spaces
- No shell metacharacters

**Step 3: Arguments**

**Question:** "Command arguments (use {{variable}} for dynamic values). Enter one per line."

**Example:**
```
-X
POST
-d
{"event":"{{event}}","session":"{{sessionId}}"}
https://my-api.com/notify
```

Show available template variables reference.

**Step 4: Timeout**
Ask for timeout (1000-60000ms). Default: 5000.

**Step 5: Events**
Multi-select events.

**Step 6: Test and Save**

For test, execute command with test values:
```bash
$COMMAND "${ARGS[@]//{{event}}/test}"
```

Show stdout/stderr and exit code.

### Managing Custom Integrations

**List existing:**
```bash
jq '.customIntegrations.integrations[] | {id, type, preset, enabled, events}' "$CONFIG_FILE"
```

**Disable/Enable:**
```bash
# Disable
jq '.customIntegrations.integrations = [.customIntegrations.integrations[] | if .id == "my-integration" then .enabled = false else . end]' "$CONFIG_FILE"

# Enable
jq '.customIntegrations.integrations = [.customIntegrations.integrations[] | if .id == "my-integration" then .enabled = true else . end]' "$CONFIG_FILE"
```

**Remove:**
```bash
jq '.customIntegrations.integrations = [.customIntegrations.integrations[] | select(.id != "my-integration")]' "$CONFIG_FILE"
```

### Template Variables Reference

All custom integrations support these template variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `{{sessionId}}` | Unique session ID | `sess_abc123` |
| `{{projectPath}}` | Full project path | `/home/user/my-project` |
| `{{projectName}}` | Project directory name | `my-project` |
| `{{timestamp}}` | ISO 8601 timestamp | `2026-03-05T14:30:00Z` |
| `{{event}}` | Event name | `session-end` |
| `{{duration}}` | Human-readable duration | `45s` |
| `{{durationMs}}` | Duration in milliseconds | `45000` |
| `{{reason}}` | Stop/end reason | `completed` |
| `{{tmuxSession}}` | tmux session name | `claude:my-project` |

Session-end only:
- `{{agentsSpawned}}`, `{{agentsCompleted}}`, `{{modesUsed}}`, `{{contextSummary}}`

Ask-user-question only:
- `{{question}}`

---

## Related

- Template variables: `src/notifications/template-variables.ts`
- Validation: `src/notifications/validation.ts`
- Presets: `src/notifications/presets.ts`
