# Phase 1: Install CLAUDE.md

## Determine Configuration Target

If `--local` flag was passed, set `CONFIG_TARGET=local`.
If `--global` flag was passed, set `CONFIG_TARGET=global`.

Otherwise (initial setup wizard), use AskUserQuestion to prompt:

**Question:** "Where should I configure oh-my-claudecode?"

**Options:**
1. **Local (this project)** - Creates `.claude/CLAUDE.md` in current project directory. Best for project-specific configurations.
2. **Global (all projects)** - Creates `~/.claude/CLAUDE.md` for all Claude Code sessions. Best for consistent behavior everywhere.

Set `CONFIG_TARGET` to `local` or `global` based on user's choice.

If `CONFIG_TARGET=global` and `~/.claude/CLAUDE.md` already exists without OMC markers, ask a second explicit question before running setup:

**Question:** "Global setup will change your base Claude config. Which behavior do you want?"

**Options (default first):**
1. **Overwrite base CLAUDE.md (Recommended)** - plain `claude` and `omc` both use OMC globally.
2. **Keep base CLAUDE.md; use OMC only through `omc`** - preserve the user's base file, install OMC into `CLAUDE-omc.md`, and let `omc` force-load that companion config at launch.

Set `GLOBAL_INSTALL_STYLE=overwrite` or `preserve` based on the user's choice. If you did not ask this question, default `GLOBAL_INSTALL_STYLE=overwrite`.

## Install CLAUDE.md Through the Plugin-Local Coordinator

**MANDATORY**: Always run this command. Do NOT skip. Do NOT use the Write tool. The script is the sole plugin-cache resolver and invokes the selected plugin root's `bridge/claude-md-coordinator.cjs` with one versioned JSON request. It fails closed when required plugin assets, the canonical-source handshake, coordinator response validation, or coordinator exit/`ok` agreement fails.

```bash
bash "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-claude-md.sh" <CONFIG_TARGET> [GLOBAL_INSTALL_STYLE]
```

Replace `<CONFIG_TARGET>` with `local` or `global`. For local installs, omit the optional style argument. For global installs, pass `overwrite` or `preserve` when you know the user's choice; otherwise let the script default to `overwrite`.

The coordinator exclusively performs all `CLAUDE.md`, `CLAUDE-omc.md`, managed-import, orphan-cleanup, backup, and rollback mutations. Do **not** hand-write, summarize, partially reconstruct, download, or repair either configuration file. It reports only the exact coordinator-created backup, failure, and rollback paths.

After a successful local or global-overwrite install, verify the target file contains both markers. In global preserve mode, verify `CLAUDE-omc.md` contains both markers and the base `CLAUDE.md` contains exactly one managed import block. Stop and report a coordinator failure; never attempt a shell, downloaded-source, or fallback mutation.

For `local` installs inside a git repository, the script also seeds `.git/info/exclude` with an OMC block that re-includes `.omc/`, ignores local `.omc/*` artifacts by default, and preserves `.omc/skills/` for project skills you intend to commit.

**Note**: Setup never downloads or merges CLAUDE.md in the shell. It uses only the handshake-verified canonical source bundled with the complete active plugin root.

**Note**: Preserve mode installs OMC into a companion `CLAUDE-omc.md` with a small managed import block, and `omc` launch force-loads that companion config without changing plain `claude`.

## Report Success

If `CONFIG_TARGET` is `local`:
```
OMC Project Configuration Complete
- CLAUDE.md: Updated by the active plugin's coordinator at ./.claude/CLAUDE.md
- Git excludes: Added local `.omc/*` ignore rules to `.git/info/exclude` (keeps `.omc/skills/` trackable for committed project skills)
- Backup: Coordinator reported a byte-identical backup only when the previous target required mutation
- Scope: PROJECT - applies only to this project
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 28+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

Note: This configuration is project-specific and won't affect other projects or global settings.
```

If `CONFIG_TARGET` is `global`:
```
OMC Global Configuration Complete
- CLAUDE.md: Updated at ~/.claude/CLAUDE.md, or preserved with explicit preserve mode
- Companion: May install ~/.claude/CLAUDE-omc.md when preserve mode is chosen
- Backup: Coordinator reported byte-identical backups only for global files that required mutation
- Scope: GLOBAL - applies to all Claude Code sessions
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 28+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

Note: Hooks are now managed by the plugin system automatically. No manual hook installation required.
```

## Save Progress

```bash
bash "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.sh" save 2 <CONFIG_TARGET>
```

## Early Exit for Flag Mode

If `--local` or `--global` flag was used, clear state and **STOP HERE**:
```bash
bash "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.sh" clear
```
Do not continue to Phase 2 or other phases.
