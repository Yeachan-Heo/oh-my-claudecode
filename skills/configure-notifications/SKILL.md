---
name: configure-notifications
description: Configure session end file logging callback
triggers:
  - "configure notifications"
  - "setup notifications"
  - "configure file logging"
  - "session logging"
---

# Configure Notifications

External notification integrations (Telegram, Discord, Slack, OpenClaw) have been
removed from this fork for security hardening. Only local file logging is supported.

## File Logging Setup

Guide the user through configuring the file-based session summary callback.

### Steps

1. Ask the user for a file path template. Supported placeholders:
   - `{session_id}` — the unique session identifier
   - `{date}` — current date in YYYY-MM-DD format
   - `{time}` — current time in HH-MM-SS format
   - `~` — expands to the user's home directory

   Default: `~/.claude/session-logs/{date}/{session_id}.md`

2. Ask the user for the output format:
   - `markdown` (default) — human-readable session summary
   - `json` — machine-readable JSON

3. Run the CLI command to configure:

```bash
omc config-stop-callback file --enable --path "<path>" --format <format>
```

4. Confirm the configuration:

```bash
omc config-stop-callback file --show
```

### Examples

```bash
# Enable with default path
omc config-stop-callback file --enable --path "~/.claude/session-logs/{date}/{session_id}.md"

# Enable with JSON format
omc config-stop-callback file --enable --path "~/.claude/session-logs/{session_id}.json" --format json

# Disable
omc config-stop-callback file --disable

# Show current config
omc config-stop-callback file --show
```
