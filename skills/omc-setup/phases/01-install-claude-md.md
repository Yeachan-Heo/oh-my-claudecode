# Phase 1: Install CLAUDE.md

## Determine Configuration Target

If `--local` flag was passed, set `CONFIG_TARGET=local`.
If `--global` flag was passed, set `CONFIG_TARGET=global`.

Otherwise (initial setup wizard), use AskUserQuestion to prompt:

**Question:** "Where should I configure oh-my-claudecode?"

**Options:**
1. **Local (this project)** - Creates `.claude/CLAUDE.md` in current project directory. Best for project-specific configurations.
2. **Global (all projects)** - Creates `CONFIG_DIR/CLAUDE.md` for all Claude Code sessions. Best for consistent behavior everywhere.

Set `CONFIG_TARGET` to `local` or `global` based on user's choice.

If `CONFIG_TARGET=global` and `CONFIG_DIR/CLAUDE.md` already exists without OMC markers, ask a second explicit question before running setup:

**Question:** "Global setup will change your base Claude config. Which behavior do you want?"

**Options (default first):**
1. **Overwrite base CLAUDE.md (Recommended)** - plain `claude` and `omc` both use OMC globally.
2. **Keep base CLAUDE.md; use OMC only through `omc`** - preserve the user's base file, install OMC into `CLAUDE-omc.md`, and let `omc` force-load that companion config at launch.

Set `GLOBAL_INSTALL_STYLE=overwrite` or `preserve` based on the user's choice. If you did not ask this question, default `GLOBAL_INSTALL_STYLE=overwrite`.

## Download and Install CLAUDE.md

**MANDATORY**: Always run this command. Do NOT skip. Do NOT use the Write tool. Let the setup script choose the safest canonical source (bundled `docs/CLAUDE.md` first, GitHub fallback only if needed).

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-claude-md.sh" <CONFIG_TARGET> [GLOBAL_INSTALL_STYLE]
```

Replace `<CONFIG_TARGET>` with `local` or `global`. For local installs, omit the optional style argument. For global installs, pass `overwrite` or `preserve` when you know the user's choice; otherwise let the script default to `overwrite`.

The script must install the canonical `docs/CLAUDE.md` content and preserve the required
`<!-- OMC:START -->` / `<!-- OMC:END -->` markers. Do **not** hand-write, summarize, or
partially reconstruct CLAUDE.md.

After running the script, verify the target file contains both markers. If marker validation
fails, stop and report the failure instead of writing CLAUDE.md manually.

For `local` installs inside a git repository, the script also seeds `.git/info/exclude` with an OMC block that ignores local `.omc/*` artifacts by default while preserving `.omc/skills/` for version-controlled project skills.

**FALLBACK** if curl fails:
Tell user to manually download from:
https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md

**Note**: The downloaded CLAUDE.md includes Context Persistence instructions with `<remember>` tags for surviving conversation compaction.

**Note**: Preserve mode installs OMC into a companion `CLAUDE-omc.md` with a small managed import block, and `omc` launch force-loads that companion config without changing plain `claude`.

## Report Success

If `CONFIG_TARGET` is `local`:
```
OMC Project Configuration Complete
- CLAUDE.md: Updated with latest configuration from GitHub at ./.claude/CLAUDE.md
- Git excludes: Added local `.omc/*` ignore rules to `.git/info/exclude` (keeps `.omc/skills/` trackable)
- Backup: Previous CLAUDE.md backed up (if existed)
- Scope: PROJECT - applies only to this project
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 28+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

Note: This configuration is project-specific and won't affect other projects or global settings.
```

If `CONFIG_TARGET` is `global`:
```
OMC Global Configuration Complete
- CLAUDE.md: Updated at CONFIG_DIR/CLAUDE.md, or preserved with explicit preserve mode
- Companion: May install CONFIG_DIR/CLAUDE-omc.md when preserve mode is chosen
- Backup: Previous CLAUDE.md backed up (if existed)
- Scope: GLOBAL - applies to all Claude Code sessions
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 28+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

Note: Hooks are now managed by the plugin system automatically. No manual hook installation required.
```

## Save Progress

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-progress.sh" save 2 <CONFIG_TARGET>
```

## Early Exit for Flag Mode

If `--local` or `--global` flag was used, clear state and **STOP HERE**:
```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-progress.sh" clear
```
Do not continue to Phase 2 or other phases.
