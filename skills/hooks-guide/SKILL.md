---
name: hooks-guide
description: Author, debug, and manage Claude Code hooks - pre/post tool hooks, session lifecycle, permission handlers, and custom automation
level: 3
aliases: [hooks, hook-debug, hook-author]
argument-hint: [list|create|debug|explain] - default is list
---

# Hooks Guide Skill

Author, debug, and manage Claude Code hooks. Understand the hook lifecycle, create custom hooks, debug failing hooks, and optimize hook performance.

## Usage

```
/oh-my-claudecode:hooks-guide
/oh-my-claudecode:hooks-guide list
/oh-my-claudecode:hooks-guide create
/oh-my-claudecode:hooks-guide debug
/oh-my-claudecode:hooks-guide explain
```

Or say: "create a hook", "debug my hooks", "explain hooks", "list active hooks", "hook is failing"

## Hook Lifecycle Overview

```
Session Start
  └→ SessionStart hooks
      └→ User sends message
          └→ UserPromptSubmit hooks
              └→ Claude processes...
                  ├→ PreToolUse hooks (before each tool)
                  │   └→ Tool executes
                  │       ├→ PostToolUse hooks (on success)
                  │       └→ PostToolUseFailure hooks (on failure)
                  ├→ SubagentStart hooks (before spawning agent)
                  │   └→ Agent works...
                  │       └→ SubagentStop hooks (when agent finishes)
                  └→ PreCompact hooks (before context compression)
      └→ Claude stops
          └→ Stop hooks
              └→ Session ends
                  └→ SessionEnd hooks
```

## Available Hook Events

| Event | Timing | Common Uses |
|-------|--------|-------------|
| `SessionStart` | Session begins | Load project context, detect environment |
| `UserPromptSubmit` | User sends message | Keyword detection, input validation |
| `PreToolUse` | Before tool executes | Permission enforcement, logging |
| `PostToolUse` | After tool succeeds | Verification, memory capture |
| `PostToolUseFailure` | After tool fails | Error recovery, fallback |
| `SubagentStart` | Before agent spawns | Agent tracking, resource limits |
| `SubagentStop` | After agent finishes | Deliverable verification |
| `PreCompact` | Before context compression | State preservation |
| `Stop` | Claude stops responding | Persistence loops, cleanup |
| `SessionEnd` | Session terminates | Final cleanup, memory save |
| `PermissionRequest` | Permission prompt shown | Auto-approve patterns |

## Workflow

### Mode: List

Show all configured hooks:

```bash
# Check project hooks
cat .claude/settings.json 2>/dev/null | grep -A 50 '"hooks"'

# Check user-level hooks
cat ~/.claude/settings.json 2>/dev/null | grep -A 50 '"hooks"'

# Check OMC hooks
cat hooks/hooks.json 2>/dev/null | head -100
```

Display a formatted table:

```
[HOOKS] Active Hooks
═══════════════════════════════════════════

Event               │ Script                    │ Source
────────────────────┼───────────────────────────┼──────────
SessionStart        │ session-start.mjs         │ OMC
UserPromptSubmit    │ keyword-detector.mjs      │ OMC
PreToolUse          │ pre-tool-enforcer.mjs     │ OMC
PostToolUse         │ post-tool-verifier.mjs    │ OMC
Stop                │ persistent-mode.cjs       │ OMC
...                 │ ...                       │ ...
```

### Mode: Create

Interactive hook creation wizard:

#### 1. Choose Event

Ask which hook event to create for. Show the lifecycle diagram and explain each event.

#### 2. Choose Location

```
Where should this hook be configured?
  1. Project (.claude/settings.json) — for this repo only
  2. User (~/.claude/settings.json) — for all your projects
```

#### 3. Generate Hook Script

Based on the event and requirements, generate the hook script:

**Hook script template (ESM .mjs):**

```javascript
// hooks/my-custom-hook.mjs
// Hook event: {event}
// Purpose: {description}

import { readFileSync } from 'fs';

// Hook receives context via environment variables:
// CLAUDE_SESSION_ID, CLAUDE_PROJECT_DIR, CLAUDE_TOOL_NAME (for tool hooks)
// stdin receives: JSON with tool input/output (for tool hooks)

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const sessionId = process.env.CLAUDE_SESSION_ID || '';

async function main() {
  // Read stdin for tool hooks
  let input = '';
  if (process.argv.includes('--tool')) {
    input = readFileSync('/dev/stdin', 'utf-8');
    const data = JSON.parse(input);
    // data.tool_name, data.tool_input, data.tool_output (PostToolUse only)
  }

  // Your hook logic here
  // ...

  // Output to stdout is injected as <system-reminder> into Claude's context
  // Output to stderr is logged but not shown to Claude
  console.log('Hook result message');

  // Exit codes:
  // 0 = success (proceed normally)
  // 1 = error (log warning but proceed)
  // 2 = block (PreToolUse/UserPromptSubmit: prevent the action)
  process.exit(0);
}

main().catch(err => {
  console.error(`Hook error: ${err.message}`);
  process.exit(1);
});
```

#### 4. Register Hook

Generate the settings.json entry:

```json
{
  "hooks": {
    "{event}": [
      {
        "matcher": "{optional tool/pattern matcher}",
        "command": "node hooks/my-custom-hook.mjs",
        "timeout": 10000
      }
    ]
  }
}
```

#### 5. Test Hook

```bash
# Test the hook script directly
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | node hooks/my-custom-hook.mjs
```

### Mode: Debug

#### 1. Identify the Problem

Common hook issues:

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Hook not firing | Wrong event name, missing from settings | Check settings.json registration |
| Hook blocks everything | Exit code 2 returned incorrectly | Check exit code logic |
| Hook output not visible | Writing to stderr instead of stdout | Use `console.log` not `console.error` |
| Hook timeout | Script takes >10s | Optimize or increase timeout |
| Hook crashes session | Unhandled exception | Add try/catch, check node version |
| Hook runs twice | Registered in both project and user settings | Remove duplicate |
| Matcher not working | Regex/glob pattern incorrect | Test matcher pattern separately |

#### 2. Debug Steps

```bash
# 1. Verify hook is registered
cat .claude/settings.json | jq '.hooks'

# 2. Test hook script standalone
echo '{}' | node hooks/my-hook.mjs
echo $?  # Check exit code

# 3. Check for syntax errors
node --check hooks/my-hook.mjs

# 4. Check environment variables the hook expects
env | grep CLAUDE_
```

#### 3. Enable Hook Logging

```bash
# Add debug output to stderr (visible in logs, not injected into Claude)
console.error('[DEBUG] Hook input:', JSON.stringify(data));
console.error('[DEBUG] Processing...');
```

### Mode: Explain

Explain how hooks work with examples:

**How hooks inject context:**
- Hook stdout → injected as `<system-reminder>` tag in Claude's conversation
- This is how OMC hooks provide real-time context (project type, active modes, etc.)
- Claude sees these as system instructions and follows them

**Hook execution order:**
- Hooks for the same event run sequentially in array order
- A blocking hook (exit 2) prevents subsequent hooks from running
- Timeout default is 10s — keep hooks fast

**Common patterns:**
1. **Keyword detection** — UserPromptSubmit hook scans for keywords, injects skill content
2. **Tool enforcement** — PreToolUse hook validates tool usage against policies
3. **State persistence** — PreCompact/SessionEnd hooks save important state
4. **Persistence loops** — Stop hook re-injects context to keep autonomous modes running

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **List complete** | Display formatted hook table |
| **Hook created** | Script written, settings updated, test passed |
| **Debug resolved** | Issue identified and fixed |
| **Explanation delivered** | Hook system explained with examples |

## Notes

- **OMC hooks are managed separately**: OMC's hooks are in `hooks/hooks.json` and loaded by the plugin. Don't modify these directly — use `/oh-my-claudecode:omc-setup` instead.
- **User hooks go in settings.json**: Custom hooks should be added to `.claude/settings.json` (project) or `~/.claude/settings.json` (user).
- **Performance matters**: Hooks run on every matching event. Keep them fast (<1s ideally).
- **Security**: Hook scripts can execute arbitrary code. Only add hooks from trusted sources.
- **Kill switch**: Set `OMC_SKIP_HOOKS=hookname1,hookname2` env var to disable specific hooks.

---

Begin hooks guide now. Parse the mode and show the requested information or start the wizard.
