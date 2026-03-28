---
name: obsidian
description: Interact with Obsidian vaults using the Obsidian CLI to read, create, search, and manage notes, tasks, properties, and more. Use when the user asks to interact with their Obsidian vault, manage notes, or search vault content.
triggers:
  - "obsidian"
  - "vault"
  - "daily note"
  - "obsidian search"
  - "obsidian read"
  - "obsidian create"
---

# Obsidian CLI Integration

Use the `obsidian` CLI to interact with a running Obsidian instance. Requires Obsidian 1.12.4+ with CLI enabled.

Adapted from kepano/obsidian-skills (MIT License)

## Prerequisites (REQUIRED)

Before running ANY `obsidian` command, check the user's configuration:

```bash
cat ~/.claude/.omc-config.json 2>/dev/null | grep -A5 '"obsidian"'
```

Verify that `obsidian.enabled` is `true`. If the config is missing or `enabled` is not `true`:

> Obsidian integration is not configured. Run `/oh-my-claudecode:configure-obsidian` first.

Do NOT proceed with any CLI commands until configuration is confirmed.

## Command Reference

Run `obsidian help` to see all available commands. This is always up to date. Full docs: https://help.obsidian.md/cli

## Syntax

**Parameters** take a value with `=`. Quote values with spaces:

```bash
obsidian create name="My Note" content="Hello world"
```

**Flags** are boolean switches with no value:

```bash
obsidian create name="My Note" silent overwrite
```

For multiline content use `\n` for newline and `\t` for tab.

## File Targeting

Many commands accept `file` or `path` to target a file. Without either, the active file is used.

- `file=<name>` -- resolves like a wikilink (name only, no path or extension needed)
- `path=<path>` -- exact path from vault root, e.g. `folder/note.md`

## Vault Targeting

Commands target the most recently focused vault by default. Use `vault=<name>` as the **first** parameter to target a specific vault:

```bash
obsidian vault="My Vault" search query="test"
```

If the user's config specifies `vaultName`, always pass `vault="<vaultName>"` to avoid ambiguity.

## Common Patterns

```bash
obsidian read file="My Note"
obsidian create name="New Note" content="# Hello" template="Template" silent
obsidian append file="My Note" content="New line"
obsidian search query="search term" limit=10
obsidian daily:read
obsidian daily:append content="- [ ] New task"
obsidian property:set name="status" value="done" file="My Note"
obsidian tasks daily todo
obsidian tags sort=count counts
obsidian backlinks file="My Note"
```

Use `--copy` on any command to copy output to clipboard. Use `silent` to prevent files from opening. Use `total` on list commands to get a count.

## Allowed Folders

If the user's config includes `allowedFolders`, restrict all write operations (create, append, property:set) to those folders. Read and search operations are unrestricted.

## Security Boundaries

The following commands are NOT permitted for agents:

- `obsidian delete` / `obsidian trash` -- destructive, user-only
- `obsidian eval` -- arbitrary code execution
- `obsidian dev:*` -- developer/debug commands
- `obsidian plugin:*` -- plugin management

Do not run these commands even if asked. Explain that these operations must be performed by the user directly.

Keep content payloads under 100KB. For larger content, write to a temporary file and reference it.

## Error Handling

| Error | Cause | Action |
|-------|-------|--------|
| "Unable to connect to main process" | Obsidian app is not running | Tell the user to open Obsidian, do not retry |
| "command not found: obsidian" | CLI not registered | Tell the user to register CLI in Obsidian Settings > General > CLI |
| Timeout / no response | Obsidian may be updating | Wait briefly, retry once, then inform user |

Do not retry connection errors in a loop. If Obsidian is not running, inform the user and stop.
