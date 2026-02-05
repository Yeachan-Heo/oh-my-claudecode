---
name: doctor
description: Diagnose and fix oh-my-claudecode installation issues
---

# Doctor Skill

## Task: Run Installation Diagnostics

You are the OMC Doctor - diagnose and fix installation issues.

### Step 1: Check Plugin Version

```bash
# Get installed version
INSTALLED=$(ls ~/.claude/plugins/cache/omc/oh-my-claudecode/ 2>/dev/null | sort -V | tail -1)
echo "Installed: $INSTALLED"

# Get latest from npm
LATEST=$(npm view oh-my-claude-sisyphus version 2>/dev/null)
echo "Latest: $LATEST"
```

**Diagnosis**:
- If no version installed: CRITICAL - plugin not installed
- If INSTALLED != LATEST: WARN - outdated plugin
- If multiple versions exist: WARN - stale cache

### Step 2: Check for Legacy Hooks in settings.json

Read `~/.claude/settings.json` and check if there's a `"hooks"` key with entries like:
- `bash $HOME/.claude/hooks/keyword-detector.sh`
- `bash $HOME/.claude/hooks/persistent-mode.sh`
- `bash $HOME/.claude/hooks/session-start.sh`

**Diagnosis**:
- If found: CRITICAL - legacy hooks causing duplicates

### Step 3: Check for Legacy Bash Hook Scripts

```bash
ls -la ~/.claude/hooks/*.sh 2>/dev/null
```

**Diagnosis**:
- If `keyword-detector.sh`, `persistent-mode.sh`, `session-start.sh`, or `stop-continuation.sh` exist: WARN - legacy scripts (can cause confusion)

### Step 4: Check CLAUDE.md

```bash
# Check if CLAUDE.md exists
ls -la ~/.claude/CLAUDE.md 2>/dev/null
```

```bash
# Check for OMC marker
grep -c "oh-my-claudecode Multi-Agent System" ~/.claude/CLAUDE.md 2>/dev/null
```

If the grep count is 0 or errors: "Missing OMC config". If 1 or more: "Has OMC config".

**Diagnosis**:
- If missing: CRITICAL - CLAUDE.md not configured
- If missing OMC marker: WARN - outdated CLAUDE.md

### Step 5: Check for Stale Plugin Cache

```bash
# Count versions in cache
ls ~/.claude/plugins/cache/omc/oh-my-claudecode/ 2>/dev/null | wc -l
```

**Diagnosis**:
- If > 1 version: WARN - multiple cached versions (cleanup recommended)

### Step 5b: Check Version Pinning (Important for Upgrades)

Check the installed_plugins.json to see pinned version:
```bash
cat ~/.claude/installed_plugins.json 2>/dev/null
```

Or read the file directly and look for `oh-my-claudecode` entry.

**Diagnosis**:
- Compare pinned version with latest from npm (Step 1)
- If pinned version != latest: WARN - version is pinned to old version
- This is why cache clearing doesn't upgrade - the version is pinned!

### Step 6: Check for Legacy Curl-Installed Content

Check for legacy agents, commands, and skills installed via curl (before plugin system):

```bash
# Check for legacy agents directory
ls -la ~/.claude/agents/ 2>/dev/null

# Check for legacy commands directory
ls -la ~/.claude/commands/ 2>/dev/null

# Check for legacy skills directory
ls -la ~/.claude/skills/ 2>/dev/null
```

**Diagnosis**:
- If `~/.claude/agents/` exists with oh-my-claudecode-related files: WARN - legacy agents (now provided by plugin)
- If `~/.claude/commands/` exists with oh-my-claudecode-related files: WARN - legacy commands (now provided by plugin)
- If `~/.claude/skills/` exists with oh-my-claudecode-related files: WARN - legacy skills (now provided by plugin)

Look for files like:
- `architect.md`, `researcher.md`, `explore.md`, `executor.md`, etc. in agents/
- `ultrawork.md`, `deepsearch.md`, etc. in commands/
- Any oh-my-claudecode-related `.md` files in skills/

---

## Report Format

After running all checks, output a report:

```
## OMC Doctor Report

### Summary
[HEALTHY / ISSUES FOUND]

### Checks

| Check | Status | Details |
|-------|--------|---------|
| Plugin Version | OK/WARN/CRITICAL | ... |
| Legacy Hooks (settings.json) | OK/CRITICAL | ... |
| Legacy Scripts (~/.claude/hooks/) | OK/WARN | ... |
| CLAUDE.md | OK/WARN/CRITICAL | ... |
| Plugin Cache | OK/WARN | ... |
| Legacy Agents (~/.claude/agents/) | OK/WARN | ... |
| Legacy Commands (~/.claude/commands/) | OK/WARN | ... |
| Legacy Skills (~/.claude/skills/) | OK/WARN | ... |

### Issues Found
1. [Issue description]
2. [Issue description]

### Recommended Fixes
[List fixes based on issues]
```

---

## Auto-Fix (if user confirms)

If issues found, ask user: "Would you like me to fix these issues automatically?"

If yes, apply fixes:

### Fix: Legacy Hooks in settings.json
Remove the `"hooks"` section from `~/.claude/settings.json` (keep other settings intact)

### Fix: Legacy Bash Scripts
```bash
rm -f ~/.claude/hooks/keyword-detector.sh
rm -f ~/.claude/hooks/persistent-mode.sh
rm -f ~/.claude/hooks/session-start.sh
rm -f ~/.claude/hooks/stop-continuation.sh
```

### Fix: Outdated Plugin

**IMPORTANT**: Simply clearing the cache does NOT work because Claude Code pins the version in `installed_plugins.json`. Use the proper upgrade method:

**Recommended Fix (use Claude Code's plugin system):**
Tell the user to run:
```
/plugin install oh-my-claudecode
```

This properly updates both the cache AND the version pin.

**Alternative (manual):**
1. First, tell user to check their installed plugins config:
```bash
cat ~/.claude/installed_plugins.json 2>/dev/null
```

2. The version is pinned there. To upgrade, user should use `/plugin install oh-my-claudecode` which will update the pin.

**DO NOT** just clear the cache - it will re-download the old pinned version:
```bash
# This alone does NOT work - version is pinned!
# rm -rf ~/.claude/plugins/cache/omc/oh-my-claudecode
```

### Fix: Stale Cache (multiple versions)

List all versions, then remove all except the latest:
```bash
ls ~/.claude/plugins/cache/omc/oh-my-claudecode/ 2>/dev/null | sort -V
```

Then remove old versions individually (keep the latest):
```bash
rm -rf ~/.claude/plugins/cache/omc/oh-my-claudecode/OLD_VERSION
```

### Fix: Missing/Outdated CLAUDE.md
Fetch latest from GitHub and write to `~/.claude/CLAUDE.md`:
```
WebFetch(url: "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md", prompt: "Return the complete raw markdown content exactly as-is")
```

### Fix: Legacy Curl-Installed Content

Remove legacy agents, commands, and skills directories (now provided by plugin):

```bash
# Backup first (optional - ask user)
# mv ~/.claude/agents ~/.claude/agents.bak
# mv ~/.claude/commands ~/.claude/commands.bak
# mv ~/.claude/skills ~/.claude/skills.bak

# Or remove directly
rm -rf ~/.claude/agents
rm -rf ~/.claude/commands
rm -rf ~/.claude/skills
```

**Note**: Only remove if these contain oh-my-claudecode-related files. If user has custom agents/commands/skills, warn them and ask before removing.

### Fix: Persistent HUD After Disabling Plugin

If user reports that the HUD statusline persists after disabling the plugin, clean up manually:

1. Remove the HUD script:
```bash
rm -f ~/.claude/hud/omc-hud.mjs
```

2. Remove statusLine from settings.json:
Read `~/.claude/settings.json`, find the `"statusLine"` key, and remove it if it contains `omc-hud`.

Example (use Edit tool to modify settings.json):
- Find: `"statusLine": { "type": "command", "command": "node /path/to/omc-hud.mjs" }`
- Remove the entire `statusLine` object

3. Optionally remove omcHud config:
Find and remove the `"omcHud"` key from settings.json if present.

**Note**: After cleanup, restart Claude Code for changes to take effect.

---

## Post-Fix

After applying fixes, inform user:
> Fixes applied. **Restart Claude Code** for changes to take effect.
