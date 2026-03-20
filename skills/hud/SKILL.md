---
name: hud
description: Configure HUD display options (layout, presets, display elements)
role: config-writer  # DOCUMENTATION ONLY - This skill writes to ~/.claude/ paths
scope: ~/.claude/**  # DOCUMENTATION ONLY - Allowed write scope
level: 2
---

# HUD Skill

Configure the OMC HUD (Heads-Up Display) for the statusline.

Note: All `~/.claude/...` paths in this guide respect `CLAUDE_CONFIG_DIR` when that environment variable is set.

## Quick Commands

| Command | Description |
|---------|-------------|
| `/oh-my-claudecode:hud` | Show current HUD status (auto-setup if needed) |
| `/oh-my-claudecode:hud setup` | Install/repair HUD statusline |
| `/oh-my-claudecode:hud minimal` | Switch to minimal display |
| `/oh-my-claudecode:hud focused` | Switch to focused display (default) |
| `/oh-my-claudecode:hud full` | Switch to full display |
| `/oh-my-claudecode:hud status` | Show detailed HUD status |

## Auto-Setup

`/oh-my-claudecode:hud` and `/oh-my-claudecode:hud setup` should treat the installer as the source of truth for HUD repair.

When setup runs, it should:
1. Check whether `~/.claude/hud/omc-hud.mjs` exists.
2. Check whether `statusLine` in `~/.claude/settings.json` is already an OMC-owned object config.
3. Regenerate the HUD wrapper via the installer when needed.
4. Reconcile `statusLine` without overwriting non-OMC configs; replacing another tool's `statusLine` requires a manual edit.
5. Tell the user to restart Claude Code if files/settings changed.

**Do not** paste an inline `omc-hud.mjs` template into the response. The generated wrapper in `src/installer/index.ts` is the only source of truth.

**Do not** suggest deleting `~/.claude/hud/omc-hud.mjs` as a cleanup step during normal setup/repair. That can remove the active wrapper and leave the HUD broken.

## Manual Verification / Diagnostics

Prefer `/oh-my-claudecode:hud setup` for install/repair. Use the commands below only to inspect the current state or diagnose why setup did not stick.

### Step 1: Check whether the wrapper exists
```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.CLAUDE_CONFIG_DIR||p.join(require('os').homedir(),'.claude');console.log(f.existsSync(p.join(d,'hud','omc-hud.mjs'))?'EXISTS':'MISSING')"
```

### Step 2: Verify the plugin install has a HUD build
```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.CLAUDE_CONFIG_DIR||p.join(require('os').homedir(),'.claude'),b=p.join(d,'plugins','cache','omc','oh-my-claudecode');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));if(v.length===0){console.log('Plugin not installed - run: /plugin install oh-my-claudecode');process.exit()}const l=v[v.length-1],h=p.join(b,l,'dist','hud','index.js');console.log('Version:',l);console.log(f.existsSync(h)?'READY':'NOT_FOUND - try reinstalling: /plugin install oh-my-claudecode')}catch{console.log('Plugin not installed - run: /plugin install oh-my-claudecode')}"
```

### Step 3: Verify `statusLine` uses the object format

Read `~/.claude/settings.json` and confirm `statusLine` is an object:

```json
{
  "statusLine": {
    "type": "command",
    "command": "..."
  }
}
```

Legacy string values such as `"~/.claude/hud/omc-hud.mjs"` are deprecated. Running the installer or `/oh-my-claudecode:hud setup` should migrate them to the object format automatically.

### Step 4: Check the expected command shape

**IMPORTANT:** The command path must use forward slashes on all platforms. Claude Code executes `statusLine` commands via bash, so backslashes in Windows paths can break execution.

- Unix installer output normally prefers a config-dir-aware command:
  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "sh \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/find-node.sh\" \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/omc-hud.mjs\""
    }
  }
  ```
- Unix fallback if `find-node.sh` could not be copied:
  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "node \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/omc-hud.mjs\""
    }
  }
  ```
- Windows installer output uses a resolved Node binary path plus the HUD wrapper path, both normalized to forward slashes. Example:
  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "\"C:/Program Files/nodejs/node.exe\" \"C:/Users/username/.claude/hud/omc-hud.mjs\""
    }
  }
  ```

If you need to inspect the Windows HUD path manually, use:
```bash
node -e "const p=require('path').join(require('os').homedir(),'.claude','hud','omc-hud.mjs').split(require('path').sep).join('/');console.log(JSON.stringify(p))"
```

### Step 5: Restart Claude Code

If setup created or changed the wrapper/statusLine, tell the user to restart Claude Code so the new configuration is picked up.

## Display Presets

### Minimal
Shows only the essentials:
```
[OMC] ralph | ultrawork | todos:2/5
```

### Focused (Default)
Shows all relevant elements:
```
[OMC] branch:main | ralph:3/10 | US-002 | ultrawork skill:planner | ctx:67% | agents:2 | bg:3/5 | todos:2/5
```

### Full
Shows everything including multi-line agent details:
```
[OMC] repo:oh-my-claudecode branch:main | ralph:3/10 | US-002 (2/5) | ultrawork | ctx:[████░░]67% | agents:3 | bg:3/5 | todos:2/5
├─ O architect    2m   analyzing architecture patterns...
├─ e explore     45s   searching for test files
└─ s executor     1m   implementing validation logic
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
| `repo:name` | Git repository name (cyan) |
| `branch:name` | Git branch name (cyan) |
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

HUD config is stored in `~/.claude/settings.json` under the `omcHud` key (or your custom config directory if `CLAUDE_CONFIG_DIR` is set).

Legacy config location (deprecated): `~/.claude/.omc/hud-config.json`

## Manual Configuration

You can manually edit the config file. Each option can be set individually - any unset values will use defaults.

```json
{
  "preset": "focused",
  "elements": {
    "omcLabel": true,
    "ralph": true,
    "autopilot": true,
    "prdStory": true,
    "activeSkills": true,
    "lastSkill": true,
    "contextBar": true,
    "agents": true,
    "agentsFormat": "multiline",
    "backgroundTasks": true,
    "todos": true,
    "thinking": true,
    "thinkingFormat": "text",
    "permissionStatus": false,
    "apiKeySource": false,
    "profile": true,
    "promptTime": true,
    "sessionHealth": true,
    "showTokens": false,
    "sessionSummary": false,
    "useBars": true,
    "showCallCounts": true,
    "safeMode": true,
    "maxOutputLines": 4
  },
  "thresholds": {
    "contextWarning": 70,
    "contextCompactSuggestion": 80,
    "contextCritical": 85,
    "ralphWarning": 7
  },
  "staleTaskThresholdMinutes": 30,
  "contextLimitWarning": {
    "threshold": 80,
    "autoCompact": false
  },
  "missionBoard": {
    "enabled": false
  }
}
```

### safeMode

When `safeMode` is `true` (default), the HUD strips ANSI codes and uses ASCII-only output to prevent terminal rendering corruption during concurrent updates. On Windows, safe mode is forced on at runtime even if you set `safeMode` to `false`.

### missionBoard

Prefer `missionBoard.enabled` for new config:

```json
{
  "missionBoard": {
    "enabled": true
  }
}
```

Legacy `elements.missionBoard` is still accepted for compatibility, but it should no longer be the recommended form.

### contextLimitWarning.autoCompact

When `autoCompact` is `true`, the HUD only writes `.omc/state/compact-requested.json` as a trigger/request file. It does **not** execute `/compact` by itself.

### profile

`profile` displays the active profile name derived from `CLAUDE_CONFIG_DIR`. If `CLAUDE_CONFIG_DIR` is not set, there is no profile badge to show.

### sessionSummary

`sessionSummary` only renders when transcript/session information is available for the current run. The summary is read from cache and refreshed in the background, so it may appear or update after the HUD starts polling.

### showTokens

`showTokens` only renders when token usage data exists in the current transcript payload. Enabling the flag does not guarantee that a token badge will always appear.

### agentsFormat Options

- `count`: agents:2
- `codes`: agents:Oes (type-coded with model tier casing)
- `codes-duration`: agents:O(2m)es (codes with duration)
- `detailed`: agents:[architect(2m),explore,exec]
- `descriptions`: O:analyzing code | e:searching (codes + what they're doing)
- `tasks`: [analyzing code, searching...] (just descriptions)
- `multiline`: Multi-line display with full agent details on separate lines

## Troubleshooting

If the HUD is not showing:
1. Run `/oh-my-claudecode:hud setup` to auto-install and configure
2. Restart Claude Code after setup completes
3. If still not working, run `/oh-my-claudecode:omc-doctor` for full diagnostics

**Legacy string format migration:** Older OMC versions wrote `statusLine` as a plain string (e.g., `"~/.claude/hud/omc-hud.mjs"`). Modern Claude Code requires the object format. Running the installer or `/oh-my-claudecode:hud setup` will migrate legacy strings to an object-based `statusLine`, usually using `find-node.sh` on Unix and a normalized absolute command on Windows.

**Node 24+ compatibility:** The HUD wrapper script imports `homedir` from `node:os` (not `node:path`). If you encounter `SyntaxError: The requested module 'path' does not provide an export named 'homedir'`, re-run the installer to regenerate `omc-hud.mjs`.

Manual verification:
- HUD script: `~/.claude/hud/omc-hud.mjs`
- Settings: `~/.claude/settings.json` should have `statusLine` configured as an object with `type` and `command` fields

---

*The HUD updates automatically every ~300ms during active sessions.*
