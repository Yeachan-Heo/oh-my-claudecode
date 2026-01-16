---
description: Configure Sisyphus in local project (.claude/CLAUDE.md)
---

$ARGUMENTS

## Task: Configure Sisyphus Default Mode (Project-Scoped)

**CRITICAL**: This skill ALWAYS downloads fresh CLAUDE.md from GitHub to your local project. DO NOT use the Write tool - use bash curl exclusively.

### Step 1: Create Local .claude Directory

Ensure the local project has a .claude directory:

```bash
# Create .claude directory in current project
mkdir -p .claude && echo "✅ .claude directory created" || echo "❌ Failed to create .claude directory"
```

### Step 2: Download Fresh CLAUDE.md (MANDATORY)

Execute this bash command to download fresh CLAUDE.md to local project config:

```bash
# Download fresh CLAUDE.md to project-local .claude/
curl -fsSL "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claude-sisyphus/main/docs/CLAUDE.md" -o .claude/CLAUDE.md && \
echo "✅ CLAUDE.md downloaded successfully to .claude/CLAUDE.md" || \
echo "❌ Failed to download CLAUDE.md"
```

**MANDATORY**: Always run this command. Do NOT skip. Do NOT use Write tool.

**FALLBACK** if curl fails:
Tell user to manually download from:
https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claude-sisyphus/main/docs/CLAUDE.md

### Step 3: Verify Plugin Installation

The oh-my-claude-sisyphus plugin provides all hooks automatically via the plugin system. Verify the plugin is enabled:

```bash
grep -q "oh-my-claude-sisyphus" ~/.claude/settings.json && echo "Plugin enabled" || echo "Plugin NOT enabled"
```

If plugin is not enabled, instruct user:
> Run: `claude /install-plugin oh-my-claude-sisyphus` to enable the plugin.

### Step 4: Confirm Success

After completing all steps, report:

✅ **Sisyphus Project Configuration Complete**
- CLAUDE.md: Updated with latest configuration from GitHub at ./.claude/CLAUDE.md
- Scope: **PROJECT** - applies only to this project
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 19+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

**Note**: This configuration is project-specific and won't affect other projects or global settings.

---

## 🔄 Keeping Up to Date

After installing oh-my-claude-sisyphus updates (via npm or plugin update), run `/sisyphus-default` again in your project to get the latest CLAUDE.md configuration. This ensures you have the newest features and agent configurations.

---

## 🌍 Global vs Project Configuration

- **`/sisyphus-default`** (this command): Creates `./.claude/CLAUDE.md` in your current project
- **`/sisyphus-default-global`**: Creates `~/.claude/CLAUDE.md` for all projects

Project-scoped configuration takes precedence over global configuration.
