# Migration Guide: v2.x to v3.0 (oh-my-claudecode)

This guide helps you migrate from `oh-my-claude-sisyphus` v2.x to `oh-my-claudecode` v3.0.

## Package Rename

The package has been renamed to better reflect its purpose and improve discoverability.

- **Old**: `oh-my-claude-sisyphus`
- **New**: `oh-my-claudecode`

### NPM Commands

```bash
# Old
npm install -g oh-my-claude-sisyphus

# New
npm install -g oh-my-claudecode
```

## Agent Name Mapping

All agent names have been updated from Greek mythology references to intuitive, descriptive names:

| Old Name (Greek) | New Name (Intuitive) |
|------------------|----------------------|
| prometheus | planner |
| momus | critic |
| oracle | architect |
| metis | analyst |
| mnemosyne | learner |
| sisyphus-junior | executor |
| orchestrator-sisyphus | coordinator |
| librarian | researcher |
| frontend-engineer | designer |
| document-writer | writer |
| multimodal-looker | vision |
| explore | explore (unchanged) |
| qa-tester | qa-tester (unchanged) |

## Directory Migration

Directory structures have been renamed for consistency with the new package name:

### Local Project Directories
- **Old**: `.sisyphus/`
- **New**: `.omc/`

### Global Directories
- **Old**: `~/.sisyphus/`
- **New**: `~/.omc/`

### Skills Directory
- **Old**: `~/.claude/skills/sisyphus-learned/`
- **New**: `~/.claude/skills/omc-learned/`

### Config Files
- **Old**: `~/.claude/sisyphus/mnemosyne.json`
- **New**: `~/.claude/omc/learner.json`

## Environment Variables

All environment variables have been renamed from `SISYPHUS_*` to `OMC_*`:

| Old | New |
|-----|-----|
| SISYPHUS_USE_NODE_HOOKS | OMC_USE_NODE_HOOKS |
| SISYPHUS_USE_BASH_HOOKS | OMC_USE_BASH_HOOKS |
| SISYPHUS_PARALLEL_EXECUTION | OMC_PARALLEL_EXECUTION |
| SISYPHUS_LSP_TOOLS | OMC_LSP_TOOLS |
| SISYPHUS_MAX_BACKGROUND_TASKS | OMC_MAX_BACKGROUND_TASKS |
| SISYPHUS_ROUTING_ENABLED | OMC_ROUTING_ENABLED |
| SISYPHUS_ROUTING_DEFAULT_TIER | OMC_ROUTING_DEFAULT_TIER |
| SISYPHUS_ESCALATION_ENABLED | OMC_ESCALATION_ENABLED |
| SISYPHUS_DEBUG | OMC_DEBUG |

## Command Changes

Slash commands have been updated to use new naming:

| Old Command | New Command |
|-------------|-------------|
| /sisyphus | /orchestrate |
| /sisyphus-default | /omc-default |
| /sisyphus-default-global | /omc-default-global |
| /prometheus | /planner |
| /mnemosyne | /learner |

## Feature Flag Changes

Configuration keys have been updated:

| Old | New |
|-----|-----|
| mnemosyne.enabled | learner.enabled |

## Migration Steps for Existing Users

Follow these steps to migrate your existing setup:

### 1. Uninstall Old Package

```bash
npm uninstall -g oh-my-claude-sisyphus
```

### 2. Install New Package

```bash
npm install -g oh-my-claudecode
```

### 3. Rename Local Project Directories

If you have existing projects using the old directory structure:

```bash
# In each project directory
mv .sisyphus .omc
```

### 4. Rename Global Directories

```bash
# Global configuration directory
mv ~/.sisyphus ~/.omc

# Skills directory
mv ~/.claude/skills/sisyphus-learned ~/.claude/skills/omc-learned

# Config directory
mv ~/.claude/sisyphus ~/.claude/omc
```

### 5. Update Environment Variables

Update your shell configuration files (`.bashrc`, `.zshrc`, etc.):

```bash
# Replace all SISYPHUS_* variables with OMC_*
# Example:
# OLD: export SISYPHUS_ROUTING_ENABLED=true
# NEW: export OMC_ROUTING_ENABLED=true
```

### 6. Update Scripts and Configurations

Search for and update any references to:
- Package name: `oh-my-claude-sisyphus` → `oh-my-claudecode`
- Agent names: Use the mapping table above
- Commands: Use the new slash commands
- Directory paths: Update `.sisyphus` → `.omc`

### 7. Update Configuration Files

If you have custom configuration files referencing agent names or feature flags, update them according to the mappings above.

## Verification

After migration, verify your setup:

1. **Check installation**:
   ```bash
   npm list -g oh-my-claudecode
   ```

2. **Verify directories exist**:
   ```bash
   ls -la .omc/  # In project directory
   ls -la ~/.omc/  # Global directory
   ```

3. **Test a simple command**:
   Run `/help` in Claude Code to ensure the plugin is loaded correctly.

## Backward Compatibility

**Note**: v3.0 does not maintain backward compatibility with v2.x naming. You must complete the migration steps above for the new version to work correctly.

## Need Help?

If you encounter issues during migration:
- Check the [GitHub Issues](https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/issues)
- Review the [Documentation](https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/tree/main/docs)
- Run `/doctor` to diagnose common issues
