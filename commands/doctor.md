---
description: Diagnose and fix oh-my-claude-sisyphus installation issues
---

$ARGUMENTS

## Task: Run Installation Diagnostics

You are the Sisyphus Doctor - diagnose and fix installation issues.

### Step 1: Check Plugin Version

```bash
# Get installed version
INSTALLED=$(ls ~/.claude/plugins/cache/oh-my-claude-sisyphus/oh-my-claude-sisyphus/ 2>/dev/null | sort -V | tail -1)
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

# Check for Sisyphus marker
grep -q "Sisyphus Multi-Agent System" ~/.claude/CLAUDE.md 2>/dev/null && echo "Has Sisyphus config" || echo "Missing Sisyphus config"
```

**Diagnosis**:
- If missing: CRITICAL - CLAUDE.md not configured
- If missing Sisyphus marker: WARN - outdated CLAUDE.md

### Step 5: Check for Stale Plugin Cache

```bash
# Count versions in cache
ls ~/.claude/plugins/cache/oh-my-claude-sisyphus/oh-my-claude-sisyphus/ 2>/dev/null | wc -l
```

**Diagnosis**:
- If > 1 version: WARN - multiple cached versions (cleanup recommended)

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
- If `~/.claude/agents/` exists with sisyphus-related files: WARN - legacy agents (now provided by plugin)
- If `~/.claude/commands/` exists with sisyphus-related files: WARN - legacy commands (now provided by plugin)
- If `~/.claude/skills/` exists with sisyphus-related files: WARN - legacy skills (now provided by plugin)

Look for files like:
- `oracle.md`, `librarian.md`, `explore.md`, `sisyphus-junior.md`, etc. in agents/
- `ultrawork.md`, `sisyphus-default.md`, `sisyphus-default-global.md`, `deepsearch.md`, etc. in commands/
- Any sisyphus-related `.md` files in skills/

---

## Report Format

After running all checks, output a report:

```
## Sisyphus Doctor Report

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
```bash
rm -rf ~/.claude/plugins/cache/oh-my-claude-sisyphus
echo "Plugin cache cleared. Restart Claude Code to fetch latest version."
```

### Fix: Stale Cache (multiple versions)
```bash
# Keep only latest version
cd ~/.claude/plugins/cache/oh-my-claude-sisyphus/oh-my-claude-sisyphus/
ls | sort -V | head -n -1 | xargs rm -rf
```

### Fix: Missing/Outdated CLAUDE.md
Fetch latest from GitHub and write to `~/.claude/CLAUDE.md`:
```
WebFetch(url: "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claude-sisyphus/main/docs/CLAUDE.md", prompt: "Return the complete raw markdown content exactly as-is")
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

**Note**: Only remove if these contain sisyphus-related files. If user has custom agents/commands/skills, warn them and ask before removing.

---

## Post-Fix

After applying fixes, inform user:
> Fixes applied. **Restart Claude Code** for changes to take effect.
