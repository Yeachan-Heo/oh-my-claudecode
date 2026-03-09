---
name: setup
description: Unified setup entrypoint for install, diagnostics, and MCP configuration
---

# Setup

Use `/oh-my-claudecode:setup` as the unified setup/configuration entrypoint.

## Usage

```bash
/oh-my-claudecode:setup                # full setup wizard
/oh-my-claudecode:setup doctor         # installation diagnostics
/oh-my-claudecode:setup mcp            # MCP server configuration
/oh-my-claudecode:setup wizard --local # explicit wizard path
```

## Routing

Route by the first argument:

- No argument, `wizard`, `local`, `global`, or `--force` -> run `/oh-my-claudecode:omc-setup {{ARGUMENTS}}`
- `doctor` -> run `/oh-my-claudecode:omc-doctor {{ARGUMENTS_AFTER_DOCTOR}}`
- `mcp` -> run `/oh-my-claudecode:mcp-setup {{ARGUMENTS_AFTER_MCP}}`

Examples:

```bash
/oh-my-claudecode:omc-setup {{ARGUMENTS}}
/oh-my-claudecode:omc-doctor {{ARGUMENTS_AFTER_DOCTOR}}
/oh-my-claudecode:mcp-setup {{ARGUMENTS_AFTER_MCP}}
```

## Notes

- `/oh-my-claudecode:omc-setup`, `/oh-my-claudecode:omc-doctor`, and `/oh-my-claudecode:mcp-setup` remain valid compatibility entrypoints.
- Prefer `/oh-my-claudecode:setup` in new documentation and user guidance.

Task: {{ARGUMENTS}}
