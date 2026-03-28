---
name: configure-obsidian
description: Configure Obsidian vault integration for persistent knowledge management
triggers:
  - "configure obsidian"
  - "setup obsidian"
  - "obsidian integration"
  - "obsidian vault"
---

# Configure Obsidian Integration

Set up Obsidian vault integration so OMC agents can read, write, and search notes in your Obsidian vault via the CLI. Requires Obsidian 1.12.4+ with CLI enabled.

## How This Skill Works

This is an interactive configuration skill. Walk the user through setup by asking questions with AskUserQuestion. The result is stored in `~/.claude/.omc-config.json`.

## Step 1: Detect Obsidian CLI

```bash
# Check if obsidian CLI is available
if command -v obsidian &> /dev/null; then
  VERSION=$(obsidian version 2>&1 | head -1)
  echo "OBSIDIAN_DETECTED=true"
  echo "OBSIDIAN_VERSION=$VERSION"
else
  echo "OBSIDIAN_DETECTED=false"
fi
```

If Obsidian CLI is not detected, inform the user:

```
Obsidian CLI not found. To enable it:
1. Install Obsidian from https://obsidian.md (version 1.12.4+)
2. Open Obsidian → Settings → General → Command Line Interface
3. Click "Register CLI"
4. Restart your terminal
```

Then stop -- do not proceed without CLI.

## Step 2: Discover Vaults

```bash
# List available vaults from Obsidian config
obsidian vault 2>&1
```

Parse the output to get vault names and paths. Present them to the user:

**Question via AskUserQuestion:** "Which vault should OMC use for knowledge storage?"

Show discovered vaults as numbered options. If the user has multiple vaults, recommend using a dedicated "Dev" vault to keep personal notes separate.

## Step 3: Validate Vault Access

Run a connectivity test:

```bash
# Test read access
obsidian files total vault="<selected-vault>" 2>&1

# Test search
obsidian search query="test" limit=1 vault="<selected-vault>" 2>&1
```

If tests fail, report the error and suggest:
- Ensure Obsidian app is running
- Check that the vault is open in Obsidian
- Try restarting Obsidian

## Step 4: Configure Allowed Folders (Optional)

**Question via AskUserQuestion:** "Should OMC agents be restricted to specific folders in your vault? (Recommended: yes)"

If yes, ask which folders. Suggest defaults:
- `OMC/` -- Agent-generated content
- `Projects/` -- Project-specific notes
- `Research/` -- Analysis and research reports

## Step 5: Save Configuration

Write to `~/.claude/.omc-config.json`:

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"

# Read existing config or create empty
if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING="{}"
fi

# Merge obsidian config
echo "$EXISTING" | jq --arg vaultPath "<vault-path>" --arg vaultName "<vault-name>" '. + {
  "obsidian": {
    "enabled": true,
    "vaultPath": $vaultPath,
    "vaultName": $vaultName,
    "allowedFolders": ["OMC/", "Projects/", "Research/"]
  }
}' > "$CONFIG_FILE"
```

### Configuration Resolution Order

The runtime resolves vault configuration in this order:
1. `OMC_OBSIDIAN_VAULT` / `OMC_OBSIDIAN_VAULT_NAME` env vars (highest priority)
2. `~/.claude/.omc-config.json` obsidian section (`vaultPath`, `vaultName`)
3. Auto-discovery from `~/Library/Application Support/obsidian/obsidian.json` (prefers open vault)

### Disabling

To disable Obsidian integration:
1. Set `enabled: false` in `~/.claude/.omc-config.json`
2. (Optional hardening) Add deny patterns to `settings.json` if desired:
   ```json
   { "permissions": { "deny": ["Bash(obsidian *)"] } }
   ```

## Step 6: Test Integration

Run a full round-trip test:

```bash
# Create a test note (uses path to respect allowedFolders)
obsidian create name="OMC-Integration-Test" path="OMC/" content="# Test Note\n\nCreated by OMC configure-obsidian skill." vault="<vault>"

# Read it back
obsidian read file="OMC/OMC-Integration-Test.md" vault="<vault>"

# Search for it
obsidian search query="OMC-Integration-Test" vault="<vault>"

# Clean up (manual -- delete is not exposed to agents for safety)
# Delete the test note via Obsidian UI or CLI directly
```

If all steps succeed, show:

```
Obsidian integration configured successfully!

Vault: <vault-name> (<vault-path>)
Version: <version>

Obsidian CLI is ready for use via the obsidian skill.

Environment variable alternative (add to ~/.zshrc):
  export OMC_OBSIDIAN_VAULT="<vault-path>"
```

## Step 7: Install Content Authorship Skill (Optional)

**Ask via AskUserQuestion:** "Would you like to also enable the obsidian-markdown skill? It teaches agents proper wikilink syntax, callout formatting, and Obsidian-specific markdown. (Recommended: yes)"

The obsidian-markdown skill is bundled with OMC and provides knowledge of:
- Wikilinks `[[Note Name]]` for internal references
- Callouts `> [!info]` for highlighted information
- Properties (YAML frontmatter) with `tags`, `created`, `status`
- Embeds, comments, highlights, and other Obsidian extensions

If the user declines, note:
```
Skipped. The obsidian-markdown skill is always available via:
  /oh-my-claudecode:obsidian-markdown
See: https://github.com/kepano/obsidian-skills
```

## Step 8: Show Quick Start Guide

After successful configuration, display:

```markdown
## Quick Start

### Search your vault
obsidian search query="architecture" vault="<vault>"

### Create notes from agents
obsidian create name="Research Report" content="..." vault="<vault>" silent

### Daily notes
obsidian daily:append content="- Completed feature X" vault="<vault>"

### Write Obsidian-native content
Agents will use:
- Wikilinks `[[Note Name]]` for internal references (not markdown links)
- Callouts `> [!info]` for highlighted information
- Properties (YAML frontmatter) with `tags`, `created`, `status`
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Unable to connect to main process" | Restart Obsidian app, then retry |
| CLI not found after install | Run `obsidian` once to register, restart terminal |
| Empty search results | Ensure vault has notes and Obsidian is running |
| Permission denied | Check vault path permissions |
| Timeout errors | Obsidian may be updating; wait and retry |
