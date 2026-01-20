# Local Plugin Installation

How to install oh-my-claudecode from a local development directory as a Claude Code plugin.

## Quick Install

```bash
# 1. Add local directory as a marketplace
claude plugin marketplace add /path/to/oh-my-claudecode

# 2. Install the plugin from the local marketplace
claude plugin install oh-my-claudecode@oh-my-claudecode

# 3. Restart Claude Code to pick up the plugin
```

## Commands Reference

```bash
# List configured marketplaces
claude plugin marketplace list

# Update marketplace (re-read from source)
claude plugin marketplace update oh-my-claudecode

# Update the installed plugin
claude plugin update oh-my-claudecode@oh-my-claudecode

# List installed plugins
claude plugin list

# Uninstall
claude plugin uninstall oh-my-claudecode@oh-my-claudecode

# Remove marketplace
claude plugin marketplace remove oh-my-claudecode
```

## Plugin Structure

The plugin requires a `plugin.json` manifest:

```json
{
  "name": "oh-my-claudecode",
  "version": "3.0.0",
  "description": "Multi-agent orchestration system for Claude Code",
  "hooks": {
    "PreToolUse": ["scripts/pre-tool-enforcer.mjs"],
    "PostToolUse": ["scripts/post-tool-verifier.mjs"],
    "SessionStart": ["scripts/session-start.mjs"]
  },
  "agents": ["agents/*.md"],
  "commands": ["commands/**/*.md"],
  "skills": ["skills/*.md"]
}
```

## Development Workflow

After making changes to the plugin:

```bash
# 1. Build (if TypeScript changes)
npm run build

# 2. Update the marketplace cache
claude plugin marketplace update oh-my-claudecode

# 3. Update the installed plugin
claude plugin update oh-my-claudecode@oh-my-claudecode

# 4. Restart Claude Code session
```

## Vs. npm Global Install

| Method | Command | Files Location |
|--------|---------|----------------|
| Plugin | `claude plugin install` | `~/.claude/plugins/cache/` |
| npm global | `npm install -g` | `~/.claude/agents/`, `~/.claude/commands/` |

**Plugin mode is preferred** - it keeps files isolated and uses the native Claude Code plugin system with `${CLAUDE_PLUGIN_ROOT}` variable for path resolution.

## Troubleshooting

**Plugin not loading:**
- Restart Claude Code after installation
- Check `claude plugin list` shows status as "enabled"
- Verify plugin.json exists and is valid JSON

**Old version showing:**
- The cache directory name may show old version, but the actual code is from latest commit
- Run `claude plugin marketplace update` then `claude plugin update`
