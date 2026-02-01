---
name: clawdcoder
description: Manage Claude Code sessions via Discord/Telegram bot from within Claude Code
---

# ClawdCoder - Remote Session Management

You are helping the user manage Claude Code sessions through the ClawdCoder bot. ClawdCoder runs as a background process that connects to Discord and Telegram, allowing remote control of multiple Claude Code sessions running in tmux.

## Available MCP Tools

Use these tools to interact with ClawdCoder:

| Tool | Purpose |
|------|---------|
| `clawdcoder_session_create` | Create a new Claude Code session |
| `clawdcoder_session_list` | List all active sessions |
| `clawdcoder_session_send` | Send a prompt to a session |
| `clawdcoder_session_output` | Get terminal output from a session |
| `clawdcoder_session_kill` | Terminate a session |
| `clawdcoder_status` | Get bot status (uptime, connections) |

## Bot Lifecycle Commands

Use Bash to manage the bot process:

```bash
# Start the bot
omc clawdcoder start

# Stop the bot
omc clawdcoder stop

# Check status
omc clawdcoder status

# View logs
omc clawdcoder logs

# Restart
omc clawdcoder restart
```

## Quick Start

1. **Check if ClawdCoder is running:**
   ```
   Use clawdcoder_status tool
   ```

2. **If not running, start it:**
   ```bash
   omc clawdcoder start
   ```

3. **Create a new session:**
   ```
   Use clawdcoder_session_create with:
   - name: "my-project"
   - project_dir: "/path/to/project"
   - prompt: (optional) "Initial prompt for Claude"
   ```

4. **Send prompts to the session:**
   ```
   Use clawdcoder_session_send with:
   - session_id: "my-project" (or the UUID)
   - prompt: "Your prompt here"
   ```

5. **Get session output:**
   ```
   Use clawdcoder_session_output with:
   - session_id: "my-project"
   - lines: 100 (optional, default 100)
   ```

## Configuration

ClawdCoder is configured through `~/.claude/.omc-config.json`. Run `/oh-my-claudecode:omc-setup` to configure:

- Discord bot token
- Telegram bot token
- Default project directory
- Maximum concurrent sessions
- Auto-cleanup settings

### Environment Variables

Tokens can also be set via environment variables:
- `CLAWDCODER_DISCORD_TOKEN`
- `CLAWDCODER_TELEGRAM_TOKEN`

## Common Workflows

### Create and Monitor a Session

```
1. clawdcoder_session_create(name="feature-work", project_dir="/home/user/myproject")
2. clawdcoder_session_send(session_id="feature-work", prompt="Implement the login feature")
3. (wait for work to complete)
4. clawdcoder_session_output(session_id="feature-work", lines=200)
```

### Check on Remote Work

```
1. clawdcoder_session_list() - see what's running
2. clawdcoder_session_output(session_id="...", lines=50) - check progress
```

### Clean Up Sessions

```
1. clawdcoder_session_list() - find sessions to clean up
2. clawdcoder_session_kill(session_id="...") - terminate completed sessions
```

## Troubleshooting

### Bot Not Running
```
Error: ClawdCoder is not running. Start with: omc clawdcoder start
```
Solution: Run `omc clawdcoder start` in the terminal.

### No Discord/Telegram Connection
Check that tokens are configured:
1. Run `/oh-my-claudecode:omc-setup` and configure ClawdCoder section
2. Or set environment variables: `CLAWDCODER_DISCORD_TOKEN`, `CLAWDCODER_TELEGRAM_TOKEN`

### Session Limit Reached
```
Error: Maximum session limit reached (5)
```
Solution: Kill unused sessions with `clawdcoder_session_kill` or increase `maxSessions` in config.

### tmux Not Installed
```
Error: tmux is not installed
```
Solution: Install tmux:
- Ubuntu/Debian: `sudo apt install tmux`
- macOS: `brew install tmux`

## Architecture

ClawdCoder runs as a background Node.js process that:
1. Connects to Discord and Telegram with bot tokens
2. Listens for commands from chat platforms
3. Manages tmux sessions containing Claude Code instances
4. Provides IPC interface for MCP tools via Unix domain socket

Sessions persist across bot restarts (tmux sessions survive, database tracks state).
