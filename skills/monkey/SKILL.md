---
name: monkey
description: Manage Claude Code sessions via Telegram bot from within Claude Code
---

# OMC Monkey - Remote Session Management

You are helping the user manage Claude Code sessions through OMC Monkey. It runs as a background MCP server that connects to Telegram, allowing remote control of multiple Claude Code sessions running in tmux.

## Available MCP Tools

Use these tools to interact with OMC Monkey:

| Tool | Purpose |
|------|---------|
| `monkey_session_create` | Create a new Claude Code session |
| `monkey_session_list` | List all active sessions |
| `monkey_session_send` | Send a prompt to a session |
| `monkey_session_output` | Get terminal output from a session |
| `monkey_session_kill` | Terminate a session |
| `monkey_session_recover` | Recover sessions after gateway restart |
| `monkey_status` | Get bot status (uptime, connections) |

## Quick Start

1. **Check if OMC Monkey is running:**
   ```
   Use monkey_status tool
   ```

2. **Create a new session:**
   ```
   Use monkey_session_create with:
   - name: "my-project"
   - workingDirectory: "/path/to/project"
   - initialPrompt: (optional) "Initial prompt for Claude"
   ```

3. **Send prompts to the session:**
   ```
   Use monkey_session_send with:
   - sessionId: "session-uuid"
   - prompt: "Your prompt here"
   ```

4. **Get session output:**
   ```
   Use monkey_session_output with:
   - sessionId: "session-uuid"
   - lines: 100 (optional, default 100)
   ```

5. **Recover sessions after restart:**
   ```
   Use monkey_session_recover tool
   ```

## Configuration

OMC Monkey is configured through `~/.claude/.omc-config.json` under the `monkey` key. Run `/oh-my-claudecode:omc-setup` to configure:

- Telegram bot token
- Admin Telegram user IDs (required for security)
- Default project directory
- Maximum concurrent sessions
- Auto-cleanup settings

**IMPORTANT**: Bot requires `adminTelegramIds` to be configured. Without it, the bot refuses to start for security reasons.

### Environment Variables

Token can be set via environment variable:
- `OMC_MONKEY_TELEGRAM_TOKEN`

## Common Workflows

### Create and Monitor a Session

```
1. monkey_session_create(name="feature-work", workingDirectory="/home/user/myproject")
2. monkey_session_send(sessionId="...", prompt="Implement the login feature")
3. (wait for work to complete)
4. monkey_session_output(sessionId="...", lines=200)
```

### Check on Remote Work

```
1. monkey_session_list() - see what's running
2. monkey_session_output(sessionId="...", lines=50) - check progress
```

### Clean Up Sessions

```
1. monkey_session_list() - find sessions to clean up
2. monkey_session_kill(sessionId="...") - terminate completed sessions
```

## Troubleshooting

### No Telegram Connection
Check that tokens are configured:
1. Run `/oh-my-claudecode:omc-setup` and configure OMC Monkey section
2. Or set environment variable: `OMC_MONKEY_TELEGRAM_TOKEN`
3. Ensure `adminTelegramIds` is set in config

### Session Limit Reached
```
Error: Maximum session limit reached (5)
```
Solution: Kill unused sessions with `monkey_session_kill` or increase `maxSessions` in config.

### tmux Not Installed
```
Error: tmux is not installed
```
Solution: Install tmux:
- Ubuntu/Debian: `sudo apt install tmux`
- macOS: `brew install tmux`

## Architecture

OMC Monkey runs as a stdio-based MCP server that:
1. Connects to Telegram with a bot token
2. Listens for commands from Telegram chat
3. Manages tmux sessions (prefix: `monkey-`) containing Claude Code instances
4. Provides MCP tools for programmatic session management

Sessions persist across gateway restarts (tmux sessions survive, SQLite database tracks state).
