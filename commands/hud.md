---
description: Configure HUD display options (layout, presets, display elements)
---

# Sisyphus HUD Configuration

$ARGUMENTS

Configure the Sisyphus HUD (Heads-Up Display) for the statusline.

## Quick Commands

| Command | Description |
|---------|-------------|
| `/hud` | Show current HUD status (auto-setup if needed) |
| `/hud setup` | Install/repair HUD statusline |
| `/hud minimal` | Switch to minimal display |
| `/hud focused` | Switch to focused display (default) |
| `/hud full` | Switch to full display |
| `/hud status` | Show detailed HUD status |

## Auto-Setup

When you run `/hud` or `/hud setup`, the system will automatically:
1. Check if `~/.claude/hud/sisyphus-hud.mjs` exists
2. Check if `statusLine` is configured in `~/.claude/settings.json`
3. If missing, create the HUD wrapper script and configure settings
4. Report status and prompt to restart Claude Code if changes were made

**IMPORTANT**: If the argument is `setup` OR if the HUD script doesn't exist at `~/.claude/hud/sisyphus-hud.mjs`, you MUST run the setup by:
1. First check if the files exist using Bash: `ls ~/.claude/hud/sisyphus-hud.mjs 2>/dev/null && echo EXISTS || echo MISSING`
2. If MISSING or argument is `setup`, find the plugin path and run: `node <plugin-path>/scripts/plugin-setup.mjs`
3. The plugin path can be found at: `~/.claude/plugins/cache/oh-my-claudecode/oh-my-claudecode/<version>/` or the local dev path

To find and run setup automatically:
```bash
# Try plugin cache first, then dev paths
PLUGIN_SETUP=$(find ~/.claude/plugins/cache/oh-my-claudecode -name "plugin-setup.mjs" 2>/dev/null | head -1)
if [ -z "$PLUGIN_SETUP" ]; then
  # Try common dev paths
  for p in ~/Workspace/oh-my-claudecode ~/workspace/oh-my-claudecode ~/projects/oh-my-claudecode; do
    if [ -f "$p/scripts/plugin-setup.mjs" ]; then PLUGIN_SETUP="$p/scripts/plugin-setup.mjs"; break; fi
  done
fi
if [ -n "$PLUGIN_SETUP" ]; then node "$PLUGIN_SETUP"; else echo "Could not find plugin-setup.mjs"; fi
```

## Display Presets

### Minimal
Shows only the essentials:
```
[OMC] ralph | ultrawork | todos:2/5
```

### Focused (Default)
Shows all relevant elements:
```
[OMC] ralph:3/10 | US-002 | ultrawork skill:planner | ctx:67% | agents:2 | bg:3/5 | todos:2/5
```

### Full
Shows everything including multi-line agent details:
```
[OMC] ralph:3/10 | US-002 (2/5) | ultrawork | ctx:[████░░]67% | agents:3 | bg:3/5 | todos:2/5
├─ O architect    2m   analyzing architecture patterns...
├─ e explore     45s   searching for test files
└─ s sj-junior    1m   implementing validation logic
```

## Multi-Line Agent Display

When agents are running, the HUD shows detailed information on separate lines:
- **Tree characters** (`├─`, `└─`) show visual hierarchy
- **Agent code** (O, e, s) indicates agent type with model tier color
- **Duration** shows how long each agent has been running
- **Description** shows what each agent is doing (up to 45 chars)

## Display Elements

| Element | Description |
|---------|-------------|
| `[OMC]` | Mode identifier |
| `ralph:3/10` | Ralph loop iteration/max |
| `US-002` | Current PRD story ID |
| `ultrawork` | Active mode badge |
| `skill:name` | Last activated skill (cyan) |
| `ctx:67%` | Context window usage |
| `agents:2` | Running subagent count |
| `bg:3/5` | Background task slots |
| `todos:2/5` | Todo completion |

## Color Coding

- **Green**: Normal/healthy
- **Yellow**: Warning (context >70%, ralph >7)
- **Red**: Critical (context >85%, ralph at max)

## Configuration Location

HUD config is stored at: `~/.claude/.sisyphus/hud-config.json`

## Manual Configuration

You can manually edit the config file:

```json
{
  "preset": "focused",
  "elements": {
    "sisyphusLabel": true,
    "ralph": true,
    "prdStory": true,
    "activeSkills": true,
    "lastSkill": true,
    "contextBar": true,
    "agents": true,
    "backgroundTasks": true,
    "todos": true
  },
  "thresholds": {
    "contextWarning": 70,
    "contextCritical": 85,
    "ralphWarning": 7
  }
}
```

## Troubleshooting

If the HUD is not showing:
1. Run `/hud setup` to auto-install and configure
2. Restart Claude Code after setup completes
3. If still not working, run `/doctor` for full diagnostics

Manual verification:
- HUD script: `~/.claude/hud/sisyphus-hud.mjs`
- Settings: `~/.claude/settings.json` should have `statusLine` configured

---

*The HUD updates automatically every ~300ms during active sessions.*
