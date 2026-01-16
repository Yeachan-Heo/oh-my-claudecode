---
description: Configure Sisyphus globally in ~/.claude/CLAUDE.md
---

$ARGUMENTS

## Task: Configure Sisyphus Default Mode (Global)

**CRITICAL**: This skill ALWAYS downloads fresh CLAUDE.md from GitHub to your global config. DO NOT use the Write tool - use bash curl exclusively.

### Step 1: Download Fresh CLAUDE.md (MANDATORY)

Execute this bash command to erase and download fresh CLAUDE.md to global config:

```bash
# Remove existing CLAUDE.md and download fresh from GitHub
rm -f ~/.claude/CLAUDE.md && \
curl -fsSL "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claude-sisyphus/main/docs/CLAUDE.md" -o ~/.claude/CLAUDE.md && \
echo "✅ CLAUDE.md downloaded successfully to ~/.claude/CLAUDE.md" || \
echo "❌ Failed to download CLAUDE.md"
```

**MANDATORY**: Always run this command. Do NOT skip. Do NOT use Write tool.

**FALLBACK** if curl fails:
Tell user to manually download from:
https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claude-sisyphus/main/docs/CLAUDE.md

### Step 2: Clean Up Legacy Hooks (if present)

Check if old manual hooks exist and remove them to prevent duplicates:

```bash
# Remove legacy bash hook scripts (now handled by plugin system)
rm -f ~/.claude/hooks/keyword-detector.sh
rm -f ~/.claude/hooks/stop-continuation.sh
rm -f ~/.claude/hooks/persistent-mode.sh
rm -f ~/.claude/hooks/session-start.sh
```

Check `~/.claude/settings.json` for manual hook entries. If the "hooks" key exists with UserPromptSubmit, Stop, or SessionStart entries pointing to bash scripts, inform the user:

> **Note**: Found legacy hooks in settings.json. These should be removed since the plugin now provides hooks automatically. Remove the "hooks" section from ~/.claude/settings.json to prevent duplicate hook execution.

### Step 3: Verify Plugin Installation

The oh-my-claude-sisyphus plugin provides all hooks automatically via the plugin system. Verify the plugin is enabled:

```bash
grep -q "oh-my-claude-sisyphus" ~/.claude/settings.json && echo "Plugin enabled" || echo "Plugin NOT enabled"
```

If plugin is not enabled, instruct user:
> Run: `claude /install-plugin oh-my-claude-sisyphus` to enable the plugin.

### Step 4: Confirm Success

After completing all steps, report:

✅ **Sisyphus Global Configuration Complete**
- CLAUDE.md: Updated with latest configuration from GitHub at ~/.claude/CLAUDE.md
- Scope: **GLOBAL** - applies to all Claude Code sessions
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 19+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

**Note**: Hooks are now managed by the plugin system automatically. No manual hook installation required.

---

## 🔄 Keeping Up to Date

After installing oh-my-claude-sisyphus updates (via npm or plugin update), run `/sisyphus-default-global` again to get the latest CLAUDE.md configuration. This ensures you have the newest features and agent configurations.
